import React from "react";
import { View, ViewStyle, StyleSheet, useColorScheme } from "react-native";
import { Colors } from "@/constants/colors";

interface CardProps {
  children: React.ReactNode;
  style?: ViewStyle;
  padding?: number;
  elevated?: boolean;
}

export function Card({ children, style, padding = 16, elevated = false }: CardProps) {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: isDark ? Colors.cardDark : Colors.cardLight,
          borderColor: isDark ? Colors.cardBorderDark : Colors.cardBorderLight,
          padding,
        },
        elevated && (isDark ? styles.elevatedDark : styles.elevatedLight),
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 16,
    borderWidth: 1,
  },
  elevatedDark: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  elevatedLight: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 4,
  },
});
