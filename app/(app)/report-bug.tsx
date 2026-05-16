import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Modal,
  Image,
  useColorScheme,
  Alert,
  Platform,
  KeyboardAvoidingView,
  Linking,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import * as MailComposer from "expo-mail-composer";
import { Colors } from "@/constants/colors";
import { useAuthStore } from "@/store/authStore";

type ErrorType = "OCR Error" | "Math Error" | "App Crash" | "UI Issue" | "Other / Suggestion";

const ERROR_TYPES: ErrorType[] = ["OCR Error", "Math Error", "App Crash", "UI Issue", "Other / Suggestion"];

const BUG_EMAIL = process.env.EXPO_PUBLIC_BUG_REPORT_EMAIL ?? "bugs@pickandpay.app";

export default function ReportBugScreen() {
  const isDark = useColorScheme() === "dark";
  const { profile } = useAuthStore();

  const [errorType, setErrorType] = useState<ErrorType>("Other / Suggestion");
  const [description, setDescription] = useState("");
  const [email, setEmail] = useState(profile?.email ?? "");
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [successVisible, setSuccessVisible] = useState(false);

  const textColor = isDark ? Colors.textPrimaryDark : Colors.textPrimaryLight;
  const mutedColor = isDark ? Colors.textMutedDark : Colors.textMutedLight;
  const bgColor = isDark ? Colors.bgDark : Colors.bgLight;
  const cardColor = isDark ? Colors.cardDark : Colors.cardLight;
  const borderColor = isDark ? Colors.cardBorderDark : Colors.cardBorderLight;

  const pickImage = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission needed", "Please allow access to your photo library.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.8,
    });
    if (!result.canceled && result.assets[0]) {
      setImageUri(result.assets[0].uri);
    }
  };

  const takePhoto = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission needed", "Please allow camera access.");
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.8,
    });
    if (!result.canceled && result.assets[0]) {
      setImageUri(result.assets[0].uri);
    }
  };

  const handleSubmit = async () => {
    if (!description.trim()) {
      Alert.alert("Missing description", "Please describe the issue before submitting.");
      return;
    }
    setSubmitting(true);
    try {
      const body = `Error Type: ${errorType}\n\nDescription:\n${description.trim()}\n\nUser: ${email.trim() || "Anonymous"}\nDate: ${new Date().toISOString()}\nPlatform: ${Platform.OS} ${Platform.Version}`;

      const available = await MailComposer.isAvailableAsync();
      if (available) {
        const result = await MailComposer.composeAsync({
          recipients: [BUG_EMAIL],
          subject: `Bug Report: ${errorType}`,
          body,
          attachments: imageUri ? [imageUri] : [],
        });
        if (result.status === MailComposer.MailComposerStatus.SENT) {
          setSuccessVisible(true);
        }
      } else {
        const encodedSubject = encodeURIComponent(`Bug Report: ${errorType}`);
        const encodedBody = encodeURIComponent(body);
        await Linking.openURL(`mailto:${BUG_EMAIL}?subject=${encodedSubject}&body=${encodedBody}`);
        setSuccessVisible(true);
      }
    } catch {
      Alert.alert("Error", "Failed to open mail composer. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: bgColor }]}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()}>
            <Ionicons name="arrow-back" size={24} color={textColor} />
          </TouchableOpacity>
          <Text style={[styles.title, { color: textColor }]}>Report a Bug</Text>
          <View style={{ width: 24 }} />
        </View>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Error type */}
          <Text style={[styles.label, { color: mutedColor }]}>ERROR TYPE</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chipRow}
          >
            {ERROR_TYPES.map((type) => (
              <TouchableOpacity
                key={type}
                style={[
                  styles.chip,
                  { borderColor },
                  errorType === type && styles.chipActive,
                ]}
                onPress={() => setErrorType(type)}
                activeOpacity={0.7}
              >
                <Text
                  style={[
                    styles.chipText,
                    { color: errorType === type ? Colors.primary : mutedColor },
                  ]}
                >
                  {type}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {/* Description */}
          <Text style={[styles.label, { color: mutedColor }]}>DESCRIPTION <Text style={styles.required}>*</Text></Text>
          <TextInput
            style={[styles.textArea, { color: textColor, borderColor, backgroundColor: cardColor }]}
            value={description}
            onChangeText={setDescription}
            placeholder="Describe what happened, what you expected, and any steps to reproduce..."
            placeholderTextColor={mutedColor}
            multiline
            textAlignVertical="top"
            numberOfLines={5}
          />

          {/* Email */}
          <Text style={[styles.label, { color: mutedColor }]}>YOUR EMAIL</Text>
          <TextInput
            style={[styles.input, { color: textColor, borderColor, backgroundColor: cardColor }]}
            value={email}
            onChangeText={setEmail}
            placeholder="email@example.com"
            placeholderTextColor={mutedColor}
            keyboardType="email-address"
            autoCapitalize="none"
          />

          {/* Receipt image */}
          <Text style={[styles.label, { color: mutedColor }]}>ATTACH SCREENSHOT (OPTIONAL)</Text>
          {imageUri ? (
            <View style={styles.imagePreviewContainer}>
              <Image source={{ uri: imageUri }} style={styles.imagePreview} />
              <TouchableOpacity
                style={styles.removeImageBtn}
                onPress={() => setImageUri(null)}
              >
                <Ionicons name="close-circle" size={22} color="#FF3B30" />
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.imagePickerRow}>
              <TouchableOpacity
                style={[styles.imagePickerBtn, { borderColor }]}
                onPress={pickImage}
                activeOpacity={0.7}
              >
                <Ionicons name="image-outline" size={20} color={mutedColor} />
                <Text style={[styles.imagePickerText, { color: mutedColor }]}>
                  Choose Photo
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.imagePickerBtn, { borderColor }]}
                onPress={takePhoto}
                activeOpacity={0.7}
              >
                <Ionicons name="camera-outline" size={20} color={mutedColor} />
                <Text style={[styles.imagePickerText, { color: mutedColor }]}>
                  Take Photo
                </Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Submit */}
          <TouchableOpacity
            style={[styles.submitBtn, submitting && { opacity: 0.6 }]}
            onPress={handleSubmit}
            disabled={submitting}
            activeOpacity={0.85}
          >
            <Ionicons name="send-outline" size={18} color="#fff" />
            <Text style={styles.submitBtnText}>
              {submitting ? "Opening mail..." : "Submit Bug Report"}
            </Text>
          </TouchableOpacity>

          <Text style={[styles.footerNote, { color: mutedColor }]}>
            Submitting opens your mail app. Your report goes to {BUG_EMAIL}.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Success modal */}
      <Modal
        visible={successVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setSuccessVisible(false)}
      >
        <View style={styles.successOverlay}>
          <View style={[styles.successCard, { backgroundColor: cardColor }]}>
            <View style={styles.successIcon}>
              <Ionicons name="checkmark-circle" size={48} color={Colors.success} />
            </View>
            <Text style={[styles.successTitle, { color: textColor }]}>Thank you!</Text>
            <Text style={[styles.successBody, { color: mutedColor }]}>
              We received your bug report and will review it as soon as possible.
              We'll respond via email if we need more info.
            </Text>
            <TouchableOpacity
              style={styles.successCloseBtn}
              onPress={() => {
                setSuccessVisible(false);
                router.back();
              }}
            >
              <Text style={styles.successCloseBtnText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },

  // ── Header ───────────────────────────────────────────────────────────────────
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 14,
    gap: 12,
  },
  title: {
    flex: 1,
    fontSize: 18,
    fontWeight: "700",
    textAlign: "center",
  },

  // ── Scroll ───────────────────────────────────────────────────────────────────
  scroll: { flex: 1 },
  scrollContent: {
    paddingHorizontal: 20,
    paddingBottom: 40,
    gap: 10,
  },

  // ── Form fields ───────────────────────────────────────────────────────────────
  label: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.5,
    marginTop: 6,
  },
  required: {
    color: "#FF3B30",
  },
  chipRow: {
    gap: 8,
    paddingVertical: 4,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 20,
    borderWidth: 1.5,
  },
  chipActive: {
    backgroundColor: Colors.primary + "18",
    borderColor: Colors.primary,
  },
  chipText: {
    fontSize: 13,
    fontWeight: "600",
  },
  textArea: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    minHeight: 120,
    lineHeight: 22,
  },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
  },

  // ── Image picker ─────────────────────────────────────────────────────────────
  imagePickerRow: {
    flexDirection: "row",
    gap: 10,
  },
  imagePickerBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1.5,
    borderStyle: "dashed",
  },
  imagePickerText: {
    fontSize: 13,
    fontWeight: "600",
  },
  imagePreviewContainer: {
    position: "relative",
    alignSelf: "flex-start",
  },
  imagePreview: {
    width: 120,
    height: 120,
    borderRadius: 10,
  },
  removeImageBtn: {
    position: "absolute",
    top: -8,
    right: -8,
  },

  // ── Submit ────────────────────────────────────────────────────────────────────
  submitBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    backgroundColor: Colors.primary,
    paddingVertical: 16,
    borderRadius: 14,
    marginTop: 8,
  },
  submitBtnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
  footerNote: {
    fontSize: 12,
    textAlign: "center",
    lineHeight: 18,
  },

  // ── Success modal ─────────────────────────────────────────────────────────────
  successOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
  },
  successCard: {
    width: "100%",
    borderRadius: 20,
    padding: 28,
    alignItems: "center",
    gap: 12,
  },
  successIcon: {
    marginBottom: 4,
  },
  successTitle: {
    fontSize: 22,
    fontWeight: "800",
  },
  successBody: {
    fontSize: 15,
    textAlign: "center",
    lineHeight: 22,
  },
  successCloseBtn: {
    marginTop: 8,
    backgroundColor: Colors.primary,
    paddingHorizontal: 40,
    paddingVertical: 14,
    borderRadius: 12,
  },
  successCloseBtnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
});
