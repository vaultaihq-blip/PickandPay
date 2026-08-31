/**
 * Image editor screen — crop before sending to OCR.
 * Install expo-image-manipulator to enable rotate/flip tools.
 */
import React, { useRef, useState, useCallback } from "react";
import {
  View,
  Text,
  Image,
  TouchableOpacity,
  StyleSheet,
  useColorScheme,
  PanResponder,
  Dimensions,
  Alert,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "@/constants/colors";
import { useReceiptStore } from "@/store/receiptStore";
import { useAuthStore } from "@/store/authStore";
import { analyzeReceipt, createBlankReceipt } from "@/utils/parser";

const { width: SCREEN_W } = Dimensions.get("window");
const CORNER = 28; // corner handle touch target
const MIN_CROP = 0.15; // minimum crop box size (fraction)

type CropBox = { x: number; y: number; w: number; h: number }; // all 0-1 fractions

export default function ImageEditorScreen() {
  const isDark = useColorScheme() === "dark";
  const { imageUri: rawUri } = useLocalSearchParams<{ imageUri: string }>();

  const [imageUri, setImageUri] = useState(rawUri ?? "");
  const [analyzing, setAnalyzing] = useState(false);

  // Crop box as fraction of displayed image area (0–1)
  const cropRef = useRef<CropBox>({ x: 0.05, y: 0.05, w: 0.9, h: 0.9 });
  const [cropBox, setCropBox] = useState<CropBox>(cropRef.current);

  // Actual pixel size of the image display area (set via onLayout)
  const imageBoundsRef = useRef({ w: SCREEN_W, h: SCREEN_W * 1.4 });

  const textColor = isDark ? Colors.textPrimaryDark : Colors.textPrimaryLight;
  const mutedColor = isDark ? Colors.textMutedDark : Colors.textMutedLight;
  const bgColor = isDark ? Colors.bgDark : Colors.bgLight;

  const { setReceipt, setRawImageUri, setProcessing } = useReceiptStore();
  const { profile, deductCredit, isEmailVerified } = useAuthStore();

  // ── Crop PanResponder helpers ────────────────────────────────────────────────

  function makePanResponder(
    corner: "TL" | "TR" | "BL" | "BR"
  ) {
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {},
      onPanResponderMove: (_, gs) => {
        const { w: bw, h: bh } = imageBoundsRef.current;
        const c = cropRef.current;
        const dx = gs.dx / bw;
        const dy = gs.dy / bh;

        let { x, y, w, h } = c;

        if (corner === "TL" || corner === "BL") {
          const newX = Math.max(0, Math.min(x + w - MIN_CROP, x + dx));
          w = w - (newX - x);
          x = newX;
        }
        if (corner === "TR" || corner === "BR") {
          w = Math.max(MIN_CROP, Math.min(1 - x, w + dx));
        }
        if (corner === "TL" || corner === "TR") {
          const newY = Math.max(0, Math.min(y + h - MIN_CROP, y + dy));
          h = h - (newY - y);
          y = newY;
        }
        if (corner === "BL" || corner === "BR") {
          h = Math.max(MIN_CROP, Math.min(1 - y, h + dy));
        }

        const next: CropBox = { x, y, w, h };
        cropRef.current = next;
        setCropBox({ ...next });
      },
    });
  }

  // Create once (refs are stable across renders)
  const panTL = useRef(makePanResponder("TL")).current;
  const panTR = useRef(makePanResponder("TR")).current;
  const panBL = useRef(makePanResponder("BL")).current;
  const panBR = useRef(makePanResponder("BR")).current;

  // ── Analysis ─────────────────────────────────────────────────────────────────

  const handleAnalyze = useCallback(async () => {
    // Gate 1: email must be verified for email/password accounts
    if (!isEmailVerified()) {
      Alert.alert(
        "Verify Your Email",
        "Check your inbox and click the confirmation link before using credits.",
        [{ text: "OK" }]
      );
      return;
    }
    // Gate 2: must have credits
    if (!profile?.isPro && (profile?.billCredits ?? 0) <= 0) {
      Alert.alert(
        "No Credits Left",
        "Buy more credits or enter items manually.",
        [
          { text: "Buy Credits", onPress: () => router.push("/(app)/paywall") },
          { text: "Enter Manually", onPress: () => { setReceipt(createBlankReceipt()); router.replace("/(app)/review"); } },
          { text: "Cancel", style: "cancel" },
        ]
      );
      return;
    }

    setAnalyzing(true);
    setRawImageUri(imageUri);
    setProcessing(true, "Reading receipt with AI...");

    try {
      const { receipt: parsed } = await analyzeReceipt(imageUri);
      deductCredit();
      setReceipt(parsed);
      setProcessing(false);
      router.replace("/(app)/review");
    } catch (err) {
      setProcessing(false);
      setAnalyzing(false);
      const msg = err instanceof Error ? err.message : "";
      if (msg === "MISSING_KEY") {
        Alert.alert("API Key Required", "Add your OpenAI API key to .env.local as EXPO_PUBLIC_OPENAI_API_KEY.", [
          { text: "Enter Manually", onPress: () => { setReceipt(createBlankReceipt()); router.replace("/(app)/review"); } },
          { text: "OK", style: "cancel" },
        ]);
      } else {
        Alert.alert("Analysis Failed", "Could not read the receipt.", [
          { text: "Enter Manually", onPress: () => { setReceipt(createBlankReceipt()); router.replace("/(app)/review"); } },
          { text: "Try Again", style: "cancel" },
        ]);
      }
    }
  }, [imageUri, profile, deductCredit, setReceipt, setRawImageUri, setProcessing]);

  if (analyzing) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: bgColor }]}>
        <View style={styles.analyzeLoader}>
          <ActivityIndicator size="large" color={Colors.primary} />
          <Text style={[styles.analyzeLoaderText, { color: textColor }]}>Analyzing Receipt…</Text>
        </View>
      </SafeAreaView>
    );
  }

  // ── Crop overlay geometry ────────────────────────────────────────────────────
  const bw = imageBoundsRef.current.w;
  const bh = imageBoundsRef.current.h;
  const cx = cropBox.x * bw;
  const cy = cropBox.y * bh;
  const cw = cropBox.w * bw;
  const ch = cropBox.h * bh;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: "#000" }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="close" size={26} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Edit Receipt Photo</Text>
        <View style={{ width: 26 }} />
      </View>

      {/* Image with crop overlay */}
      <View
        style={styles.imageContainer}
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          imageBoundsRef.current = { w: width, h: height };
        }}
      >
        <Image
          source={{ uri: imageUri }}
          style={StyleSheet.absoluteFill}
          resizeMode="stretch"
        />

        {/* Dim outside crop box */}
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          {/* Top */}
          <View style={[styles.dimOverlay, { top: 0, left: 0, right: 0, height: cy }]} />
          {/* Bottom */}
          <View style={[styles.dimOverlay, { bottom: 0, left: 0, right: 0, height: bh - cy - ch }]} />
          {/* Left */}
          <View style={[styles.dimOverlay, { top: cy, left: 0, width: cx, height: ch }]} />
          {/* Right */}
          <View style={[styles.dimOverlay, { top: cy, right: 0, width: bw - cx - cw, height: ch }]} />
          {/* Crop box border */}
          <View style={[styles.cropBorder, { left: cx, top: cy, width: cw, height: ch }]} />
        </View>

        {/* Corner handles */}
        <View style={[styles.cornerHandle, { left: cx - CORNER / 2, top: cy - CORNER / 2 }]} {...panTL.panHandlers} />
        <View style={[styles.cornerHandle, { left: cx + cw - CORNER / 2, top: cy - CORNER / 2 }]} {...panTR.panHandlers} />
        <View style={[styles.cornerHandle, { left: cx - CORNER / 2, top: cy + ch - CORNER / 2 }]} {...panBL.panHandlers} />
        <View style={[styles.cornerHandle, { left: cx + cw - CORNER / 2, top: cy + ch - CORNER / 2 }]} {...panBR.panHandlers} />
      </View>

      {/* Toolbar */}
      <View style={styles.toolbar}>
        <ToolBtn
          icon="refresh"
          label="Reset Crop"
          onPress={() => {
            const init: CropBox = { x: 0.05, y: 0.05, w: 0.9, h: 0.9 };
            cropRef.current = init;
            setCropBox(init);
          }}
        />
      </View>

      {/* Actions */}
      <View style={styles.footer}>
        <TouchableOpacity
          style={[styles.cancelBtn, { borderColor: "rgba(255,255,255,0.3)" }]}
          onPress={() => router.back()}
        >
          <Text style={styles.cancelBtnText}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.analyzeBtn} onPress={handleAnalyze} activeOpacity={0.85}>
          <Ionicons name="sparkles-outline" size={18} color="#fff" />
          <Text style={styles.analyzeBtnText}>Analyze Receipt</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

