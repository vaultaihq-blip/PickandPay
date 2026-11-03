import React from "react";
import { Pressable, StyleSheet, Text } from "react-native";
import { Colors } from "@/constants/colors";

// C3 (03-11-2026) — the − / + of a quantity: at least 48×48 to touch (a 40×40
// box plus 4 px all round), on the app and the web. Used in "Pick your items"
// and in the R10 correction panel.
type Props = {
  label: "−" | "+";
  onPress: () => void;
  disabled?: boolean;
  color: string;
  mutedColor: string;
  accessibilityLabel: string;
};

export function StepperButton({ label, onPress, disabled = false, color, mutedColor, accessibilityLabel }: Props) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        styles.btn,
        { borderColor: disabled ? mutedColor : color },
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
      ]}
    >
      <Text style={[styles.text, { color: disabled ? mutedColor : color }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    width: 40,
    height: 40,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: Colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.6 },
  text: { fontSize: 22, fontWeight: "700", lineHeight: 24 },
});
