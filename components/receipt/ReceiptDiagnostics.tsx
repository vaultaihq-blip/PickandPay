import React, { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  type CanonicalReceipt,
  type ConfidenceLevel,
  type ReceiptIssue,
  moneyToDecimalString,
} from "@/lib/receipt";

/**
 * Reconciliation summary and targeted correction prompt.
 *
 * Design intent: when a receipt does not add up, the user should be asked to
 * check one specific thing — not to re-enter the whole bill. The tone stays
 * matter-of-fact: a misread line is normal and easy to fix.
 */

interface Props {
  receipt: CanonicalReceipt;
  /** Issues to display, already filtered for dismissals. */
  issues: readonly ReceiptIssue[];
  /** Apply the suggested correction. Only ever called on an explicit tap. */
  onApply: (issue: ReceiptIssue) => void;
  /** Open the targeted editor for the item behind this issue. */
  onReviewItem: (itemId: string) => void;
  onDismiss: (issue: ReceiptIssue) => void;
}

const HEADLINE: Readonly<Record<ConfidenceLevel, string>> = {
  high: "We found a likely reading error",
  medium: "One item may need a quick check",
  low: "We couldn't pin down the difference",
};

function amountText(receipt: CanonicalReceipt, minorSource?: {
  minor: number;
  currency: string;
}): string {
  if (minorSource === undefined) return "—";
  return `${moneyToDecimalString({
    minor: minorSource.minor,
    currency: receipt.currency,
  })} ${receipt.currency}`;
}

