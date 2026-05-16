import React, { useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  useColorScheme,
  Alert,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "@/constants/colors";
import { useReceiptStore } from "@/store/receiptStore";
import { useAuthStore } from "@/store/authStore";
import { analyzeReceipt, createBlankReceipt } from "@/utils/parser";
import { validateReceiptOCR } from "@/lib/receipt-validator";

type ScanMode = "camera" | "upload" | "manual";

export default function ScanScreen() {
  const isDark = useColorScheme() === "dark";
  const [mode, setMode] = useState<ScanMode>("camera");

  const { setReceipt, setRawImageUri, setProcessing, isProcessing, processingStep } =
    useReceiptStore();
  const { profile, isGuest } = useAuthStore();

  const textColor = isDark ? Colors.textPrimaryDark : Colors.textPrimaryLight;
  const mutedColor = isDark ? Colors.textMutedDark : Colors.textMutedLight;
  const bgColor = isDark ? Colors.bgDark : Colors.bgLight;
  const borderColor = isDark ? Colors.cardBorderDark : Colors.cardBorderLight;

  // ── Core analysis ───────────────────────────────────────────────────────────

  const handleAnalyze = async (uri: string) => {
    // Credit gate — bypassed in guest/dev mode
    if (!isGuest && !profile?.isPro && (profile?.billCredits ?? 0) <= 0) {
      Alert.alert(
        "No Credits Left",
        "Buy more scan credits or enter items manually.",
        [
          { text: "Buy Credits", onPress: () => router.push("/(app)/paywall") },
          { text: "Enter Manually", onPress: () => { setReceipt(createBlankReceipt()); router.push("/(app)/review"); } },
          { text: "Cancel", style: "cancel" },
        ]
      );
      return;
    }

    setRawImageUri(uri);
    setProcessing(true, "Reading receipt with Google Vision...");

    try {
      const { receipt: parsed } = await analyzeReceipt(uri);

      const itemCount = Object.values(parsed.categories).flat().length;
      if (itemCount === 0) {
        setProcessing(false);
        Alert.alert(
          "No Items Found",
          "Could not detect any items in the photo. Try a clearer image or enter manually.",
          [
            { text: "Try Again", style: "cancel" },
            { text: "Enter Manually", onPress: () => { setReceipt(createBlankReceipt()); router.push("/(app)/review"); } },
          ]
        );
        return;
      }

      setReceipt(parsed);
      setProcessing(false);

      // Route through OCR review screen if any validation issues found (strict: 0.01€ tolerance)
      const validation = validateReceiptOCR(parsed);
      const hasIssues = !validation.isValid;
      console.log(
        "[scan] Validation →",
        hasIssues
          ? `ISSUES (${validation.errors.length} errors, diff ${validation.totalDifference.toFixed(4)}€)`
          : `clean (diff ${validation.totalDifference.toFixed(4)}€)`
      );
      router.push(hasIssues ? "/(app)/review-receipt" : "/(app)/review");
    } catch (err) {
      setProcessing(false);
      const msg = err instanceof Error ? err.message : "";
      if (msg === "MISSING_GOOGLE_KEY") {
        Alert.alert(
          "Google Vision Key Required",
          "Add your Google Cloud API key to .env.local as EXPO_PUBLIC_GOOGLE_CLOUD_API_KEY.",
          [
            { text: "Enter Manually", onPress: () => { setReceipt(createBlankReceipt()); router.push("/(app)/review"); } },
            { text: "OK", style: "cancel" },
          ]
        );
      } else if (msg === "MISSING_KEY") {
        Alert.alert(
          "API Key Required",
          "Add your OpenAI API key to .env.local as EXPO_PUBLIC_OPENAI_API_KEY.",
          [
            { text: "Enter Manually", onPress: () => { setReceipt(createBlankReceipt()); router.push("/(app)/review"); } },
            { text: "OK", style: "cancel" },
          ]
        );
      } else {
        Alert.alert(
          "Analysis Failed",
          "Could not read the receipt. Try a clearer photo or enter manually.",
          [
            { text: "Enter Manually", onPress: () => { setReceipt(createBlankReceipt()); router.push("/(app)/review"); } },
            { text: "Try Again", style: "cancel" },
          ]
        );
      }
    }
  };

  // ── Capture / upload ────────────────────────────────────────────────────────

  const handleCapture = async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Camera Access", "Allow camera access in Settings to take photos.");
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images"],
      allowsEditing: false,
      quality: 0.85,
    });
    if (!result.canceled && result.assets[0]) {
      handleAnalyze(result.assets[0].uri);
    }
  };

  const handleGallery = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: false,
      quality: 0.9,
    });
    if (!result.canceled && result.assets[0]) {
      handleAnalyze(result.assets[0].uri);
    }
  };

  const handleManualEntry = () => {
    setReceipt(createBlankReceipt());
    router.push("/(app)/review");
  };

  // ── Loading overlay ─────────────────────────────────────────────────────────

  if (isProcessing) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: bgColor }]}>
        <View style={styles.processingContainer}>
          <ActivityIndicator size="large" color={Colors.primary} />
          <Text style={[styles.processingTitle, { color: textColor }]}>
            Analyzing Receipt
          </Text>
          <Text style={[styles.processingStep, { color: mutedColor }]}>
            {processingStep}
          </Text>
          <Text style={[styles.processingHint, { color: mutedColor }]}>
            Using Google Cloud Vision for maximum accuracy
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: bgColor }]}>
      {/* Header with back button */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="arrow-back" size={24} color={textColor} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: textColor }]}>Scan Receipt</Text>
        <View style={{ width: 24 }} />
      </View>

      {/* Mode tabs */}
      <View style={styles.modeTabs}>
        {(["camera", "upload", "manual"] as const).map((m) => (
          <TouchableOpacity
            key={m}
            style={[styles.modeTab, mode === m && styles.modeTabActive]}
            onPress={() => (m === "manual" ? handleManualEntry() : setMode(m))}
          >
            <Ionicons
              name={
                m === "camera"
                  ? "camera-outline"
                  : m === "upload"
                  ? "cloud-upload-outline"
                  : "create-outline"
              }
              size={18}
              color={mode === m ? Colors.primary : mutedColor}
            />
            <Text
              style={[
                styles.modeTabText,
                { color: mode === m ? Colors.primary : mutedColor },
              ]}
            >
              {m === "camera" ? "Camera" : m === "upload" ? "Upload" : "Manual"}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Camera mode — tap to launch native camera with crop */}
      {mode === "camera" && (
        <View style={styles.uploadContainer}>
          <TouchableOpacity
            style={[styles.uploadArea, { borderColor }]}
            onPress={handleCapture}
            activeOpacity={0.7}
          >
            <Ionicons name="camera-outline" size={56} color={Colors.primary} />
            <Text style={[styles.uploadTitle, { color: textColor }]}>
              Take a Photo
            </Text>
            <Text style={[styles.uploadSub, { color: mutedColor }]}>
              Full image sent to AI — no cropping needed
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Upload mode */}
      {mode === "upload" && (
        <View style={styles.uploadContainer}>
          <TouchableOpacity
            style={[styles.uploadArea, { borderColor }]}
            onPress={handleGallery}
            activeOpacity={0.7}
          >
            <Ionicons name="cloud-upload-outline" size={56} color={Colors.primary} />
            <Text style={[styles.uploadTitle, { color: textColor }]}>
              Upload a Receipt
            </Text>
            <Text style={[styles.uploadSub, { color: mutedColor }]}>
              Full image sent to AI — no cropping needed
            </Text>
          </TouchableOpacity>
        </View>
      )}
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
  modeTabs: {
    flexDirection: "row",
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 8,
    gap: 8,
  },
  modeTab: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 10,
    borderRadius: 10,
    gap: 6,
  },
  modeTabActive: {
    backgroundColor: Colors.primary + "22",
  },
  modeTabText: {
    fontSize: 13,
    fontWeight: "600",
  },
  uploadContainer: {
    flex: 1,
    padding: 20,
    justifyContent: "center",
  },
  uploadArea: {
    borderWidth: 2,
    borderStyle: "dashed",
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 60,
    gap: 12,
  },
  uploadTitle: {
    fontSize: 20,
    fontWeight: "700",
  },
  uploadSub: {
    fontSize: 14,
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
});
