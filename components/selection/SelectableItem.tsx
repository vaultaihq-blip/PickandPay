import React from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  useColorScheme,
  Pressable,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ReceiptItem as ReceiptItemType } from "@/types";
import { Badge } from "@/components/ui/Badge";
import { Colors } from "@/constants/colors";
import { formatCurrency } from "@/utils/formatter";

interface SelectableItemProps {
  item: ReceiptItemType;
  currency: string;
  selected: boolean;
  selectionColor: string;
  sharedWith?: string[];
  hasPriceVariant?: boolean;
  availableQty?: number;
  totalQty?: number;
  quantitySelected?: number;
  totalAllocatedByOthers?: number;
  onToggle: () => void;
  onShareTap?: () => void;
  onQuantityChange?: (delta: number) => void;
}

export function SelectableItem({
  item,
  currency,
  selected,
  selectionColor,
  sharedWith = [],
  hasPriceVariant = false,
  availableQty,
  totalQty,
  quantitySelected = 1,
  totalAllocatedByOthers = 0,
  onToggle,
  onShareTap,
  onQuantityChange,
}: SelectableItemProps) {
  const isDark = useColorScheme() === "dark";
  const textColor = isDark ? Colors.textPrimaryDark : Colors.textPrimaryLight;
  const mutedColor = isDark ? Colors.textMutedDark : Colors.textMutedLight;

  const isShareable = item.type === "shareable";
  const curr = currency as "EUR" | "USD" | "CAD" | "GBP";

  const maxQty = item.quantity - totalAllocatedByOthers;
  const canIncrement = selected && quantitySelected < maxQty;
  const canDecrement = selected && quantitySelected > 1;

  let displayPrice = selected ? item.unitPrice * quantitySelected : item.unitPrice;
  if (isShareable && sharedWith.length > 0) {
    displayPrice = item.totalPrice / sharedWith.length;
  }

  return (
    <TouchableOpacity
      style={[
        styles.row,
        selected && {
          borderLeftWidth: 3,
          borderLeftColor: selectionColor,
          backgroundColor: selectionColor + "18",
        },
      ]}
      onPress={isShareable ? onShareTap : onToggle}
      activeOpacity={0.7}
    >
      <View style={styles.info}>
        <View style={styles.nameRow}>
          {!isShareable && (
            <View
              style={[
                styles.checkbox,
                {
                  borderColor: selected ? selectionColor : mutedColor,
                  backgroundColor: selected ? selectionColor : "transparent",
                },
              ]}
            >
              {selected && <Ionicons name="checkmark" size={12} color="#fff" />}
            </View>
          )}
          {hasPriceVariant && (
            <Ionicons name="warning" size={14} color="#F59E0B" />
          )}
          <Text style={[styles.name, { color: textColor }]} numberOfLines={2}>
            {item.quantity > 1 ? `${item.quantity}× ` : ""}{item.name}
          </Text>
          {isShareable && <Badge label="Shared" variant="shared" />}
        </View>

        {item.notes && item.notes.length > 0 && (
          <Text style={[styles.notes, { color: mutedColor }]}>
            {item.notes.join(" · ")}
          </Text>
        )}

        {isShareable && sharedWith.length > 0 && (
          <Text style={[styles.sharedNote, { color: Colors.primary }]}>
            Shared by {sharedWith.length} people · {formatCurrency(displayPrice, curr)} each
          </Text>
        )}

        {totalQty !== undefined && totalQty > 1 && !selected && (
          <Text style={[styles.availNote, { color: mutedColor }]}>
            {availableQty !== undefined ? availableQty : totalQty} of {totalQty} available
          </Text>
        )}

        {/* Quantity selector — shown when checked for non-shareable items */}
        {selected && !isShareable && onQuantityChange && (
          <View style={styles.qtyRow}>
            <Pressable
              onPress={() => canDecrement && onQuantityChange(-1)}
              style={[styles.qtyBtn, !canDecrement && styles.qtyBtnDisabled]}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
              <Text style={[styles.qtyBtnText, { color: canDecrement ? selectionColor : mutedColor }]}>
                −
              </Text>
            </Pressable>
            <Text style={[styles.qtyCount, { color: selectionColor }]}>{quantitySelected}</Text>
            <Pressable
              onPress={() => canIncrement && onQuantityChange(1)}
              style={[styles.qtyBtn, !canIncrement && styles.qtyBtnDisabled]}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
              <Text style={[styles.qtyBtnText, { color: canIncrement ? selectionColor : mutedColor }]}>
                +
              </Text>
            </Pressable>
            {item.quantity > 1 && (
              <Text style={[styles.qtyMeta, { color: mutedColor }]}>
                {maxQty - quantitySelected > 0
                  ? `${maxQty - quantitySelected} remaining`
                  : "All taken"}
              </Text>
            )}
          </View>
        )}
      </View>

      <Text style={[styles.price, { color: selected ? selectionColor : mutedColor }]}>
        {formatCurrency(displayPrice, curr)}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 16,
    gap: 10,
  },
  info: {
    flex: 1,
    gap: 3,
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 5,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  name: {
    fontSize: 14,
    fontWeight: "500",
    flexShrink: 1,
  },
  notes: {
    fontSize: 12,
    fontStyle: "italic",
    marginLeft: 28,
  },
  sharedNote: {
    fontSize: 12,
    marginLeft: 28,
  },
  availNote: {
    fontSize: 12,
    marginLeft: 28,
    fontStyle: "italic",
  },
  qtyRow: {
    flexDirection: "row",
    alignItems: "center",
    marginLeft: 28,
    marginTop: 4,
    gap: 8,
  },
  qtyBtn: {
    width: 26,
    height: 26,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: Colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  qtyBtnDisabled: {
    borderColor: Colors.textMutedDark,
    opacity: 0.4,
  },
  qtyBtnText: {
    fontSize: 16,
    fontWeight: "700",
    lineHeight: 18,
  },
  qtyCount: {
    fontSize: 15,
    fontWeight: "800",
    minWidth: 18,
    textAlign: "center",
  },
  qtyMeta: {
    fontSize: 11,
    fontStyle: "italic",
  },
  price: {
    fontSize: 14,
    fontWeight: "600",
    minWidth: 60,
    textAlign: "right",
  },
});
