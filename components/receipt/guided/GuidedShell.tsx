/**
 * Shared chrome for the guided correction flow (FIX 45).
 *
 * Deliberately reuses the visual language already in review-receipt.tsx —
 * same radii, paddings, Colors tokens and button shapes. This round changes
 * the organisation of that screen, not its look.
 */
import React from "react";
import { View, Text, TouchableOpacity, StyleSheet, useColorScheme } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "@/constants/colors";

export function useGuidedTheme() {
  const isDark = useColorScheme() === "dark";
  return {
    isDark,
    textColor: isDark ? Colors.textPrimaryDark : Colors.textPrimaryLight,
    mutedColor: isDark ? Colors.textMutedDark : Colors.textMutedLight,
    bgColor: isDark ? Colors.bgDark : Colors.bgLight,
    borderColor: isDark ? Colors.cardBorderDark : Colors.cardBorderLight,
    cardColor: isDark ? Colors.cardDark : Colors.cardLight,
  };
}

interface StepHeaderProps {
  title: string;
  /** Shown on the right, e.g. "item 2 de 5" or "passo 2 de 4". */
  caption?: string;
  onBack?: () => void;
}

export function StepHeader({ title, caption, onBack }: StepHeaderProps) {
  const { textColor, mutedColor } = useGuidedTheme();
  return (
    <View style={styles.header}>
      {onBack ? (
        <TouchableOpacity onPress={onBack} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="arrow-back" size={24} color={textColor} />
        </TouchableOpacity>
      ) : (
        <View style={{ width: 24 }} />
      )}
      <Text style={[styles.headerTitle, { color: textColor }]} numberOfLines={1}>
        {title}
      </Text>
      {caption ? (
        <Text style={[styles.headerCaption, { color: mutedColor }]}>{caption}</Text>
      ) : (
        <View style={{ width: 24 }} />
      )}
    </View>
  );
}

export function PrimaryButton({
  label,
  onPress,
  tone = "primary",
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  tone?: "primary" | "warning" | "success";
  disabled?: boolean;
}) {
  const background =
    tone === "warning" ? Colors.warning : tone === "success" ? Colors.success : Colors.primary;
  return (
    <TouchableOpacity
      style={[styles.primaryBtn, { backgroundColor: background }, disabled && { opacity: 0.45 }]}
      onPress={onPress}
      disabled={disabled}
      accessibilityState={{ disabled }}
      activeOpacity={0.85}
    >
      <Text style={styles.primaryBtnText}>{label}</Text>
    </TouchableOpacity>
  );
}

export function SecondaryButton({ label, onPress }: { label: string; onPress: () => void }) {
  const { borderColor, mutedColor } = useGuidedTheme();
  return (
    <TouchableOpacity
      style={[styles.secondaryBtn, { borderColor }]}
      onPress={onPress}
      activeOpacity={0.8}
    >
      <Text style={[styles.secondaryBtnText, { color: mutedColor }]}>{label}</Text>
    </TouchableOpacity>
  );
}

/** A plain text link, for the always-available escape hatches. */
export function LinkButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.7} style={styles.linkBtn}>
      <Text style={styles.linkBtnText}>{label}</Text>
    </TouchableOpacity>
  );
}

export const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 14,
    gap: 10,
  },
  headerTitle: { fontSize: 17, fontWeight: "700", flex: 1 },
  headerCaption: { fontSize: 12, fontWeight: "600" },

  body: { paddingHorizontal: 20, gap: 14, flexGrow: 1 },

  actions: {
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  primaryBtn: {
    flex: 2,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 15,
    borderRadius: 12,
  },
  primaryBtnText: { color: "#fff", fontSize: 15, fontWeight: "700" },
  secondaryBtn: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 15,
    borderRadius: 12,
    borderWidth: 1,
  },
  secondaryBtnText: { fontSize: 13, fontWeight: "600" },
  linkBtn: { alignSelf: "center", paddingVertical: 10 },
  linkBtnText: {
    fontSize: 13,
    fontWeight: "600",
    color: Colors.primary,
    textDecorationLine: "underline",
  },

  card: { borderRadius: 14, borderWidth: 1, padding: 16, gap: 12 },
  fieldLabel: {
    fontSize: 10,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  fieldInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    textAlign: "right",
  },
});
