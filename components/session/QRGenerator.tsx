import React from "react";
import { View, StyleSheet, useColorScheme } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { Colors } from "@/constants/colors";

interface QRGeneratorProps {
  value: string;
  size?: number;
}

export function QRGenerator({ value, size = 220 }: QRGeneratorProps) {
  const isDark = useColorScheme() === "dark";
  const bgColor = isDark ? "#FFFFFF" : "#FFFFFF";
  const fgColor = isDark ? "#111111" : "#111111";

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: "#FFFFFF",
          padding: 16,
          borderRadius: 16,
          shadowColor: Colors.primary,
          shadowOffset: { width: 0, height: 0 },
          shadowOpacity: 0.2,
          shadowRadius: 16,
          elevation: 8,
        },
      ]}
    >
      <QRCode
        value={value}
        size={size}
        color={fgColor}
        backgroundColor={bgColor}
        quietZone={0}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignSelf: "center",
  },
});
