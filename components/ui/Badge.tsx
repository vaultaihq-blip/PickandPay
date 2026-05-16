import React from "react";
import { View, Text, StyleSheet, ViewStyle } from "react-native";

type BadgeVariant = "default" | "success" | "warning" | "error" | "info" | "shared" | "combo";

interface BadgeProps {
  label: string;
  variant?: BadgeVariant;
  style?: ViewStyle;
}

const VARIANT_STYLES: Record<
  BadgeVariant,
  { bg: string; text: string }
> = {
  default: { bg: "#27272A", text: "#A1A1AA" },
  success: { bg: "#052E16", text: "#22C55E" },
  warning: { bg: "#451A03", text: "#F59E0B" },
  error: { bg: "#450A0A", text: "#EF4444" },
  info: { bg: "#0C1A2E", text: "#3B82F6" },
  shared: { bg: "#0C1A3E", text: "#60A5FA" },
  combo: { bg: "#1A0C3E", text: "#A78BFA" },
};

export function Badge({ label, variant = "default", style }: BadgeProps) {
  const { bg, text } = VARIANT_STYLES[variant];
  return (
    <View style={[styles.badge, { backgroundColor: bg }, style]}>
      <Text style={[styles.label, { color: text }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    alignSelf: "flex-start",
  },
  label: {
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
});
