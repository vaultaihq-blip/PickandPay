import React, { useCallback, useRef, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  useColorScheme,
  Alert,
  ActivityIndicator,
  BackHandler,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "@/constants/colors";
import { useReceiptStore } from "@/store/receiptStore";
import { useSessionStore } from "@/store/sessionStore";
import { supabase } from "@/lib/supabase";
import { createBlankReceipt } from "@/utils/parser";
import { useI18nStore } from "@/store/i18nStore";

type ScanMode = "camera" | "upload" | "manual";

const EXAMPLE_LINES = [
  ["Margherita", "$14.00"],
  ["Garlic Bread", "$6.50"],
  ["Sparkling Water", "$4.50"],
  ["Tiramisu", "$7.00"],
];

export default function ScanScreen() {
  const isDark = useColorScheme() === "dark";
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<ScanMode>("camera");
  const [isPicking, setIsPicking] = useState(false);

  const { setReceipt, setProcessing, clearReceipt, setPendingImage, isProcessing, processingStep } =
    useReceiptStore();
  const { currentSession, clearSession } = useSessionStore();
  const { t, language } = useI18nStore();
  void language;
  const cancelledRef = useRef(false);

  const textColor = isDark ? Colors.textPrimaryDark : Colors.textPrimaryLight;
  const mutedColor = isDark ? Colors.textMutedDark : Colors.textMutedLight;
  const bgColor = isDark ? Colors.bgDark : Colors.bgLight;
  const borderColor = isDark ? Colors.cardBorderDark : Colors.cardBorderLight;
  const cardColor = isDark ? Colors.cardDark : Colors.cardLight;

  const closeActiveSession = useCallback(async () => {
    const session = useSessionStore.getState().currentSession;
    if (!session) {
      router.back();
      return;
    }
    const isOfflineSession = session.id.startsWith("session_") || session.id.startsWith("dev_session_");
    try {
      if (!isOfflineSession) {
        await supabase.from("sessions").update({ status: "closed" }).eq("id", session.id);
      }
    } finally {
      clearReceipt();
      clearSession();
      router.replace("/(app)");
    }
  }, [clearReceipt, clearSession]);

  const handleBack = useCallback(() => {
    if (!currentSession) {
      router.back();
      return;
    }
    Alert.alert(
      "End Session?",
      "Going back from receipt scanning will close this session for everyone.",
      [
        { text: t("cancel"), style: "cancel" },
        {
          text: "End Session",
          style: "destructive",
          onPress: closeActiveSession,
        },
      ]
    );
  }, [closeActiveSession, currentSession, t]);

  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener("hardwareBackPress", () => {
        handleBack();
        return true;
      });
      return () => sub.remove();
    }, [handleBack])
  );

  const handleCancelProcessing = useCallback(() => {
    cancelledRef.current = true;
    setProcessing(false);
  }, [setProcessing]);

  // Re-encodes the picked/captured image with no-op operations — this alone
  // bakes the file's EXIF Orientation tag into the actual pixel buffer and
  // strips the tag. Without this, a photo taken sideways (a common phone
  // photo of a receipt lying on a table) displays upright everywhere
  // because viewers honour the EXIF tag, but the raw base64 sent to the
  // server keeps the original rotated pixel layout — and Google Vision's
  // OCR bounding boxes come back in that raw pixel space, not the tag-
  // corrected one, corrupting line reconstruction downstream. Every image
  // entry point must go through this before it's used for anything else.
  const normalizeImageOrientation = async (uri: string) => {
    const result = await ImageManipulator.manipulateAsync(uri, [], {
      compress: 0.9,
      format: ImageManipulator.SaveFormat.JPEG,
      base64: true,
    });
    return { uri: result.uri, base64: result.base64 ? `data:image/jpeg;base64,${result.base64}` : result.uri };
  };

  const handleCapture = async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert(t("avatar_camera_title"), t("avatar_camera_msg"));
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images"],
      allowsEditing: false,
      quality: 0.9,
      base64: true,
    });
    if (!result.canceled && result.assets[0]) {
      const asset = result.assets[0];
      const normalized = await normalizeImageOrientation(asset.uri);
      setPendingImage(normalized.uri, normalized.base64);
      router.push("/(app)/receipt-preview");
    }
  };

  const handleGallery = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: false,
      quality: 0.9,
      base64: true,
    });
    if (!result.canceled && result.assets[0]) {
      const asset = result.assets[0];
      const normalized = await normalizeImageOrientation(asset.uri);
      setPendingImage(normalized.uri, normalized.base64);
      router.push("/(app)/receipt-preview");
    }
  };

  const handleManualEntry = () => {
    setReceipt(createBlankReceipt());
    router.push("/(app)/review");
  };

  if (isProcessing || isPicking) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: bgColor }]}>
        <View style={styles.processingContainer}>
          <ActivityIndicator size="large" color={Colors.primary} />
          <Text style={[styles.processingTitle, { color: textColor }]}>
            {t("scan_analyzing")}
          </Text>
          <Text style={[styles.processingStep, { color: mutedColor }]}>
            {processingStep}
          </Text>
          <TouchableOpacity style={styles.cancelBtn} onPress={handleCancelProcessing} activeOpacity={0.75}>
            <Text style={styles.cancelBtnText}>{t("cancel")}</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: bgColor }]}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={handleBack}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="arrow-back" size={24} color={textColor} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: textColor }]}>{t("scan_title")}</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingBottom: 24 + Math.max(insets.bottom, 16) },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.modeTabs, { backgroundColor: cardColor, borderColor }]}>
          {(["camera", "upload", "manual"] as const).map((m) => {
            const active = mode === m;
            return (
              <TouchableOpacity
                key={m}
                style={[styles.modeTab, active && styles.modeTabActive]}
                onPress={() => (m === "manual" ? handleManualEntry() : setMode(m))}
                activeOpacity={0.8}
              >
                <Ionicons
                  name={
                    m === "camera"
                      ? "camera-outline"
                      : m === "upload"
                      ? "cloud-upload-outline"
                      : "create-outline"
                  }
                  size={16}
                  color={active ? "#fff" : mutedColor}
                />
                <Text style={[styles.modeTabText, { color: active ? "#fff" : mutedColor }]}>
                  {m === "camera"
                    ? t("scan_camera_tab")
                    : m === "upload"
                    ? t("scan_upload_tab")
                    : t("scan_manual_tab")}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {mode === "camera" && (
          <>
            <TouchableOpacity
              style={[styles.cameraFrame, { borderColor }]}
              onPress={handleCapture}
              activeOpacity={0.82}
            >
              <View style={styles.cornerTopLeft} />
              <View style={styles.cornerTopRight} />
              <View style={styles.cornerBottomLeft} />
              <View style={styles.cornerBottomRight} />

              <View style={styles.receiptPreview}>
                <Text style={styles.watermarkTop}>{t("scan_example_watermark")}</Text>
                <Text style={styles.receiptStore}>PIZZARIA</Text>
                <Text style={styles.receiptMeta}>Table 12 - May 16, 2026</Text>
                {EXAMPLE_LINES.map(([label, value]) => (
                  <View key={label} style={styles.receiptLine}>
                    <Text style={styles.receiptItem}>{label}</Text>
                    <Text style={styles.receiptValue}>{value}</Text>
                  </View>
                ))}
                <View style={styles.receiptDivider} />
                <View style={styles.receiptLine}>
                  <Text style={styles.receiptTotalLabel}>Total</Text>
                  <Text style={styles.receiptTotalValue}>$32.00</Text>
                </View>
                <Text style={styles.watermarkBottom}>{t("scan_example_watermark")}</Text>
              </View>
            </TouchableOpacity>

            <Text style={[styles.scanHint, { color: mutedColor }]}>
              {t("scan_ai_hint")}
            </Text>

            <TouchableOpacity style={styles.primaryAction} onPress={handleCapture} activeOpacity={0.88}>
              <Ionicons name="camera-outline" size={20} color="#fff" />
              <Text style={styles.primaryActionText}>{t("scan_take_photo_title")}</Text>
            </TouchableOpacity>
          </>
        )}

        {mode === "upload" && (
          <TouchableOpacity
            style={[styles.uploadArea, { backgroundColor: cardColor, borderColor }]}
            onPress={handleGallery}
            activeOpacity={0.82}
          >
            <View style={styles.uploadIcon}>
              <Ionicons name="cloud-upload-outline" size={34} color={Colors.primary} />
            </View>
            <Text style={[styles.uploadTitle, { color: textColor }]}>
              {t("scan_upload_title")}
            </Text>
            <Text style={[styles.uploadSub, { color: mutedColor }]}>
              {t("scan_ai_hint")}
            </Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: "700",
  },
  scroll: {
    flexGrow: 1,
    paddingHorizontal: 20,
    paddingTop: 10,
    gap: 18,
  },
  modeTabs: {
    flexDirection: "row",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    padding: 4,
    gap: 4,
  },
  modeTab: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 9,
    borderRadius: 10,
    gap: 6,
  },
  modeTabActive: {
    backgroundColor: Colors.primary,
  },
  modeTabText: {
    fontSize: 12,
    fontWeight: "700",
  },
  cameraFrame: {
    minHeight: 430,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#080A0D",
    overflow: "hidden",
  },
  cornerTopLeft: {
    position: "absolute",
    top: 18,
    left: 18,
    width: 42,
    height: 42,
    borderTopWidth: 3,
    borderLeftWidth: 3,
    borderColor: Colors.primary,
    borderTopLeftRadius: 8,
  },
  cornerTopRight: {
    position: "absolute",
    top: 18,
    right: 18,
    width: 42,
    height: 42,
    borderTopWidth: 3,
    borderRightWidth: 3,
    borderColor: Colors.primary,
    borderTopRightRadius: 8,
  },
  cornerBottomLeft: {
    position: "absolute",
    bottom: 18,
    left: 18,
    width: 42,
    height: 42,
    borderBottomWidth: 3,
    borderLeftWidth: 3,
    borderColor: Colors.primary,
    borderBottomLeftRadius: 8,
  },
  cornerBottomRight: {
    position: "absolute",
    bottom: 18,
    right: 18,
    width: 42,
    height: 42,
    borderBottomWidth: 3,
    borderRightWidth: 3,
    borderColor: Colors.primary,
    borderBottomRightRadius: 8,
  },
  receiptPreview: {
    width: "70%",
    maxWidth: 270,
    minHeight: 330,
    backgroundColor: "#F8F2E8",
    padding: 22,
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 8,
  },
  watermarkTop: {
    position: "absolute",
    top: 54,
    alignSelf: "center",
    color: "rgba(99,102,241,0.14)",
    fontSize: 28,
    fontWeight: "900",
    transform: [{ rotate: "-18deg" }],
    textTransform: "uppercase",
  },
  watermarkBottom: {
    position: "absolute",
    bottom: 76,
    alignSelf: "center",
    color: "rgba(99,102,241,0.12)",
    fontSize: 24,
    fontWeight: "900",
    transform: [{ rotate: "-18deg" }],
    textTransform: "uppercase",
  },
  receiptStore: {
    color: "#111827",
    fontSize: 17,
    fontWeight: "900",
    textAlign: "center",
    letterSpacing: 0.8,
  },
  receiptMeta: {
    color: "#6B7280",
    fontSize: 10,
    textAlign: "center",
    marginTop: 4,
    marginBottom: 22,
  },
  receiptLine: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 14,
    paddingVertical: 5,
  },
  receiptItem: { color: "#111827", fontSize: 12, flex: 1 },
  receiptValue: { color: "#111827", fontSize: 12, fontWeight: "700" },
  receiptDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: "#CBD5E1",
    marginVertical: 12,
  },
  receiptTotalLabel: { color: "#111827", fontSize: 14, fontWeight: "900" },
  receiptTotalValue: { color: "#111827", fontSize: 14, fontWeight: "900" },
  scanHint: {
    textAlign: "center",
    fontSize: 13,
    lineHeight: 18,
    marginTop: -4,
  },
  primaryAction: {
    minHeight: 54,
    borderRadius: 14,
    backgroundColor: Colors.primary,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    shadowColor: Colors.primary,
    shadowOpacity: 0.32,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 5,
  },
  primaryActionText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "800",
  },
  uploadArea: {
    minHeight: 330,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    padding: 28,
    gap: 12,
  },
  uploadIcon: {
    width: 72,
    height: 72,
    borderRadius: 20,
    backgroundColor: Colors.primary + "18",
    alignItems: "center",
    justifyContent: "center",
  },
  uploadTitle: {
    fontSize: 18,
    fontWeight: "800",
    textAlign: "center",
  },
  uploadSub: {
    fontSize: 13,
    textAlign: "center",
    lineHeight: 18,
  },
  processingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    padding: 40,
  },
  processingTitle: {
    fontSize: 22,
    fontWeight: "700",
  },
  processingStep: {
    fontSize: 15,
    textAlign: "center",
  },
  processingHint: {
    fontSize: 12,
    textAlign: "center",
    opacity: 0.6,
    marginTop: 4,
  },
  cancelBtn: {
    marginTop: 28,
    paddingVertical: 12,
    paddingHorizontal: 36,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.2)",
  },
  cancelBtnText: {
    color: "rgba(255,255,255,0.6)",
    fontSize: 14,
    fontWeight: "600",
  },
});
