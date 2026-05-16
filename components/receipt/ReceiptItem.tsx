import React, { useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  useColorScheme,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ReceiptItem as ReceiptItemType } from "@/types";
import { Badge } from "@/components/ui/Badge";
import { Colors } from "@/constants/colors";
import { formatCurrency } from "@/utils/formatter";

interface ReceiptItemProps {
  item: ReceiptItemType;
  currency: string;
  onPress?: () => void;
  selectable?: boolean;
  selected?: boolean;
  selectionColor?: string;
  showWarnings?: boolean;
  isGroupingCandidate?: boolean;
  groupingChecked?: boolean;
  onGroupingToggle?: () => void;
  showEditIcon?: boolean;
  hasMathError?: boolean;
}

export function ReceiptItemRow({
  item,
  currency,
  onPress,
  selectable = false,
  selected = false,
  selectionColor,
  showWarnings = true,
  isGroupingCandidate = false,
  groupingChecked = false,
  onGroupingToggle,
  showEditIcon = false,
  hasMathError = false,
}: ReceiptItemProps) {
  const [expanded, setExpanded] = useState(false);
  const isDark = useColorScheme() === "dark";
  const textColor = isDark ? Colors.textPrimaryDark : Colors.textPrimaryLight;
  const mutedColor = isDark ? Colors.textMutedDark : Colors.textMutedLight;

  const hasChildren =
    (item.components && item.components.length > 0) ||
    (item.addOns && item.addOns.length > 0);

  const isCombo = item.type === "combo";
  const isShareable = item.type === "shareable";

  const borderColor = selected && selectionColor ? selectionColor : "transparent";

  return (
    <View>
      <TouchableOpacity
        style={[
          styles.row,
          {
            borderLeftWidth: selected ? 3 : 0,
            borderLeftColor: borderColor,
            backgroundColor: selected
              ? (selectionColor ?? Colors.primary) + "18"
              : hasMathError
              ? "#F59E0B18"
              : "transparent",
          },
        ]}
        onPress={
          selectable
            ? onPress
            : onPress !== undefined
            ? onPress
            : hasChildren
            ? () => setExpanded(!expanded)
            : undefined
        }
        activeOpacity={0.7}
      >
        <View style={styles.info}>
          <View style={styles.nameRow}>
            <Text style={[styles.name, { color: textColor }]} numberOfLines={2}>
              {item.quantity > 1 ? `${item.quantity}x ` : ""}
              {item.name}
            </Text>
            {isShareable && <Badge label="Shared" variant="shared" style={styles.badge} />}
            {isCombo && <Badge label="Combo" variant="combo" style={styles.badge} />}
          </View>

          {item.notes && item.notes.length > 0 && (
            <Text style={[styles.notes, { color: mutedColor }]}>
              {item.notes.join(" · ")}
            </Text>
          )}

          {hasMathError && item.unitPrice > 0 && (
            <Text style={styles.mathHint}>
              Math check: {item.quantity} × {formatCurrency(item.unitPrice, currency as "EUR" | "USD" | "CAD" | "GBP")} ≠ {formatCurrency(item.totalPrice, currency as "EUR" | "USD" | "CAD" | "GBP")}
            </Text>
          )}

          {showWarnings && item.warnings && item.warnings.length > 0 && (
            <TouchableOpacity
              style={styles.warningRow}
              onPress={isGroupingCandidate ? onGroupingToggle : undefined}
              disabled={!isGroupingCandidate}
              activeOpacity={isGroupingCandidate ? 0.7 : 1}
            >
              <Ionicons name="warning-outline" size={12} color={Colors.warning} />
              <Text style={[styles.warningText, isGroupingCandidate && { flex: 1 }]}>
                {item.warnings[0]}
              </Text>
              {isGroupingCandidate && (
                <View
                  style={[
                    styles.groupCheckbox,
                    {
                      borderColor: groupingChecked ? Colors.warning : mutedColor,
                      backgroundColor: groupingChecked ? Colors.warning : "transparent",
                    },
                  ]}
                >
                  {groupingChecked && (
                    <Ionicons name="checkmark" size={10} color="#fff" />
                  )}
                </View>
              )}
            </TouchableOpacity>
          )}
        </View>

        <View style={styles.rightSection}>
          <View style={styles.priceRow}>
            {hasMathError && (
              <Ionicons name="warning" size={13} color={Colors.warning} />
            )}
            <Text style={[styles.price, { color: hasMathError ? Colors.warning : textColor }]}>
              {formatCurrency(item.totalPrice, currency as "EUR" | "USD" | "CAD" | "GBP")}
            </Text>
            {showEditIcon && (
              <Ionicons name="pencil-outline" size={13} color={mutedColor} />
            )}
          </View>
          {hasChildren && (
            <Ionicons
              name={expanded ? "chevron-up" : "chevron-down"}
              size={14}
              color={mutedColor}
            />
          )}
          {selectable && (
            <View
              style={[
                styles.checkbox,
                {
                  borderColor: selected
                    ? selectionColor ?? Colors.primary
                    : mutedColor,
                  backgroundColor: selected
                    ? selectionColor ?? Colors.primary
                    : "transparent",
                },
              ]}
            >
              {selected && (
                <Ionicons name="checkmark" size={12} color="#fff" />
              )}
            </View>
          )}
        </View>
      </TouchableOpacity>

      {expanded && hasChildren && (
        <View style={styles.children}>
          {item.components?.map((comp) => (
            <View key={comp.id} style={styles.childRow}>
              <Ionicons name="return-down-forward" size={12} color={mutedColor} style={styles.childIcon} />
              <Text style={[styles.childName, { color: mutedColor }]}>
                {comp.name}
              </Text>
              {comp.totalPrice > 0 && (
                <Text style={[styles.childPrice, { color: mutedColor }]}>
                  {formatCurrency(comp.totalPrice, currency as "EUR" | "USD" | "CAD" | "GBP")}
                </Text>
              )}
            </View>
          ))}
          {item.addOns?.map((addon) => (
            <View key={addon.id} style={styles.childRow}>
              <Ionicons name="add-circle-outline" size={12} color={Colors.success} style={styles.childIcon} />
              <Text style={[styles.childName, { color: mutedColor }]}>
                + {addon.name}
              </Text>
              <Text style={[styles.childPrice, { color: mutedColor }]}>
                +{formatCurrency(addon.totalPrice, currency as "EUR" | "USD" | "CAD" | "GBP")}
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingVertical: 10,
    paddingHorizontal: 16,
    gap: 8,
  },
  info: {
    flex: 1,
    gap: 3,
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 6,
  },
  name: {
    fontSize: 14,
    fontWeight: "500",
    flexShrink: 1,
  },
  badge: {
    marginTop: 1,
  },
  notes: {
    fontSize: 12,
    fontStyle: "italic",
  },
  warningRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 2,
  },
  mathHint: {
    fontSize: 11,
    color: Colors.warning,
    fontStyle: "italic",
    marginTop: 1,
  },
  warningText: {
    fontSize: 11,
    color: Colors.warning,
  },
  groupCheckbox: {
    width: 16,
    height: 16,
    borderRadius: 4,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 4,
  },
  rightSection: {
    alignItems: "flex-end",
    gap: 4,
  },
  priceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  price: {
    fontSize: 14,
    fontWeight: "600",
    minWidth: 60,
    textAlign: "right",
  },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  children: {
    paddingLeft: 28,
    paddingBottom: 8,
  },
  childRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 3,
  },
  childIcon: {
    marginRight: 2,
  },
  childName: {
    fontSize: 12,
    flex: 1,
  },
  childPrice: {
    fontSize: 12,
  },
});