export function ReceiptDiagnostics({
  receipt,
  issues,
  onApply,
  onReviewItem,
  onDismiss,
}: Props): React.JSX.Element | null {
  const { validation } = receipt;

  const topIssue = issues[0];
  const otherIssues = useMemo(() => issues.slice(1, 3), [issues]);

  const itemName = useMemo(() => {
    if (topIssue?.itemId === undefined) return undefined;
    return receipt.items.find((item) => item.id === topIssue.itemId)?.name;
  }, [receipt.items, topIssue]);

  if (validation.status === "reconciled") {
    return (
      <View style={[styles.banner, styles.bannerOk]}>
        <Ionicons name="checkmark-circle" size={18} color={OK} />
        <Text style={[styles.bannerText, { color: OK }]}>
          Receipt adds up — ready to continue
        </Text>
      </View>
    );
  }

  if (validation.status === "unverifiable") {
    return (
      <View style={[styles.banner, styles.bannerInfo]}>
        <Ionicons name="information-circle" size={18} color={INFO} />
        <Text style={[styles.bannerText, { color: INFO }]}>
          This receipt has no printed total, so we couldn&apos;t check the items
          automatically. Please review them below.
        </Text>
      </View>
    );
  }

  const delta = validation.subtotalDelta ?? validation.totalDelta;
  const printed = receipt.printedSubtotal ?? receipt.printedTotal;
  const calculated =
    validation.subtotalDelta !== undefined
      ? receipt.calculatedSubtotal
      : receipt.calculatedTotal;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Ionicons name="alert-circle" size={18} color={WARN} />
        <Text style={styles.headerText}>
          {HEADLINE[topIssue?.confidenceLevel ?? "low"]}
        </Text>
      </View>

      <View style={styles.figures}>
        <Row label="Receipt says" value={amountText(receipt, printed)} />
        <Row label="Items add up to" value={amountText(receipt, calculated)} />
        <Row
          label="Difference"
          value={amountText(receipt, delta)}
          emphasis
        />
      </View>

      {topIssue !== undefined && (
        <View style={styles.issueCard}>
          <Text style={styles.issueLabel}>Most likely issue</Text>

          {itemName !== undefined && (
            <Text style={styles.issueItem} numberOfLines={1}>
              {itemName}
            </Text>
          )}

          <Text style={styles.issueMessage}>{topIssue.message}</Text>

          {topIssue.sourceLine !== undefined && (
            <View style={styles.evidence}>
              <Text style={styles.evidenceLabel}>From the receipt</Text>
              <Text style={styles.evidenceText} numberOfLines={2}>
                {topIssue.sourceLine}
              </Text>
            </View>
          )}

          <View style={styles.actions}>
            {topIssue.proposal !== undefined && (
              <Pressable
                style={[styles.action, styles.actionPrimary]}
                onPress={() => onApply(topIssue)}
                accessibilityRole="button"
              >
                <Ionicons name="checkmark" size={15} color="#FFFFFF" />
                <Text style={styles.actionPrimaryText}>Apply fix</Text>
              </Pressable>
            )}

            {topIssue.itemId !== undefined && (
              <Pressable
                style={[styles.action, styles.actionSecondary]}
                onPress={() => onReviewItem(topIssue.itemId as string)}
                accessibilityRole="button"
              >
                <Text style={styles.actionSecondaryText}>Edit manually</Text>
              </Pressable>
            )}

            <Pressable
              style={[styles.action, styles.actionGhost]}
              onPress={() => onDismiss(topIssue)}
              accessibilityRole="button"
            >
              <Text style={styles.actionGhostText}>Ignore</Text>
            </Pressable>
          </View>
        </View>
      )}

      {otherIssues.length > 0 && (
        <View style={styles.others}>
          <Text style={styles.othersLabel}>Other things to check</Text>
          {otherIssues.map((issue) => (
            <Pressable
              key={issue.id}
              style={styles.otherRow}
              onPress={() =>
                issue.itemId !== undefined
                  ? onReviewItem(issue.itemId)
                  : onDismiss(issue)
              }
              accessibilityRole="button"
            >
              <Ionicons name="ellipse-outline" size={10} color={MUTED} />
              <Text style={styles.otherText} numberOfLines={2}>
                {issue.message}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

function Row({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}): React.JSX.Element {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, emphasis === true && styles.rowValueStrong]}>
        {value}
      </Text>
    </View>
  );
}

// ─── Theme ────────────────────────────────────────────────────────────────────

const WARN = "#F59E0B";
const OK = "#22C55E";
const INFO = "#3B82F6";
const MUTED = "#8A8F98";
const SURFACE = "#14171C";
const BORDER = "#232830";
const ACCENT = "#6366F1";

const styles = StyleSheet.create({
  container: {
    backgroundColor: SURFACE,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: `${WARN}55`,
    padding: 16,
    gap: 14,
  },
  header: { flexDirection: "row", alignItems: "center", gap: 8 },
  headerText: { color: WARN, fontSize: 15, fontWeight: "600", flex: 1 },

  figures: { gap: 6 },
  row: { flexDirection: "row", justifyContent: "space-between" },
  rowLabel: { color: MUTED, fontSize: 14 },
  rowValue: { color: "#E6E8EB", fontSize: 14, fontVariant: ["tabular-nums"] },
  rowValueStrong: { color: WARN, fontWeight: "700" },

  issueCard: {
    backgroundColor: "#0F1115",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: BORDER,
    padding: 14,
    gap: 8,
  },
  issueLabel: {
    color: MUTED,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  issueItem: { color: "#FFFFFF", fontSize: 16, fontWeight: "600" },
  issueMessage: { color: "#C7CBD1", fontSize: 14, lineHeight: 20 },

  evidence: {
    marginTop: 4,
    padding: 10,
    borderRadius: 8,
    backgroundColor: "#191D23",
    gap: 3,
  },
  evidenceLabel: {
    color: MUTED,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  evidenceText: {
    color: "#AEB4BC",
    fontSize: 13,
    fontFamily: "monospace",
  },

  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 6 },
  action: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderRadius: 10,
  },
  actionPrimary: { backgroundColor: ACCENT },
  actionPrimaryText: { color: "#FFFFFF", fontSize: 14, fontWeight: "600" },
  actionSecondary: { borderWidth: 1, borderColor: BORDER },
  actionSecondaryText: { color: "#E6E8EB", fontSize: 14, fontWeight: "500" },
  actionGhost: {},
  actionGhostText: { color: MUTED, fontSize: 14 },

  others: { gap: 8 },
  othersLabel: {
    color: MUTED,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  otherRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  otherText: { color: "#AEB4BC", fontSize: 13, flex: 1 },

  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
  },
  bannerOk: { backgroundColor: `${OK}12`, borderColor: `${OK}55` },
  bannerInfo: { backgroundColor: `${INFO}12`, borderColor: `${INFO}55` },
  bannerText: { fontSize: 14, fontWeight: "500", flex: 1 },
});
