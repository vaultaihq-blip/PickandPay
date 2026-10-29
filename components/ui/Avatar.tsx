import React from "react";
import { View, Text, Image, StyleSheet, Platform } from "react-native";
import { getAvatarEmoji } from "@/constants/avatars";

interface AvatarProps {
  name?: string;
  avatarIcon?: string;
  avatarUrl?: string;
  color?: string;
  // R4b — with a second colour the ring is split in half: color on the left,
  // color2 on the right.
  color2?: string;
  size?: number;
}

const RING = 2.5;
const SPLIT_SURFACE = "#0B0D10";

export const Avatar = React.memo(function Avatar({
  name = "?",
  avatarIcon,
  avatarUrl,
  color = "#6366F1",
  color2,
  size = 40,
}: AvatarProps) {
  if (color2) {
    const inner = size - RING * 2;
    return (
      <View style={[styles.split, { width: size, height: size, borderRadius: size / 2 }]}>
        <View style={{ flex: 1, backgroundColor: color }} />
        <View style={{ flex: 1, backgroundColor: color2 }} />
        <View style={[styles.splitInner, { top: RING, left: RING, width: inner, height: inner, borderRadius: inner / 2 }]}>
          {!avatarUrl && (
            <View style={[StyleSheet.absoluteFill, styles.split]}>
              <View style={{ flex: 1, backgroundColor: color + "22" }} />
              <View style={{ flex: 1, backgroundColor: color2 + "22" }} />
            </View>
          )}
          <AvatarContent name={name} avatarIcon={avatarIcon} avatarUrl={avatarUrl} size={inner} />
        </View>
      </View>
    );
  }

  const borderRadius = size / 2;

  if (avatarUrl) {
    return (
      <View
        style={[
          styles.avatar,
          { width: size, height: size, borderRadius, borderColor: color },
        ]}
      >
        <AvatarContent name={name} avatarUrl={avatarUrl} size={size} />
      </View>
    );
  }

  return (
    <View
      style={[
        styles.avatar,
        styles.centered,
        {
          width: size,
          height: size,
          borderRadius,
          backgroundColor: color + "22",
          borderColor: color,
        },
      ]}
    >
      <AvatarContent name={name} avatarIcon={avatarIcon} size={size} />
    </View>
  );
});

function AvatarContent({ name, avatarIcon, avatarUrl, size }: { name: string; avatarIcon?: string; avatarUrl?: string; size: number }) {
  if (avatarUrl) {
    return (
      <Image
        source={{ uri: avatarUrl }}
        style={{ width: "100%", height: "100%", borderRadius: size / 2 - 2 }}
        fadeDuration={Platform.OS === "android" ? 0 : undefined}
      />
    );
  }
  if (avatarIcon) {
    return <Text style={{ fontSize: size * 0.5 }}>{getAvatarEmoji(avatarIcon)}</Text>;
  }
  const fallbackName = name.trim() || "?";
  const initials = fallbackName
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2) || "?";
  return <Text style={[styles.initials, { fontSize: size * 0.35 }]}>{initials}</Text>;
}

const styles = StyleSheet.create({
  avatar: {
    overflow: "hidden",
    borderWidth: RING,
  },
  centered: {
    alignItems: "center",
    justifyContent: "center",
  },
  split: {
    overflow: "hidden",
    flexDirection: "row",
  },
  splitInner: {
    position: "absolute",
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: SPLIT_SURFACE,
  },
  initials: {
    color: "#FFFFFF",
    fontWeight: "700",
  },
});
