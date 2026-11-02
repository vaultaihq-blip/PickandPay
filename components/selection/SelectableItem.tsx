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
import { Avatar } from "@/components/ui/Avatar";

export interface SelectorInfo {
  userId: string;
  name: string;
  avatarIcon?: string;
  avatarUrl?: string;
  color: string;
  color2?: string;
  isMe: boolean;
}

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
  claimableQty?: number;
  totalAllocatedByOthers?: number;
  selectors?: SelectorInfo[];
  hidePrices?: boolean;
  onToggle: () => void;
  onShareTap?: () => void;
  onQuantityChange?: (delta: number) => void;
  /** R12 — units decided by the server: no local share flow, no "+N others" notes. */
  live?: boolean;
  /** R12 — who is on this item, at the far right of the row. */
  dots?: React.ReactNode;
  /** R12 — "1 de 2 livre" on items with more than one unit. */
  freeLabel?: string;
  /** R12 — a share request for this item is waiting for this user. */
  requestLabel?: string;
  onRequestPress?: () => void;
  shareLabel?: string;
  onSharePress?: () => void;
  busy?: boolean;
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
  claimableQty,
  totalAllocatedByOthers = 0,
  selectors,
  hidePrices = false,
  onToggle,
  onShareTap,
  onQuantityChange,
  live = false,
  dots,
  freeLabel,
  requestLabel,
  onRequestPress,
  shareLabel,
  onSharePress,
  busy = false,
}: SelectableItemProps) {
  const isDark = useColorScheme() === "dark";
  const textColor = isDark ? Colors.textPrimaryDark : Colors.textPrimaryLight;
  const mutedColor = isDark ? Colors.textMutedDark : Colors.textMutedLight;

  const isShareable = item.type === "shareable" && !live;
  const curr = currency as "EUR" | "USD" | "CAD" | "GBP";

  const maxQty = claimableQty ?? item.quantity;
  const canIncrement = selected && quantitySelected < maxQty;
  const canDecrement = selected && quantitySelected > 1;

  // For multi-unit items, show proportional price based on sharing
  const totalSelected = quantitySelected + totalAllocatedByOthers;
  let displayPrice = selected ? item.unitPrice * quantitySelected : item.unitPrice;
  if (selected && item.quantity > 1 && !isShareable && totalAllocatedByOthers > 0) {
    displayPrice = (quantitySelected / totalSelected) * item.totalPrice;
  }
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
      onPress={busy ? undefined : isShareable ? onShareTap : onToggle}
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

        {!live && item.quantity > 1 && !selected && totalAllocatedByOthers > 0 && (
          <Text style={[styles.availNote, { color: mutedColor }]}>
            {totalAllocatedByOthers} selected by others · tap to share
          </Text>
        )}

        {freeLabel ? (
          <Text style={[styles.availNote, { color: mutedColor, fontStyle: "normal" }]}>{freeLabel}</Text>
        ) : null}

        {requestLabel && onRequestPress ? (
          <Pressable onPress={onRequestPress} style={styles.requestPill} hitSlop={{ top: 8, bottom: 8 }}>
            <Ionicons name="people" size={13} color="#F59E0B" />
            <Text style={styles.requestPillText}>{requestLabel}</Text>
          </Pressable>
        ) : null}

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
            {!live && maxQty > 1 && (
              <Text style={[styles.qtyMeta, { color: mutedColor }]}>
                {quantitySelected}/{maxQty}
                {totalAllocatedByOthers > 0 ? ` · +${totalAllocatedByOthers} others` : ""}
              </Text>
            )}
          </View>
        )}

        {shareLabel && onSharePress ? (
          <Pressable onPress={onSharePress} style={styles.shareBtn} hitSlop={{ top: 6, bottom: 6 }} accessibilityRole="button">
            <Ionicons name="person-add-outline" size={14} color={Colors.primary} />
            <Text style={[styles.shareBtnText, { color: Colors.primary }]}>{shareLabel}</Text>
          </Pressable>
        ) : null}
      </View>

      {dots ? <View style={styles.dotsCol}>{dots}</View> : null}

      <View style={styles.rightCol}>
        {!hidePrices && (
          <Text style={[styles.price, { color: selected ? selectionColor : mutedColor }]}>
            {formatCurrency(displayPrice, curr)}
          </Text>
        )}
        {!hidePrices && selectors && selectors.length > 0 && (
          <View style={styles.selectorCluster}>
            {selectors.length === 1 && selectors[0].isMe ? (
              <View style={[styles.selectorCheck, { backgroundColor: "#22C55E" }]}>
                <Ionicons name="checkmark" size={13} color="#fff" />
              </View>
            ) : (
              <View style={styles.selectorStack}>
                {selectors.slice(0, 3).map((s, i) => (
                  <View
                    key={s.userId}
                    style={[styles.selectorAvatar, { marginLeft: i > 0 ? -8 : 0, zIndex: 10 - i }]}
                  >
                    <Avatar
                      name={s.name}
                      avatarIcon={s.avatarIcon}
                      avatarUrl={s.avatarUrl}
                      color={s.color}
                      color2={s.color2}
                      size={22}
                    />
                  </View>
                ))}
                {selectors.length > 3 && (
                  <View style={[styles.selectorOverflow, { marginLeft: -8 }]}>
                    <Text style={styles.selectorOverflowText}>+{selectors.length - 3}</Text>
                  </View>
                )}
              </View>
            )}
          </View>
        )}
      </View>
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
  rightCol: {
    alignItems: "flex-end",
    gap: 4,
  },
  dotsCol: {
    alignItems: "flex-end",
    justifyContent: "center",
  },
  requestPill: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 5,
    marginLeft: 28,
    marginTop: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 10,
    backgroundColor: "rgba(245,158,11,0.15)",
  },
  requestPillText: {
    color: "#F59E0B",
    fontSize: 12,
    fontWeight: "700",
  },
  shareBtn: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 4,
    marginLeft: 28,
    marginTop: 4,
    minHeight: 32,
    paddingHorizontal: 6,
  },
  shareBtnText: {
    fontSize: 12,
    fontWeight: "700",
  },
  price: {
    fontSize: 14,
    fontWeight: "600",
    minWidth: 56,
    textAlign: "right",
  },
  selectorCluster: {
    alignItems: "flex-end",
  },
  selectorCheck: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  selectorStack: {
    flexDirection: "row",
    alignItems: "center",
  },
  selectorAvatar: {
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: "#0B0D10",
  },
  selectorOverflow: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "#374151",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: "#0B0D10",
  },
  selectorOverflowText: {
    color: "#fff",
    fontSize: 9,
    fontWeight: "700",
  },
});
