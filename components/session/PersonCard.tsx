import React from "react";
import { View, Text, StyleSheet, useColorScheme } from "react-native";
import { SessionParticipant } from "@/types";
import { Avatar } from "@/components/ui/Avatar";
import { Colors } from "@/constants/colors";
import { formatCurrency } from "@/utils/formatter";

interface PersonCardProps {
  participant: SessionParticipant;
  currency?: string;
  showAmount?: boolean;
  isCreator?: boolean;
  compact?: boolean;
}

export function PersonCard({
  participant,
  currency = "EUR",
  showAmount = false,
  isCreator = false,
  compact = false,
}: PersonCardProps) {
  const { profile, totalOwed, paid } = participant;
  const isDark = useColorScheme() === "dark";
  const textColor = isDark ? Colors.textPrimaryDark : Colors.textPrimaryLight;
  const mutedColor = isDark ? Colors.textMutedDark : Colors.textMutedLight;

  if (compact) {
    return (
      <View style={styles.compact}>
        <Avatar
          name={profile.name}
          avatarIcon={profile.avatarIcon}
          avatarUrl={profile.avatarUrl}
          color={profile.color}
          size={32}
        />
        <Text style={[styles.compactName, { color: textColor }]} numberOfLines={1}>
          {profile.name}
        </Text>
      </View>
    );
  }

  return (
    <View
      style={[
        styles.card,
        {
          borderLeftWidth: 3,
          borderLeftColor: profile.color,
        },
      ]}
    >
      <Avatar
        name={profile.name}
        avatarIcon={profile.avatarIcon}
        avatarUrl={profile.avatarUrl}
        color={profile.color}
        size={40}
      />
      <View style={styles.info}>
        <View style={styles.nameRow}>
          <Text style={[styles.name, { color: textColor }]} numberOfLines={1}>
            {profile.name}
          </Text>
          {isCreator && (
            <View style={styles.creatorBadge}>
              <Text style={styles.creatorText}>Host</Text>
            </View>
          )}
        </View>
        {showAmount && (
          <Text style={[styles.amount, { color: mutedColor }]}>
            {formatCurrency(totalOwed, currency as "EUR" | "USD" | "CAD" | "GBP")}
          </Text>
        )}
      </View>
      {paid && (
        <View style={styles.paidBadge}>
          <Text style={styles.paidText}>Paid</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 16,
    gap: 12,
  },
  info: {
    flex: 1,
    gap: 2,
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  name: {
    fontSize: 15,
    fontWeight: "600",
  },
  amount: {
    fontSize: 13,
  },
  creatorBadge: {
    backgroundColor: Colors.primary + "33",
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  creatorText: {
    color: Colors.primary,
    fontSize: 11,
    fontWeight: "600",
  },
  paidBadge: {
    backgroundColor: Colors.success + "22",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  paidText: {
    color: Colors.success,
    fontSize: 12,
    fontWeight: "600",
  },
  compact: {
    alignItems: "center",
    gap: 4,
    maxWidth: 60,
  },
  compactName: {
    fontSize: 11,
    textAlign: "center",
  },
});
