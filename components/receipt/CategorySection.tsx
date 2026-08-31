import React, { useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, useColorScheme } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ReceiptItem as ReceiptItemType, ItemCategory } from "@/types";
import { ReceiptItemRow } from "./ReceiptItem";
import { Colors } from "@/constants/colors";
import { useI18nStore } from "@/store/i18nStore";
import { TranslationKey } from "@/constants/translations";
import { formatCurrency } from "@/utils/formatter";

const CATEGORY_CONFIG: Record<
  ItemCategory,
  { labelKey: TranslationKey; emoji: string; icon: string; color: string }
> = {
  starters: {
    labelKey: "lobby_cat_starters",
    emoji: "🥗",
    icon: "leaf-outline",
    color: Colors.starters,
  },
  mains: {
    labelKey: "lobby_cat_mains",
    emoji: "🍔",
    icon: "restaurant-outline",
    color: Colors.mains,
  },
  drinks: {
    labelKey: "lobby_cat_drinks",
    emoji: "🍺",
    icon: "wine-outline",
    color: Colors.drinks,
  },
  desserts: {
    labelKey: "lobby_cat_desserts",
    emoji: "🍰",
    icon: "ice-cream-outline",
    color: Colors.desserts,
  },
  others: {
    labelKey: "lobby_cat_others",
    emoji: "📋",
    icon: "ellipsis-horizontal-circle-outline",
    color: Colors.others,
  },
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
  const cardBorder = isDark ? Colors.cardBorderDark : Colors.cardBorderLight;
  const { t, language } = useI18nStore();
  void language;

  const { labelKey, emoji, icon, color } = CATEGORY_CONFIG[category];
  const label = t(labelKey);

  if (items.length === 0) return null;

  const categoryTotal = items.reduce((sum, item) => sum + item.totalPrice, 0);
  const curr = currency as "EUR" | "USD" | "CAD" | "GBP";

  return (
    <View style={styles.section}>
      {/* Category header — tappable to expand/collapse */}
      <TouchableOpacity
        style={[styles.header, { borderBottomColor: cardBorder }]}
        onPress={() => setExpanded(!expanded)}
        activeOpacity={0.7}
      >
        {/* Emoji + icon pill */}
        <View style={[styles.iconPill, { backgroundColor: color + "20" }]}>
          <Text style={styles.emoji}>{emoji}</Text>
        </View>

        {/* Label + item count */}
        <View style={styles.labelBlock}>
          <Text style={[styles.categoryLabel, { color }]}>{label}</Text>
          <Text style={[styles.itemCount, { color: mutedColor }]}>
            {items.length} {items.length === 1 ? "item" : "items"}
          </Text>
        </View>

        {/* Category subtotal */}
        <Text style={[styles.categoryTotal, { color }]}>
          {formatCurrency(categoryTotal, curr)}
        </Text>

        {/* Expand chevron */}
        <Ionicons
          name={expanded ? "chevron-up" : "chevron-down"}
          size={16}
          color={mutedColor}
          style={{ marginLeft: 2 }}
        />
      </TouchableOpacity>

      {/* Items list */}
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
                    { backgroundColor: cardBorder },
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
    marginBottom: 4,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  iconPill: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  emoji: {
    fontSize: 18,
    lineHeight: 22,
  },
  labelBlock: {
    flex: 1,
    gap: 1,
  },
  categoryLabel: {
    fontSize: 13,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  itemCount: {
    fontSize: 11,
    fontWeight: "500",
  },
  categoryTotal: {
    fontSize: 14,
    fontWeight: "700",
  },
  items: {},
  divider: {
    height: StyleSheet.hairlineWidth,
    marginHorizontal: 16,
  },
});
