import React, { useState, useCallback, useRef } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Image,
  ActivityIndicator,
  Dimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as ImageManipulator from "expo-image-manipulator";
import { Colors } from "@/constants/colors";
import { useReceiptStore } from "@/store/receiptStore";
import { useAuthStore } from "@/store/authStore";
import { useSessionStore } from "@/store/sessionStore";
import { createBlankReceipt } from "@/utils/parser";
import { analyzeReceipt } from "@/utils/analyzeReceipt";
import { validateReceiptOCR } from "@/lib/receipt-validator";
import { useI18nStore } from "@/store/i18nStore";
import { ensureCreditsForNewSession, fetchFreshCredits, showNoCreditsDialog } from "@/lib/credits";
import { showDialog } from "@/lib/dialog";

const { width, height } = Dimensions.get("window");

export default function ReceiptPreviewScreen() {
  const {
    pendingImageUri,
    pendingImageBase64,
    setReceipt,
    setRawImageUri,
    setTip,
    setTipMode,
  } = useReceiptStore();
  const { profile } = useAuthStore();
  const { t } = useI18nStore();

  const [currentUri, setCurrentUri] = useState(pendingImageUri ?? "");
  const [currentBase64, setCurrentBase64] = useState(pendingImageBase64 ?? "");
  const [isRotating, setIsRotating] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const cancelledRef = useRef(false);
  // A second tap on "Scan receipt" while one is on its way does nothing.
  const analyzingRef = useRef(false);

  const handleRotate = useCallback(async (degrees: number) => {
    if (isRotating || !currentUri) return;
    setIsRotating(true);
    try {
      const result = await ImageManipulator.manipulateAsync(
        currentUri,
        [{ rotate: degrees }],
        { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG, base64: true }
      );
      setCurrentUri(result.uri);
      setCurrentBase64(`data:image/jpeg;base64,${result.base64}`);
    } catch {
      showDialog(t("error"), t("preview_rotate_error"));
    } finally {
      setIsRotating(false);
    }
  }, [currentUri, isRotating]);

  const handleAnalyze = useCallback(async () => {
    if (!currentBase64) return;
    if (analyzingRef.current) {
      console.log("[scan] scan tap ignored — one is already on its way");
      return;
    }
    analyzingRef.current = true;

    // R3: no new split at 0 credits — fresh balance; parse-receipt refuses too.
    if (profile && !(await ensureCreditsForNewSession(profile.id, t))) {
      analyzingRef.current = false;
      return;
    }

    cancelledRef.current = false;
    setRawImageUri(currentUri);
    setIsAnalyzing(true);

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("TIMEOUT")), 90_000)
    );

    try {
      const { receipt: parsed } = await Promise.race([
        // The session Start split created: the scan's credit pays it (C.3).
        analyzeReceipt(currentBase64, useSessionStore.getState().currentSession?.id),
        timeoutPromise,
      ]);

      if (cancelledRef.current) return;

      const itemCount = Object.values(parsed.categories).flat().length;
      if (itemCount === 0) {
        setIsAnalyzing(false);
        showDialog(t("scan_no_items_title"), t("scan_no_items_msg"), [
          { text: t("scan_try_again"), style: "cancel", onPress: () => router.back() },
          {
            text: t("scan_enter_manually"),
            onPress: () => { setReceipt(createBlankReceipt()); router.push("/(app)/review"); },
          },
        ]);
        return;
      }

      setReceipt(parsed);
      setTip("removed", 0, 0);
      setTipMode("equal");
      setIsAnalyzing(false);

      const validation = validateReceiptOCR(parsed);
      const target = validation.isValid && !validation.isWarning ? "/(app)/review" : "/(app)/review-receipt";
      console.log(
        `[receipt-preview] validation: isValid=${validation.isValid} isWarning=${validation.isWarning} errors=${validation.errors.length} warnings=${validation.warnings.length} -> routing to ${target}`
      );
      router.push(target);
    } catch (err) {
      if (cancelledRef.current) return;
      setIsAnalyzing(false);
      const msg = err instanceof Error ? err.message : "";

      const code = (err as { code?: string }).code;
      if (code === "NO_CREDITS") {
        showNoCreditsDialog(t);
        return;
      }
      const codeMessage =
        code === "SCAN_IN_PROGRESS" ? t("scan_err_in_progress")
          : code === "RATE_LIMITED" ? t("scan_err_rate_limited")
          : code === "IMAGE_TOO_LARGE" || code === "UNSUPPORTED_IMAGE" ? t("scan_err_image")
          : code === "SCAN_UNAVAILABLE" ? t("scan_err_unavailable")
          : null;
      if (codeMessage) {
        showDialog(t("scan_analysis_failed"), codeMessage, [
          { text: t("scan_enter_manually"), onPress: () => { setReceipt(createBlankReceipt()); router.push("/(app)/review"); } },
          { text: t("scan_try_again"), style: "cancel" },
        ]);
        return;
      }

      if (msg === "TIMEOUT") {
        showDialog(t("preview_timeout_title"), t("preview_timeout_msg"), [
          { text: t("scan_enter_manually"), onPress: () => { setReceipt(createBlankReceipt()); router.push("/(app)/review"); } },
          { text: t("scan_try_again"), style: "cancel" },
        ]);
        return;
      }
      showDialog(t("scan_analysis_failed"), `${t("scan_analysis_failed_msg")}\n\n${msg || String(err)}`, [
        { text: t("scan_enter_manually"), onPress: () => { setReceipt(createBlankReceipt()); router.push("/(app)/review"); } },
        { text: t("scan_try_again"), style: "cancel" },
      ]);
    } finally {
      analyzingRef.current = false;
      // C.3 — a scan spends the credit on the server (refunded if it failed
      // on our side): show the real balance.
      if (profile) void fetchFreshCredits(profile.id);
    }
  }, [currentBase64, currentUri, profile, t, setReceipt, setRawImageUri, setTip, setTipMode]);

  if (!currentUri) {
    router.back();
    return null;
  }

  if (isAnalyzing) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: "#000" }]}>
        <View style={styles.processingContainer}>
          <ActivityIndicator size="large" color={Colors.primary} />
          <Text style={styles.processingTitle}>{t("scan_analyzing")}</Text>
          <TouchableOpacity
            style={styles.cancelBtn}
            onPress={() => { cancelledRef.current = true; setIsAnalyzing(false); }}
          >
            <Text style={styles.cancelBtnText}>{t("cancel")}</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t("preview_title")}</Text>
        <View style={{ width: 24 }} />
      </View>

      <View style={styles.imageContainer}>
        <Image source={{ uri: currentUri }} style={styles.image} resizeMode="contain" />
        {isRotating && (
          <View style={styles.rotatingOverlay}>
            <ActivityIndicator color="#fff" size="large" />
            <Text style={styles.rotatingText}>{t("preview_rotating")}</Text>
          </View>
        )}
      </View>

      <View style={styles.controls}>
        <TouchableOpacity
          style={styles.rotateBtn}
          onPress={() => handleRotate(-90)}
          disabled={isRotating}
          activeOpacity={0.75}
        >
          <Ionicons name="arrow-undo-outline" size={22} color="#fff" />
          <Text style={styles.rotateBtnText}>{t("preview_rotate_left")}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.analyzeBtn, isRotating && { opacity: 0.5 }]}
          onPress={handleAnalyze}
          disabled={isRotating}
          activeOpacity={0.88}
        >
          <Ionicons name="scan-outline" size={20} color="#fff" />
          <Text style={styles.analyzeBtnText}>{t("preview_scan_btn")}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.rotateBtn}
          onPress={() => handleRotate(90)}
          disabled={isRotating}
          activeOpacity={0.75}
        >
          <Ionicons name="arrow-redo-outline" size={22} color="#fff" />
          <Text style={styles.rotateBtnText}>{t("preview_rotate_right")}</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#000" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  headerTitle: { color: "#fff", fontSize: 17, fontWeight: "700" },
  imageContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 8,
  },
  image: {
    width: width - 16,
    height: height * 0.68,
  },
  rotatingOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.55)",
    gap: 12,
  },
  rotatingText: { color: "#fff", fontSize: 14, fontWeight: "600" },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 24,
    paddingTop: 16,
    gap: 12,
  },
  rotateBtn: {
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 14,
    paddingHorizontal: 18,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.25)",
    minWidth: 76,
  },
  rotateBtnText: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "600",
    textAlign: "center",
    lineHeight: 15,
  },
  analyzeBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: Colors.primary,
    borderRadius: 14,
    paddingVertical: 16,
    shadowColor: Colors.primary,
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 5,
  },
  analyzeBtnText: { color: "#fff", fontSize: 15, fontWeight: "800" },
  processingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    padding: 40,
  },
  processingTitle: { fontSize: 22, fontWeight: "700", color: "#fff" },
  cancelBtn: {
    marginTop: 28,
    paddingVertical: 12,
    paddingHorizontal: 36,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.2)",
  },
  cancelBtnText: { color: "rgba(255,255,255,0.6)", fontSize: 14, fontWeight: "600" },
});
