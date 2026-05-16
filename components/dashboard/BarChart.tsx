import React, { useEffect } from "react";
import { View, Text, StyleSheet, useColorScheme } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  Easing,
} from "react-native-reanimated";
import { SessionParticipant, SplitResult } from "@/types";
import { Colors } from "@/constants/colors";
import { formatCurrency } from "@/utils/formatter";
import { Avatar } from "@/components/ui/Avatar";

interface BarChartProps {
  participants: SessionParticipant[];
  currency: string;
  splitResults?: Map<string, SplitResult>;
}

interface BarProps {
  participant: SessionParticipant;
  currency: string;
  ratio: number;
  itemsAmount: number;
  tipAmount: number;
}

function Bar({ participant, currency, ratio, itemsAmount, tipAmount }: BarProps) {
  const isDark = useColorScheme() === "dark";
  const textColor = isDark ? Colors.textPrimaryDark : Colors.textPrimaryLight;
  const mutedColor = isDark ? Colors.textMutedDark : Colors.textMutedLight;
  const widthPct = useSharedValue(0);

  useEffect(() => {
    widthPct.value = withTiming(ratio * 100, {
      duration: 600,
      easing: Easing.out(Easing.exp),
    });
  }, [ratio, widthPct]);

  // Reanimated v2 supports animating 'width' via its own worklet engine
  // (distinct from the old Animated module which does not support layout props)
  const animStyle = useAnimatedStyle(() => ({
    width: `${widthPct.value}%` as any,
  }));

  const curr = currency as "EUR" | "USD" | "CAD" | "GBP";
  const total = itemsAmount + tipAmount;
  const itemsFlex = total > 0 ? itemsAmount / total : 1;
  const tipFlex = total > 0 ? tipAmount / total : 0;

  const amountLabel =
    tipAmount > 0
      ? `${formatCurrency(itemsAmount, curr)} + (Tip ${formatCurrency(tipAmount, curr)}) = Total: ${formatCurrency(total, curr)}`
      : `Total: ${formatCurrency(total, curr)}`;

  return (
    <View style={styles.barBlock}>
      {/* Label row: avatar + name left, breakdown right */}
      <View style={styles.labelRow}>
        <Avatar
          name={participant.profile.name}
          avatarIcon={participant.profile.avatarIcon}
          avatarUrl={participant.profile.avatarUrl}
          color={participant.profile.color}
          size={24}
        />
        <Text style={[styles.personName, { color: textColor }]} numberOfLines={1}>
          {participant.profile.name}
        </Text>
        <Text style={[styles.amountBreakdown, { color: mutedColor }]} numberOfLines={1}>
          {amountLabel}
        </Text>
      </View>
      {/* Stacked bar */}
      <View style={styles.barTrack}>
        <Animated.View style={[styles.barFill, animStyle]}>
          <View
            style={[
              styles.barSegment,
              { flex: itemsFlex, backgroundColor: "#3B82F6" },
            ]}
          />
          {tipFlex > 0 && (
            <View
              style={[styles.barSegment, styles.barSegmentTip, { flex: tipFlex }]}
            />
          )}
        </Animated.View>
      </View>
    </View>
  );
}

export function BarChart({ participants, currency, splitResults }: BarChartProps) {
  const isDark = useColorScheme() === "dark";
  const mutedColor = isDark ? Colors.textMutedDark : Colors.textMutedLight;

  const maxAmount = Math.max(...participants.map((p) => p.totalOwed), 0.01);
  const hasTip = participants.some(
    (p) => (splitResults?.get(p.userId)?.tipShare ?? 0) > 0
  );

  if (participants.length === 0) return null;

  const sorted = participants.slice().sort((a, b) => b.totalOwed - a.totalOwed);

  return (
    <View style={styles.container}>
      <View style={styles.titleRow}>
        <Text style={[styles.title, { color: mutedColor }]}>AMOUNTS OWED</Text>
        {hasTip && (
          <View style={styles.legend}>
            <View style={[styles.legendDot, { backgroundColor: "#3B82F6" }]} />
            <Text style={[styles.legendText, { color: mutedColor }]}>Items</Text>
            <View style={[styles.legendDot, { backgroundColor: Colors.success }]} />
            <Text style={[styles.legendText, { color: mutedColor }]}>Tip</Text>
          </View>
        )}
      </View>
      {sorted.map((p) => {
        const tipAmount = splitResults?.get(p.userId)?.tipShare ?? 0;
        const itemsAmount = Math.max(p.totalOwed - tipAmount, 0);
        return (
          <Bar
            key={p.userId}
            participant={p}
            currency={currency}
            ratio={maxAmount > 0 ? p.totalOwed / maxAmount : 0}
            itemsAmount={itemsAmount}
            tipAmount={tipAmount}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  title: {
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  legend: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  legendDot: {
    width: 10,
    height: 10,
    borderRadius: 3,
  },
  legendText: {
    fontSize: 11,
    fontWeight: "500",
    marginRight: 4,
  },
  barBlock: {
    gap: 5,
  },
  labelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  personName: {
    fontSize: 14,
    fontWeight: "600",
    flexShrink: 1,
  },
  amountBreakdown: {
    fontSize: 12,
    fontWeight: "600",
    textAlign: "right",
    flexShrink: 0,
  },
  barTrack: {
    flex: 1,
    height: 36,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderRadius: 8,
    overflow: "hidden",
  },
  barFill: {
    height: "100%",
    flexDirection: "row",
    borderRadius: 8,
    overflow: "hidden",
    minWidth: 8,
  },
  barSegment: {
    height: "100%",
  },
  barSegmentTip: {
    backgroundColor: Colors.success,
  },
});
