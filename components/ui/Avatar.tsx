import React from "react";
import { View, Text, Image, StyleSheet } from "react-native";
import { getAvatarEmoji } from "@/constants/avatars";

interface AvatarProps {
  name?: string;
  avatarIcon?: string;
  avatarUrl?: string;
  color?: string;
  size?: number;
}

export function Avatar({
  name = "?",
  avatarIcon,
  avatarUrl,
  color = "#6366F1",
  size = 40,
}: AvatarProps) {
  const borderRadius = size / 2;

  if (avatarUrl) {
    return (
      <Image
        source={{ uri: avatarUrl }}
        style={[styles.avatar, { width: size, height: size, borderRadius }]}
      />
    );
  }

  if (avatarIcon) {
    const emoji = getAvatarEmoji(avatarIcon);
    return (
      <View
        style={[
          styles.avatar,
          styles.emojiContainer,
          { width: size, height: size, borderRadius, backgroundColor: color + "33" },
        ]}
      >
        <Text style={{ fontSize: size * 0.5 }}>{emoji}</Text>
      </View>
    );
  }

  const fallbackName = name.trim() || "?";
  const initials = fallbackName
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2) || "?";

  return (
    <View
      style={[
        styles.avatar,
        styles.initialsContainer,
        { width: size, height: size, borderRadius, backgroundColor: color },
      ]}
    >
      <Text style={[styles.initials, { fontSize: size * 0.35 }]}>
        {initials}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: {
    overflow: "hidden",
  },
  emojiContainer: {
    alignItems: "center",
    justifyContent: "center",
  },
  initialsContainer: {
    alignItems: "center",
    justifyContent: "center",
  },
  initials: {
    color: "#FFFFFF",
    fontWeight: "700",
  },
});
