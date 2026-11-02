import React from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";

// R12 — a person on an item: a circle with their initials in their colour
// (R4; from the 9th person on, the R4b half circle). The user's own reads
// "Tu". Pending: faded; rejected: with an X.

/** none: not on the item (in the share window, someone who can be asked). */
export type DotState = "confirmed" | "pending" | "rejected" | "none";

export interface DotPerson {
  userId: string;
  name: string;
  initials: string;
  color: string;
  color2?: string;
  isMe: boolean;
  state: DotState;
}

const SURFACE = "#0B0D10";

export function PersonDot({ person, label, size = 26 }: { person: DotPerson; label?: string; size?: number }) {
  const text = label ?? person.initials;
  return (
    <View style={{ width: size, height: size, opacity: person.state === "pending" ? 0.35 : 1 }}>
      <View style={[styles.circle, { width: size, height: size, borderRadius: size / 2, backgroundColor: person.color }]}>
        {person.color2 ? (
          <View style={[StyleSheet.absoluteFill, styles.halves]}>
            <View style={{ flex: 1, backgroundColor: person.color }} />
            <View style={{ flex: 1, backgroundColor: person.color2 }} />
          </View>
        ) : null}
        <Text
          style={[styles.initials, { fontSize: text.length > 2 ? size * 0.3 : size * 0.4 }]}
          numberOfLines={1}
          allowFontScaling={false}
        >
          {text}
        </Text>
      </View>
      {person.state === "rejected" && (
        <View style={[styles.reject, { right: -3, top: -3 }]}>
          <Text style={styles.rejectText} allowFontScaling={false}>×</Text>
        </View>
      )}
    </View>
  );
}

/** Up to 3 circles and "+N"; tapping the zone shows the names. */
export function PersonDots({
  people,
  youLabel,
  onPress,
}: {
  people: DotPerson[];
  youLabel: string;
  onPress: () => void;
}) {
  if (people.length === 0) return null;
  const shown = people.slice(0, 3);
  return (
    <Pressable
      onPress={onPress}
      style={styles.zone}
      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
      accessibilityRole="button"
      accessibilityLabel={people.map((p) => (p.isMe ? youLabel : p.name)).join(", ")}
    >
      {shown.map((p, i) => (
        <View key={p.userId} style={[styles.stackItem, { marginLeft: i > 0 ? -6 : 0, zIndex: 10 - i }]}>
          <PersonDot person={p} label={p.isMe ? youLabel : undefined} />
        </View>
      ))}
      {people.length > 3 && (
        <View style={[styles.more, { marginLeft: -6 }]}>
          <Text style={styles.moreText} allowFontScaling={false}>+{people.length - 3}</Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  circle: {
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    borderWidth: 1.5,
    borderColor: SURFACE,
  },
  halves: {
    flexDirection: "row",
  },
  initials: {
    color: "#FFFFFF",
    fontWeight: "800",
    textShadowColor: "rgba(0,0,0,0.35)",
    textShadowRadius: 2,
  },
  reject: {
    position: "absolute",
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: "#EF4444",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: SURFACE,
  },
  rejectText: {
    color: "#FFFFFF",
    fontSize: 11,
    fontWeight: "900",
    lineHeight: 12,
  },
  zone: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 44,
    minWidth: 44,
    justifyContent: "flex-end",
  },
  stackItem: {
    borderRadius: 13,
  },
  more: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: "#374151",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: SURFACE,
  },
  moreText: {
    color: "#FFFFFF",
    fontSize: 10,
    fontWeight: "800",
  },
});
