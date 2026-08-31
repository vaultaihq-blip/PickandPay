import React from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  useColorScheme,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SessionParticipant, SplitResult, TipMode } from "@/types";
import { Avatar } from "@/components/ui/Avatar";
import { Colors } from "@/constants/colors";
import { formatCurrency } from "@/utils/formatter";
import { useI18nStore } from "@/store/i18nStore";

type Currency = "EUR" | "USD" | "CAD" | "GBP";

interface BreakdownCardProps {
  participant: SessionParticipant;
  splitResult: SplitResult | undefined;
  currency: string;
  isCreator: boolean;
  isCurrentUser?: boolean;
  // canMarkPaid = true → interactive paid toggle; false → read-only status display
  canMarkPaid: boolean;
  onMarkPaid: (paid: boolean) => void;
  tipMode?: TipMode;
  expanded: boolean;
  onToggleExpand: () => void;
}

export function BreakdownCard({
  participant,
  splitResult,
  currency,
  isCreator,
  isCurrentUser = false,
  canMarkPaid,
  onMarkPaid,
  tipMode,
  expanded,
  onToggleExpand,
}: BreakdownCardProps) {
  const { profile, totalOwed, paid } = participant;
  const { t, language } = useI18nStore();
  void language;

  const isDark = useColorScheme() === "dark";
  const textColor = isDark ? Colors.textPrimaryDark : Colors.textPrimaryLight;
  const mutedColor = isDark ? Colors.textMutedDark : Colors.textMutedLight;
  const cardColor = isDark ? Colors.cardDark : Colors.cardLight;
  const borderColor = isDark ? Colors.cardBorderDark : Colors.cardBorderLight;
  const curr = currency as Currency;

  const hasItems = (splitResult?.itemBreakdown.length ?? 0) > 0;
  const hasCosts = (splitResult?.globalCostsShare ?? 0) > 0;
  const hasTip = (splitResult?.tipShare ?? 0) > 0;
  const hasBreakdown = hasItems || hasCosts || hasTip;

  const activeBorderColor = isCurrentUser
    ? Colors.primary
    : paid
    ? Colors.success + "55"
    : borderColor;
  const activeBorderWidth = isCurrentUser || paid ? 2 : 1;

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: isCurrentUser
            ? Colors.primary + "0D"
            : cardColor,
          borderColor: activeBorderColor,
          borderWidth: activeBorderWidth,
        },
      ]}
    >
      {/* Color accent bar */}
      <View style={[styles.accent, { backgroundColor: profile.color }]} />

      <View style={styles.body}>
        {/* ── Collapsed header row (always visible) ── */}
        <TouchableOpacity
          style={styles.header}
          onPress={() => hasBreakdown && onToggleExpand()}
          activeOpacity={hasBreakdown ? 0.7 : 1}
        >
          <Avatar
            name={profile.name}
            avatarIcon={profile.avatarIcon}
            avatarUrl={profile.avatarUrl}
            color={profile.color}
            size={42}
          />

          <View style={styles.nameSection}>
            <View style={styles.nameRow}>
              <Text style={[styles.name, { color: textColor }]} numberOfLines={1}>
                {profile.name}
              </Text>
              {isCreator && (
                <View style={styles.hostBadge}>
                  <Text style={styles.hostBadgeText}>Host</Text>
                </View>
              )}
              {paid && (
                <Ionicons name="checkmark-circle" size={16} color={Colors.success} />
              )}
            </View>
            {hasTip && splitResult ? (
              <>
                <View style={styles.amountWithTipRow}>
                  <Text style={[styles.amount, { color: profile.color }]}>
                    {formatCurrency(totalOwed - splitResult.tipShare, curr)}
                  </Text>
                  <Text style={[styles.tipInline, { color: mutedColor }]}>
                    + (Tip {formatCurrency(splitResult.tipShare, curr)})
                  </Text>
                </View>
                <Text style={[styles.totalOwedLine, { color: profile.color }]}>
                  Total: {formatCurrency(totalOwed, curr)}
                </Text>
              </>
            ) : (
              <Text style={[styles.amount, { color: profile.color }]}>
                {formatCurrency(totalOwed, curr)}
              </Text>
            )}
          </View>

          {hasBreakdown && (
            <Ionicons
              name={expanded ? "chevron-up" : "chevron-down"}
              size={18}
              color={mutedColor}
            />
          )}
        </TouchableOpacity>

        {/* ── Expanded breakdown ── */}
        {expanded && hasBreakdown && (
          <View style={[styles.breakdown, { borderColor }]}>
            {hasItems && (
              <View style={styles.tableHeader}>
                <Text style={[styles.colHeaderItem, { color: mutedColor }]}>ITEM</Text>
                <Text style={[styles.colHeaderShare, { color: mutedColor }]}>YOUR SHARE</Text>
                <Text style={[styles.colHeaderTotal, { color: mutedColor }]}>ITEM TOTAL</Text>
              </View>
            )}

            {splitResult?.itemBreakdown.map((entry) => {
              const isSplit = entry.splitCount > 1;
              return (
                <View key={entry.itemId} style={styles.tableRow}>
                  <Text style={[styles.itemName, { color: textColor }]} numberOfLines={2}>
                    {entry.itemName}
                  </Text>
                  <Text style={[styles.yourShare, { color: profile.color }]}>
                    {formatCurrency(entry.amount, curr)}
                  </Text>
                  <View style={styles.itemTotalCell}>
                    <Text style={[styles.itemTotalPrice, { color: mutedColor }]}>
                      {formatCurrency(entry.itemTotal, curr)}
                      {isSplit ? ` (÷${entry.splitCount})` : ""}
                    </Text>
                  </View>
                </View>
              );
            })}

            {hasItems && (hasCosts || hasTip) && (
              <View style={[styles.subtotalRow, { borderColor }]}>
                <Text style={[styles.subtotalLabel, { color: mutedColor }]}>Items subtotal</Text>
                <View style={{ width: 80 }} />
                <Text style={[styles.subtotalAmount, { color: mutedColor }]}>
                  {formatCurrency(
                    splitResult!.itemBreakdown.reduce((s, e) => s + e.amount, 0),
                    curr
                  )}
                </Text>
              </View>
            )}

            {hasCosts && (
              <View style={styles.tableRow}>
                <Text style={[styles.itemName, { color: mutedColor }]}>Tax & fees share</Text>
                <Text style={[styles.yourShare, { color: mutedColor }]}>
                  +{formatCurrency(splitResult!.globalCostsShare, curr)}
                </Text>
                <View style={styles.itemTotalCell} />
              </View>
            )}

            {hasTip && (
              <View style={styles.tableRow}>
                <Text style={[styles.itemName, { color: mutedColor }]}>
                  {tipMode === "individual" ? "Your tip" : "Tip share"}
                </Text>
                <Text style={[styles.yourShare, { color: mutedColor }]}>
                  +{formatCurrency(splitResult!.tipShare, curr)}
                </Text>
                <View style={styles.itemTotalCell} />
              </View>
            )}

            <View style={[styles.totalRow, { borderColor }]}>
              <Text style={[styles.totalLabel, { color: mutedColor }]}>Total</Text>
              <Text style={[styles.totalAmount, { color: profile.color }]}>
                {formatCurrency(totalOwed, curr)}
              </Text>
            </View>
          </View>
        )}

        {/* ── Paid status — always visible for all users ── */}
        {canMarkPaid ? (
          <TouchableOpacity
            style={[
              styles.paidBtn,
              paid
                ? { backgroundColor: Colors.success, borderColor: Colors.success, borderWidth: 1 }
                : { backgroundColor: "#EF4444", borderColor: "#EF4444", borderWidth: 1 },
            ]}
            onPress={() => onMarkPaid(!paid)}
            activeOpacity={0.8}
          >
            <Ionicons
              name={paid ? "checkmark-circle" : "close-circle"}
              size={18}
              color="#fff"
            />
            <Text style={[styles.paidBtnText, { color: "#fff" }]}>
              {paid
                ? `${t("breakdown_paid")} / ${t("breakdown_unpaid")}`
                : `${t("breakdown_unpaid")} / ${t("breakdown_paid")}`}
            </Text>
          </TouchableOpacity>
        ) : (
          <View
            style={[
              styles.paidBtn,
              paid
                ? { backgroundColor: Colors.success + "22", borderColor: Colors.success + "55", borderWidth: 1 }
                : { backgroundColor: Colors.primary + "12", borderColor: Colors.primary + "44", borderWidth: 1 },
            ]}
          >
            <Ionicons
              name={paid ? "checkmark-circle" : "time-outline"}
              size={18}
              color={paid ? Colors.success : Colors.primary}
            />
            <Text style={[styles.paidBtnText, { color: paid ? Colors.success : Colors.primary }]}>
              {paid ? t("breakdown_paid") : t("breakdown_pending")}
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 14,
    flexDirection: "row",
    overflow: "hidden",
  },
  accent: { width: 4 },
  body: { flex: 1, padding: 14, gap: 12 },

  // ── Header ──────────────────────────────────────────────────────────────────
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 48,
  },
  nameSection: { flex: 1, gap: 3 },
  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
  },
  name: { fontSize: 15, fontWeight: "600", flexShrink: 1 },
  amount: { fontSize: 22, fontWeight: "800" },
  amountWithTipRow: { flexDirection: "row", alignItems: "baseline", gap: 6, flexWrap: "wrap" },
  tipInline: { fontSize: 12, fontWeight: "500" },
  totalOwedLine: { fontSize: 14, fontWeight: "700", marginTop: 1 },
  hostBadge: {
    backgroundColor: Colors.primary + "33",
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  hostBadgeText: { color: Colors.primary, fontSize: 11, fontWeight: "600" },

  // ── Breakdown table ─────────────────────────────────────────────────────────
  breakdown: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 10,
    gap: 6,
  },
  tableHeader: {
    flexDirection: "row",
    paddingBottom: 6,
    gap: 4,
  },
  colHeaderItem: {
    flex: 1,
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  colHeaderShare: {
    width: 70,
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 0.5,
    textAlign: "right",
  },
  colHeaderTotal: {
    width: 80,
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 0.5,
    textAlign: "right",
  },
  tableRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    minHeight: 22,
  },
  itemName: {
    flex: 1,
    fontSize: 13,
    fontWeight: "500",
  },
  yourShare: {
    width: 70,
    fontSize: 13,
    fontWeight: "700",
    textAlign: "right",
  },
  itemTotalCell: {
    width: 80,
    alignItems: "flex-end",
  },
  itemTotalPrice: {
    fontSize: 11,
    textAlign: "right",
  },
  subtotalRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 6,
    marginTop: 2,
  },
  subtotalLabel: { flex: 1, fontSize: 12, fontStyle: "italic" },
  subtotalAmount: { width: 80, fontSize: 12, textAlign: "right" },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
    marginTop: 2,
  },
  totalLabel: { fontSize: 13, fontWeight: "500" },
  totalAmount: { fontSize: 16, fontWeight: "800" },

  // ── Paid button / status ────────────────────────────────────────────────────
  paidBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
    borderRadius: 10,
    gap: 6,
    minHeight: 48,
  },
  paidBtnText: { fontSize: 14, fontWeight: "600" },
});
