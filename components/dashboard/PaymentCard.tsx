import React from "react";
import { View, Text, TouchableOpacity, StyleSheet, useColorScheme } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SessionParticipant } from "@/types";
import { Avatar } from "@/components/ui/Avatar";
import { Colors } from "@/constants/colors";
import { formatCurrency } from "@/utils/formatter";

interface PaymentCardProps {
  participant: SessionParticipant;
  currency: string;
  isCreator: boolean;
  canMarkPaid: boolean;
  onMarkPaid: (paid: boolean) => void;
}

export function PaymentCard({
  participant,
  currency,
  isCreator,
  canMarkPaid,
  onMarkPaid,
}: PaymentCardProps) {
  const { profile, totalOwed, paid } = participant;
  const isDark = useColorScheme() === "dark";
  const textColor = isDark ? Colors.textPrimaryDark : Colors.textPrimaryLight;
  const mutedColor = isDark ? Colors.textMutedDark : Colors.textMutedLight;
  const cardColor = isDark ? Colors.cardDark : Colors.cardLight;
  const borderColor = isDark ? Colors.cardBorderDark : Colors.cardBorderLight;

  const curr = currency as "EUR" | "USD" | "CAD" | "GBP";

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: cardColor,
          borderColor: paid ? Colors.success + "44" : borderColor,
          borderWidth: paid ? 1.5 : 1,
        },
      ]}
    >
      {/* Left accent */}
      <View style={[styles.accent, { backgroundColor: profile.color }]} />

      <View style={styles.content}>
        <View style={styles.header}>
          <Avatar
            name={profile.name}
            avatarIcon={profile.avatarIcon}
            avatarUrl={profile.avatarUrl}
            color={profile.color}
            size={40}
          />
          <View style={styles.nameSection}>
            <Text style={[styles.name, { color: textColor }]}>
              {profile.name}
            </Text>
            <Text style={[styles.amount, { color: profile.color }]}>
              {formatCurrency(totalOwed, curr)}
            </Text>
          </View>
          {paid && (
            <View style={styles.paidIcon}>
              <Ionicons name="checkmark-circle" size={28} color={Colors.success} />
            </View>
          )}
        </View>

        {/* Action button */}
        {canMarkPaid && (
          <TouchableOpacity
            style={[
              styles.actionBtn,
              {
                backgroundColor: paid
                  ? Colors.success + "22"
                  : Colors.primary,
              },
            ]}
            onPress={() => onMarkPaid(!paid)}
            activeOpacity={0.8}
          >
            <Ionicons
              name={paid ? "close-circle-outline" : "checkmark-circle-outline"}
              size={18}
              color={paid ? Colors.success : "#fff"}
            />
            <Text
              style={[
                styles.actionText,
                { color: paid ? Colors.success : "#fff" },
              ]}
            >
              {paid ? "Unmark Paid" : "Mark as Paid"}
            </Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: "row",
    overflow: "hidden",
    marginHorizontal: 16,
    marginBottom: 10,
  },
  accent: {
    width: 4,
  },
  content: {
    flex: 1,
    padding: 14,
    gap: 12,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  nameSection: {
    flex: 1,
    gap: 2,
  },
  name: {
    fontSize: 15,
    fontWeight: "600",
  },
  amount: {
    fontSize: 20,
    fontWeight: "700",
  },
  paidIcon: {
    padding: 4,
  },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 10,
    borderRadius: 10,
    gap: 6,
  },
  actionText: {
    fontSize: 14,
    fontWeight: "600",
  },
});
