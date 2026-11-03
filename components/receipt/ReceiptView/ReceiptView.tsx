import React, { useRef } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "@/constants/colors";
import { RECEIPT_MONO } from "@/constants/typography";
import { useI18nStore } from "@/store/i18nStore";
import { GroupIcon } from "./GroupIcon";
import { inGroups, type GroupKind } from "./groups";

// D (04-11-2026) — the ONE way the app draws a receipt (design B2,
// docs/design/revisao-espelho-app.png): the app's dark card, the restaurant
// and date at the top, the lines in three groups (Comidas, Bebidas, Outros)
// in receipt order, "2 × Name …… amount" in the receipt's monospaced font,
// and the summary at the end (total in green with ✓ when it adds up).
// A mode per screen; the mode only changes what a line shows and does:
//   review / manual — red "!" / green "✓" lines, a tap opens the correction panel
//   select          — fixed-height lines: − / + at the start, the person's tint
//                     and circles at the end ("Pick your items")
//   lobby           — read only, with the circles of who picked
//   readonly        — dashboard / history
export type ReceiptViewMode = "review" | "manual" | "select" | "lobby" | "readonly";

export type ReceiptViewLine = {
  key: string;
  quantity: number;
  name: string;
  amount: number;
  category?: string;
  photoBox?: readonly [number, number, number, number];
  /** review/manual: red "!" (to confirm) or green "✓" (confirmed). */
  state?: "red" | "green";
  /** Under a red line: why, in plain words. */
  reason?: string;
  /** select: the dark tint of the person's colour (R4) when the line is theirs. */
  tint?: string;
  /** Small text under the name ("1 de 2 livre", "partilhado com …"). */
  sub?: string;
  /** select: − / + at the start of the line. */
  left?: React.ReactNode;
  /** select / lobby: the circles at the end of the line. */
  right?: React.ReactNode;
  /** Shown after the amount (e.g. "Partilhar"). */
  trailing?: React.ReactNode;
  onPress?: () => void;
  onLayout?: (y: number) => void;
};

export type ReceiptSummaryRow = { key: string; label: string; value: string; tone?: "total" | "total-ok" | "red"; onPress?: () => void };

type Props = {
  mode: ReceiptViewMode;
  merchant?: string;
  date?: string;
  lines: ReceiptViewLine[];
  /** Extra lines at the end of the list (e.g. the R2 question, red). */
  afterLines?: React.ReactNode;
  summary?: ReceiptSummaryRow[];
  note?: string;
  formatMoney: (v: number) => string;
  onLayout?: (y: number) => void;
};

// "2026-10-07" → "07/10/2026"; anything else as it came.
const showDate = (d?: string) => {
  const m = d ? /^(\d{4})-(\d{2})-(\d{2})/.exec(d) : null;
  return m ? `${m[3]}/${m[2]}/${m[1]}` : d;
};

const GROUP_LABEL: Record<GroupKind, "receipt_group_food" | "receipt_group_drinks" | "receipt_group_others"> = {
  food: "receipt_group_food",
  drinks: "receipt_group_drinks",
  others: "receipt_group_others",
};