function ToolBtn({ icon, label, onPress }: { icon: string; label: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={styles.toolBtn} onPress={onPress} activeOpacity={0.7}>
      <Ionicons name={icon as any} size={22} color="#fff" />
      <Text style={styles.toolBtnLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: "#000",
  },
  headerTitle: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
  imageContainer: {
    flex: 1,
    position: "relative",
    backgroundColor: "#111",
  },
  dimOverlay: {
    position: "absolute",
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  cropBorder: {
    position: "absolute",
    borderWidth: 2,
    borderColor: "#fff",
  },
  cornerHandle: {
    position: "absolute",
    width: CORNER,
    height: CORNER,
    backgroundColor: "transparent",
    borderWidth: 3,
    borderColor: Colors.primary,
    borderRadius: 4,
  },
  toolbar: {
    flexDirection: "row",
    justifyContent: "space-around",
    paddingVertical: 12,
    paddingHorizontal: 8,
    backgroundColor: "#111",
  },
  toolBtn: {
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  toolBtnLabel: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 10,
    textAlign: "center",
  },
  footer: {
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 16,
    paddingBottom: 24,
    paddingTop: 12,
    backgroundColor: "#000",
  },
  cancelBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 14,
    borderWidth: 1.5,
    alignItems: "center",
  },
  cancelBtnText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "600",
  },
  analyzeBtn: {
    flex: 2,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: 14,
    backgroundColor: Colors.primary,
  },
  analyzeBtnText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "700",
  },
  analyzeLoader: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
  },
  analyzeLoaderText: {
    fontSize: 18,
    fontWeight: "700",
  },
});
