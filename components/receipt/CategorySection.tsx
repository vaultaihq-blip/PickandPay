import React, { useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, useColorScheme } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ReceiptItem as ReceiptItemType, ItemCategory } from "@/types";
import { ReceiptItemRow } from "./ReceiptItem";
import { Colors } from "@/constants/colors";

const CATEGORY_CONFIG: Record<
  ItemCategory,
  { label: string; icon: string; color: string }
> = {
  starters: { label: "Starters", icon: "leaf-outline", color: Colors.starters },
  mains: { label: "Mains", icon: "restaurant-outline", color: Colors.mains },
  drinks: { label: "Drinks", icon: "wine-outline", color: Colors.drinks },
  desserts: { label: "Desserts", icon: "ice-cream-outline", color: Colors.desserts },
  others: { label: "Others", icon: "ellipsis-horizontal-circle-outline", color: Colors.others },
};

interface CategorySectionProps {
  category: ItemCategory;
  items: ReceiptItemType[];
  currency: string;
  defaultExpanded?: boolean;
  onItemPress?: (item: ReceiptItemType) => void;
  selectable?: boolean;
  selectedIds?: Set<string>;
  selectionColor?: string;
  groupingCandidateIds?: Set<string>;
  groupingCheckedIds?: Set<string>;
  onGroupingToggle?: (itemId: string) => void;
  showEditIcon?: boolean;
  mathErrorItemIds?: Set<string>;
}

export function CategorySection({
  category,
  items,
  currency,
  defaultExpanded = true,
  onItemPress,
  selectable = false,
  selectedIds,
  selectionColor,
  groupingCandidateIds,
  groupingCheckedIds,
  onGroupingToggle,
  showEditIcon = false,
  mathErrorItemIds,
}: CategorySectionProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const isDark = useColorScheme() === "dark";
  const textColor = isDark ? Colors.textPrimaryDark : Colors.textPrimaryLight;
  const mutedColor = isDark ? Colors.textMutedDark : Colors.textMutedLight;
  const { label, icon, color } = CATEGORY_CONFIG[category];

  if (items.length === 0) return null;

  const categoryTotal = items.reduce((sum, item) => sum + item.totalPrice, 0);

  return (
    <View style={styles.section}>
      <TouchableOpacity
        style={styles.header}
        onPress={() => setExpanded(!expanded)}
        activeOpacity={0.7}
      >
        <View style={[styles.iconBg, { backgroundColor: color + "22" }]}>
          <Ionicons name={icon as keyof typeof Ionicons.glyphMap} size={16} color={color} />
        </View>
        <Text style={[styles.categoryLabel, { color: textColor }]}>
          {label}
        </Text>
        <View style={styles.countBadge}>
          <Text style={[styles.countText, { color: mutedColor }]}>
            {items.length}
          </Text>
        </View>
        <Ionicons
          name={expanded ? "chevron-up" : "chevron-down"}
          size={16}
          color={mutedColor}
        />
      </TouchableOpacity>

      {expanded && (
        <View style={styles.items}>
          {items.map((item, index) => (
            <View key={item.id}>
              <ReceiptItemRow
                item={item}
                currency={currency}
                onPress={() => onItemPress?.(item)}
                selectable={selectable}
                selected={selectedIds?.has(item.id) ?? false}
                selectionColor={selectionColor}
                isGroupingCandidate={groupingCandidateIds?.has(item.id) ?? false}
                groupingChecked={groupingCheckedIds?.has(item.id) ?? false}
                onGroupingToggle={() => onGroupingToggle?.(item.id)}
                showEditIcon={showEditIcon}
                hasMathError={mathErrorItemIds?.has(item.id) ?? false}
              />
              {index < items.length - 1 && (
                <View
                  style={[
                    styles.divider,
                    {
                      backgroundColor: isDark
                        ? Colors.cardBorderDark
                        : Colors.cardBorderLight,
                    },
                  ]}
                />
              )}
            </View>
          ))}
        </View>
      )}
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
  categoryLabel: {
    flex: 1,
    fontSize: 14,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  countBadge: {
    backgroundColor: "#27272A",
    borderRadius: 8,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  countText: {
    fontSize: 11,
    fontWeight: "600",
  },
  items: {},
  divider: {
    height: StyleSheet.hairlineWidth,
    marginHorizontal: 16,
  },
});