export function ReceiptView({ mode, merchant, date, lines, afterLines, summary, note, formatMoney, onLayout }: Props) {
  const { t } = useI18nStore();
  const fixed = mode === "select";
  // Where each line is inside the card (its group's y + its own y in the
  // group), reported through line.onLayout whenever either one moves.
  const groupY = useRef(new Map<GroupKind, number>());
  const rowY = useRef(new Map<string, { kind: GroupKind; y: number; report?: (y: number) => void }>());
  const emit = (key: string) => {
    const r = rowY.current.get(key);
    if (r?.report) r.report((groupY.current.get(r.kind) ?? 0) + r.y);
  };
  return (
    <View style={styles.paper} onLayout={(e) => onLayout?.(e.nativeEvent.layout.y)}>
      {merchant ? <Text style={styles.merchant}>{merchant.toUpperCase()}</Text> : null}
      {date ? <Text style={styles.date}>{showDate(date)}</Text> : null}
      {merchant || date ? <View style={styles.dashed} /> : null}

      {inGroups(lines).map((group) => (
        <View key={group.kind} style={styles.group} onLayout={(e) => {
          groupY.current.set(group.kind, e.nativeEvent.layout.y);
          group.rows.forEach((row) => emit(row.key));
        }}>
          <View style={styles.groupHeader} accessibilityRole="header">
            <GroupIcon kind={group.kind} />
            <Text style={styles.groupLabel}>{t(GROUP_LABEL[group.kind])}</Text>
          </View>
          {group.rows.map((line) => {
            const body = (
              <>
                {line.left ? <View style={styles.left}>{line.left}</View> : null}
                {line.state === "red" ? <Ionicons name="alert-circle-outline" size={22} color={Colors.errorLight} style={styles.icon} />
                  : line.state === "green" ? <Ionicons name="checkmark-circle-outline" size={22} color={Colors.successLight} style={styles.icon} /> : null}
                <View style={styles.nameCol}>
                  <Text style={styles.name} numberOfLines={fixed ? 1 : 2}>{line.quantity} × {line.name || "—"}</Text>
                  {fixed || line.sub ? <Text style={styles.sub} numberOfLines={1}>{line.sub ?? " "}</Text> : null}
                </View>
                <Text style={styles.amount}>{formatMoney(line.amount)}</Text>
                {line.trailing}
                {line.right ? <View style={styles.right}>{line.right}</View> : null}
              </>
            );
            const style = [
              styles.line,
              fixed && styles.lineFixed,
              line.state === "red" && styles.lineRed,
              line.state === "green" && styles.lineGreen,
              line.tint ? { backgroundColor: line.tint, borderColor: line.tint } : null,
            ];
            return (
              <View key={line.key} onLayout={(e) => {
                rowY.current.set(line.key, { kind: group.kind, y: e.nativeEvent.layout.y, report: line.onLayout });
                emit(line.key);
              }}>
                {line.onPress ? (
                  <Pressable onPress={line.onPress} style={style} accessibilityRole="button"><View style={styles.lineMain}>{body}</View></Pressable>
                ) : (
                  <View style={style}><View style={styles.lineMain}>{body}</View></View>
                )}
                {line.state === "red" && line.reason ? <Text style={styles.reason}>{line.reason}</Text> : null}
              </View>
            );
          })}
        </View>
      ))}
      {afterLines}

      {summary && summary.length > 0 ? (
        <>
          <View style={styles.dashed} />
          {summary.map((row) => {
            const total = row.tone === "total" || row.tone === "total-ok";
            const ok = row.tone === "total-ok";
            const content = (
              <>
                <Text style={[total ? styles.totalLabel : styles.sumLabel, ok && styles.ok]}>{row.label}{ok ? " ✓" : ""}</Text>
                <Text style={[total ? styles.totalValue : styles.sumValue, ok && styles.ok]}>{row.value}</Text>
              </>
            );
            const rowStyle = [styles.sumRow, row.tone === "red" && styles.lineRed];
            return row.onPress ? (
              <Pressable key={row.key} style={rowStyle} onPress={row.onPress} accessibilityRole="button">{content}</Pressable>
            ) : (
              <View key={row.key} style={rowStyle}>{content}</View>
            );
          })}
          {note ? <Text style={styles.note}>{note}</Text> : null}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  paper: { backgroundColor: Colors.cardDark, borderRadius: 16, borderWidth: 1, borderColor: Colors.cardBorderDark, paddingVertical: 16, paddingHorizontal: 12 },
  merchant: { fontFamily: RECEIPT_MONO, fontSize: 16, fontWeight: "800", color: Colors.textPrimaryDark, textAlign: "center", letterSpacing: 1 },
  date: { fontFamily: RECEIPT_MONO, fontSize: 14, color: Colors.textSecondaryDark, textAlign: "center", marginTop: 6 },
  dashed: { borderTopWidth: 1, borderStyle: "dashed", borderColor: Colors.cardBorderDark, marginVertical: 12, marginHorizontal: 4 },
  group: { marginBottom: 6 },
  groupHeader: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 8, paddingTop: 4, paddingBottom: 6 },
  groupLabel: { fontSize: 13, fontWeight: "700", color: Colors.textMutedDark, textTransform: "uppercase", letterSpacing: 0.6 },
  line: { paddingVertical: 8, paddingHorizontal: 8, borderRadius: 8, borderWidth: 1, borderColor: "transparent", marginVertical: 2 },
  // select: the line never changes height when selected — nothing moves.
  lineFixed: { height: 64, paddingVertical: 0, justifyContent: "center" },
  lineRed: { backgroundColor: Colors.errorBg, borderColor: Colors.error },
  lineGreen: { backgroundColor: Colors.successBg, borderColor: Colors.success },
  lineMain: { flexDirection: "row", alignItems: "center" },
  left: { marginRight: 8 },
  icon: { marginRight: 8 },
  nameCol: { flex: 1 },
  name: { fontFamily: RECEIPT_MONO, fontSize: 15, color: Colors.textPrimaryDark },
  sub: { fontSize: 12, color: Colors.textSecondaryDark, marginTop: 2 },
  amount: { fontFamily: RECEIPT_MONO, fontSize: 15, color: Colors.textPrimaryDark, marginLeft: 8 },
  right: { marginLeft: 8 },
  reason: { fontSize: 12, color: Colors.errorLight, marginLeft: 38, marginTop: 2, marginBottom: 4 },
  sumRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4, paddingHorizontal: 8, borderRadius: 8 },
  sumLabel: { fontFamily: RECEIPT_MONO, fontSize: 15, color: Colors.textPrimaryDark },
  sumValue: { fontFamily: RECEIPT_MONO, fontSize: 15, color: Colors.textPrimaryDark },
  totalLabel: { fontFamily: RECEIPT_MONO, fontSize: 16, fontWeight: "800", color: Colors.textPrimaryDark },
  totalValue: { fontFamily: RECEIPT_MONO, fontSize: 16, fontWeight: "800", color: Colors.textPrimaryDark },
  ok: { color: Colors.successLight },
  note: { fontSize: 13, color: Colors.textSecondaryDark, paddingHorizontal: 8, marginTop: 6, lineHeight: 19 },
});
