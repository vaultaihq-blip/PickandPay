import React from "react";
import { View, Text, StyleSheet, useColorScheme } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { GlobalCost, GlobalCostType } from "@/types";
import { formatCurrency } from "@/utils/formatter";
import { Colors } from "@/constants/colors";

const COST_TYPE_CONFIG: Record<GlobalCostType, { label: string; icon: string }> = {
  tax: { label: "Tax", icon: "receipt-outline" },
  service_charge: { label: "Service Charge", icon: "people-outline" },
  mandatory_service: { label: "Service (Mandatory)", icon: "lock-closed-outline" },
  delivery: { label: "Delivery", icon: "bicycle-outline" },
  bag: { label: "Bag Fee", icon: "bag-outline" },
  plastic: { label: "Plastic Fee", icon: "leaf-outline" },
  other: { label: "Other", icon: "ellipsis-horizontal-outline" },
};

interface GlobalCostsProps {
  costs: GlobalCost[];
  currency: string;
  tipAmount?: number;
}

export function GlobalCostsSection({ costs, currency, tipAmount }: GlobalCostsProps) {
  const isDark = useColorScheme() === "dark";
  const textColor = isDark ? Colors.textPrimaryDark : Colors.textPrimaryLight;
  const mutedColor = isDark ? Colors.textMutedDark : Colors.textMutedLight;
  const borderColor = isDark ? Colors.cardBorderDark : Colors.cardBorderLight;

  const allCosts = [
    ...costs,
    ...(tipAmount
      ? [
          {
            id: "tip",
            name: "Tip",
            amount: tipAmount,
            type: "other" as GlobalCostType,
            splitByAll: true as const,
            editable: false,
            status: "included" as const,
          },
        ]
      : []),
  ];

  if (allCosts.length === 0) return null;

  return (
    <View style={styles.section}>
      <View style={styles.header}>
        <View style={[styles.iconBg, { backgroundColor: Colors.primary + "22" }]}>
          <Ionicons name="calculator-outline" size={16} color={Colors.primary} />
        </View>
        <Text style={[styles.sectionLabel, { color: textColor }]}>
          SHARED COSTS
        </Text>
        <Text style={[styles.splitNote, { color: mutedColor }]}>
          Split equally
        </Text>
      </View>

      {allCosts.map((cost, index) => {
        const config = COST_TYPE_CONFIG[cost.type];
        return (
          <View key={cost.id}>
            <View style={styles.row}>
              <Ionicons
                name={config.icon as keyof typeof Ionicons.glyphMap}
                size={14}
                color={mutedColor}
              />
              <Text style={[styles.costName, { color: textColor }]}>
                {cost.name}
              </Text>
              {cost.status === "mandatory" && (
                <Ionicons name="lock-closed" size={10} color={mutedColor} />
              )}
              <Text style={[styles.costAmount, { color: textColor }]}>
                {formatCurrency(cost.amount, currency as "EUR" | "USD" | "CAD" | "GBP")}
              </Text>
            </View>
            {index < allCosts.length - 1 && (
              <View style={[styles.divider, { backgroundColor: borderColor }]} />
            )}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginBottom: 8,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
  },
  iconBg: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  sectionLabel: {
    flex: 1,
    fontSize: 14,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  splitNote: {
    fontSize: 12,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
  },
  costName: {
    flex: 1,
    fontSize: 14,
  },
  costAmount: {
    fontSize: 14,
    fontWeight: "600",
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginHorizontal: 16,
  },
});
