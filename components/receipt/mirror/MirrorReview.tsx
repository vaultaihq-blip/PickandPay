import React, { useMemo, useState } from "react";
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "@/constants/colors";
import { useI18nStore } from "@/store/i18nStore";
import type { EditableRow } from "@/lib/receipt-validator";
import type { GapAnswer, GapSuggestion, PrintedTotalGap } from "@/lib/receipt/printedTotalGap";
import { PrintedTotalGapCard } from "@/components/receipt/PrintedTotalGapCard";
import { MirrorLinePanel, type PanelLine } from "./MirrorLinePanel";

// R10 (owner, 03-11-2026) — the receipt review as a mirror of the paper:
// header "Confirmar a fatura · Passo 2 de 3 · Compara com o papel" with the
// step bar (C2 for this screen) and the currency; a paper-like card with
// identical lines grouped (here only), each line red "!" (to confirm),
// green "✓" (confirmed) or plain; the end of the receipt (items, charges,
// the answered gap, TOTAL IMPRESSO); the R2 gap question as a red line at
// the end; Continuar only with no red lines.

type Group = { key: string; ids: string[]; name: string; quantity: number; unitPrice: number; total: number; red: boolean; green: boolean; reason?: string; photoBox?: PanelLine["photoBox"] };

type Props = {
  items: (EditableRow & { photoBox?: PanelLine["photoBox"] })[];
  attentionIds: Set<string>;
  reasonFor: (id: string) => string;
  formatMoney: (v: number) => string;
  currencyCard: React.ReactNode;
  photoUri: string | null;
  itemsSum: number;
  chargesSum: number;
  gap: PrintedTotalGap;
  gapAnswer: GapAnswer | null;
  gapAnswered: boolean;
  gapSuggestion: GapSuggestion | null;
  onAnswerGap: (a: GapAnswer | null) => void;
  confirmedTotal: number;
  confirmedTotalText: string;
  onChangeTotal: (raw: string) => void;
  currencyOk: boolean;
  onSaveLine: (ids: string[], v: { name: string; quantity: number; unitPrice: number }) => void;
  onDeleteLine: (ids: string[]) => void;
  onAddItem: () => void;
  onSeePhoto: () => void;
  onSeeList: () => void;
  onContinue: () => void;
  onBack: () => void;
};

const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

export function MirrorReview(p: Props) {
  const { t } = useI18nStore();
  const [panel, setPanel] = useState<PanelLine | null>(null);
  const [gapOpen, setGapOpen] = useState(false);
  const [totalOpen, setTotalOpen] = useState(false);

  // Identical lines (same name, case and spaces ignored, and unit price) are one row here.
  const groups = useMemo<Group[]>(() => {
    const map = new Map<string, Group>();
    for (const it of p.items) {
      const key = `${it.name.trim().toLowerCase().replace(/\s+/g, " ")}|${Math.round(it.unitPrice * 100)}`;
      const red = p.attentionIds.has(it.id) && !it.reviewed;
      const g = map.get(key);
      if (g) {
        g.ids.push(it.id);
        g.quantity += it.quantity;
        g.total = Math.round((g.total + it.totalPrice) * 100) / 100;
        g.red = g.red || red;
        g.green = g.green && !!it.reviewed;
        if (red && !g.reason) g.reason = p.reasonFor(it.id);
      } else {
        map.set(key, { key, ids: [it.id], name: it.name, quantity: it.quantity, unitPrice: it.unitPrice, total: it.totalPrice, red, green: !!it.reviewed, reason: red ? p.reasonFor(it.id) : undefined, photoBox: it.photoBox });
      }
    }
    return [...map.values()];
  }, [p.items, p.attentionIds, p.reasonFor]);

  const redCount = groups.filter((g) => g.red).length;
  const gapOpenLine = p.gap.kind !== "none" && !p.gapAnswered;
  const gapOk = p.gap.kind === "none" || p.gapAnswered;
  const noTotal = !(p.confirmedTotal > 0);
  const canContinue = redCount === 0 && gapOk && p.currencyOk && !noTotal;
  const answeredSigned = p.gapAnswered && p.gapAnswer ? (p.gapAnswer.answer === "charge" ? p.gapAnswer.amount : -p.gapAnswer.amount) : 0;
  const blockedLabel =
    redCount > 0 ? (redCount === 1 ? t("mirror_confirm_1") : t("mirror_confirm_n").replace("{n}", String(redCount)))
    : !p.currencyOk ? t("currency_continue_blocked")
    : noTotal ? t("mirror_total_missing")
    : !gapOk ? t("gap_continue_blocked") : t("mirror_continue");

  const open = (g: Group) => setPanel({ ids: g.ids, name: g.name, quantity: g.quantity, unitPrice: g.unitPrice, photoBox: g.photoBox });

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <TouchableOpacity onPress={p.onBack} hitSlop={12} accessibilityRole="button" accessibilityLabel={t("back")}>
          <Ionicons name="chevron-back" size={24} color="#111827" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{t("mirror_title")}</Text>
          <Text style={styles.subtitle}>{t("mirror_step").replace("{n}", "2").replace("{m}", "3")} · {t("mirror_compare")}</Text>
        </View>
      </View>
      {/* C2 for this screen: photo → confirm → split */}
      <View style={styles.stepBar}>
        {[t("mirror_step_photo"), t("mirror_step_confirm"), t("mirror_step_split")].map((label, i) => (
          <View key={label} style={styles.stepItem}>
            <View style={[styles.stepLine, i <= 1 && { backgroundColor: Colors.primary }]} />
            <Text style={[styles.stepLabel, i === 1 && { color: Colors.primary, fontWeight: "800" }]}>{label}</Text>
          </View>
        ))}
      </View>

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {p.currencyCard}

        <View style={styles.paper}>
          {groups.map((g) => (
            <Pressable key={g.key} onPress={() => open(g)} style={[styles.line, g.red && styles.lineRed, !g.red && g.green && styles.lineGreen]} accessibilityRole="button">
              <View style={styles.lineMain}>
                <Text style={styles.lineQty}>{g.quantity}</Text>
                <Text style={styles.lineName} numberOfLines={2}>{g.name || "—"}</Text>
                <Text style={styles.lineAmount}>{p.formatMoney(g.total)}</Text>
                <Text style={[styles.mark, g.red ? styles.markRed : styles.markGreen]}>{g.red ? "!" : g.green ? "✓" : " "}</Text>
              </View>
              {g.quantity > 1 ? <Text style={styles.lineSub}>{g.quantity} × {p.formatMoney(g.unitPrice)}</Text> : null}
              {g.red && g.reason ? <Text style={styles.reason}>{g.reason}</Text> : null}
            </Pressable>
          ))}

          <View style={styles.dashed} />
          <View style={styles.sumRow}>
            <Text style={styles.sumLabel}>{t("mirror_items_sum")}</Text>
            <Text style={styles.sumValue}>{p.formatMoney(p.itemsSum)}</Text>
          </View>
          {p.chargesSum !== 0 && (
            <View style={styles.sumRow}>
              <Text style={styles.sumLabel}>+ {t("mirror_charges")}</Text>
              <Text style={styles.sumValue}>{p.formatMoney(p.chargesSum)}</Text>
            </View>
          )}
          {p.gapAnswered && p.gapAnswer && (
            <Pressable style={[styles.sumRow, styles.lineGreen]} onPress={() => setGapOpen(true)} accessibilityRole="button">
              <Text style={styles.sumLabel}>
                {answeredSigned >= 0 ? "+" : "−"} {p.gapAnswer.name || (answeredSigned >= 0 ? t("mirror_unlined") : t("mirror_discount"))}
              </Text>
              <Text style={styles.sumValue}>{p.formatMoney(Math.abs(answeredSigned))} ✓</Text>
            </Pressable>
          )}
          {gapOpenLine && (
            <Pressable style={[styles.line, styles.lineRed]} onPress={() => setGapOpen(true)} accessibilityRole="button">
              <View style={styles.lineMain}>
                <Text style={[styles.lineName, { marginLeft: 0 }]}>{p.gap.kind === "under" ? t("mirror_gap_under") : t("mirror_gap_over")}</Text>
                <Text style={styles.lineAmount}>{p.formatMoney(p.gap.amount)}</Text>
                <Text style={[styles.mark, styles.markRed]}>!</Text>
              </View>
            </Pressable>
          )}
          <Pressable style={[styles.totalRow, noTotal && styles.lineRed]} onPress={() => setTotalOpen(true)} accessibilityRole="button">
            <Text style={styles.totalLabel}>{t("mirror_printed_total")} {!noTotal && gapOk ? "✓" : ""}</Text>
            <Text style={styles.totalValue}>{noTotal ? "—" : p.formatMoney(p.confirmedTotal)}</Text>
          </Pressable>
          {p.gapAnswered && p.gapAnswer?.answer === "charge" && (
            <Text style={styles.note}>{t("mirror_proportional").replace("{amount}", p.formatMoney(p.gapAnswer.amount))}</Text>
          )}
        </View>

        <View style={styles.legend}>
          <Text style={[styles.mark, styles.markRed]}>!</Text><Text style={styles.legendText}>{t("mirror_legend_todo")}</Text>
          <Text style={[styles.mark, styles.markGreen]}>✓</Text><Text style={styles.legendText}>{t("mirror_legend_done")}</Text>
        </View>

        <View style={styles.links}>
          <TouchableOpacity onPress={p.onAddItem} style={styles.linkBtn} accessibilityRole="button">
            <Ionicons name="add" size={18} color={Colors.primary} /><Text style={styles.linkText}>{t("mirror_add_missing")}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={p.onSeePhoto} style={styles.linkBtn} accessibilityRole="button">
            <Ionicons name="image-outline" size={18} color={Colors.primary} /><Text style={styles.linkText}>{t("mirror_see_photo")}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={p.onSeeList} style={styles.linkBtn} accessibilityRole="button">
            <Ionicons name="list-outline" size={18} color={Colors.primary} /><Text style={styles.linkText}>{t("mirror_see_list")}</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      <View style={styles.footer}>
        <TouchableOpacity style={[styles.continueBtn, !canContinue && { opacity: 0.45 }]} disabled={!canContinue} onPress={p.onContinue} accessibilityRole="button" accessibilityState={{ disabled: !canContinue }}>
          <Text style={styles.continueText}>{blockedLabel}</Text>
        </TouchableOpacity>
      </View>

      <MirrorLinePanel
        line={panel}
        photoUri={p.photoUri}
        formatMoney={p.formatMoney}
        onSave={(ids, v) => { p.onSaveLine(ids, v); setPanel(null); }}
        onDelete={(ids) => { p.onDeleteLine(ids); setPanel(null); }}
        onClose={() => setPanel(null)}
      />

      <Modal visible={gapOpen} transparent animationType="slide" onRequestClose={() => setGapOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setGapOpen(false)} />
        <View style={styles.sheet}>
          <PrintedTotalGapCard
            gap={p.gap}
            answer={p.gapAnswer}
            suggestion={p.gapSuggestion}
            formatMoney={p.formatMoney}
            onAnswer={(a) => { p.onAnswerGap(a); if (a) setGapOpen(false); }}
            onAddMissing={() => { setGapOpen(false); p.onAddItem(); }}
            onReviewItems={() => setGapOpen(false)}
          />
        </View>
      </Modal>

      <Modal visible={totalOpen} transparent animationType="slide" onRequestClose={() => setTotalOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setTotalOpen(false)} />
        <View style={styles.sheet}>
          <Text style={styles.sumLabel}>{t("mirror_total_edit")}</Text>
          <TextInput value={p.confirmedTotalText} onChangeText={p.onChangeTotal} keyboardType="decimal-pad" autoFocus style={styles.totalInput} placeholder="0,00" placeholderTextColor="#9CA3AF" />
          <TouchableOpacity style={styles.continueBtn} onPress={() => setTotalOpen(false)} accessibilityRole="button">
            <Text style={styles.continueText}>{t("mirror_save")}</Text>
          </TouchableOpacity>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#F3F4F6" },
  header: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingTop: 12 },
  title: { fontSize: 18, fontWeight: "800", color: "#111827" },
  subtitle: { fontSize: 12, color: "#6B7280", marginTop: 2 },
  stepBar: { flexDirection: "row", gap: 6, paddingHorizontal: 16, paddingVertical: 10 },
  stepItem: { flex: 1, gap: 4 },
  stepLine: { height: 4, borderRadius: 2, backgroundColor: "#D1D5DB" },
  stepLabel: { fontSize: 11, color: "#6B7280", textAlign: "center" },
  body: { paddingHorizontal: 16, paddingBottom: 24 },
  paper: { backgroundColor: "#FFFDF7", borderRadius: 4, paddingVertical: 10, paddingHorizontal: 10, borderWidth: 1, borderColor: "#E7E2D3", shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 2 },
  line: { paddingVertical: 8, paddingHorizontal: 6, borderRadius: 6, marginVertical: 1 },
  lineRed: { backgroundColor: "#FEE2E2" },
  lineGreen: { backgroundColor: "#DCFCE7" },
  lineMain: { flexDirection: "row", alignItems: "center" },
  lineQty: { fontFamily: MONO, fontSize: 14, color: "#374151", width: 24 },
  lineName: { flex: 1, fontFamily: MONO, fontSize: 14, color: "#111827", marginLeft: 4 },
  lineAmount: { fontFamily: MONO, fontSize: 14, color: "#111827", marginLeft: 8 },
  lineSub: { fontFamily: MONO, fontSize: 12, color: "#6B7280", marginLeft: 28, marginTop: 2 },
  reason: { fontSize: 12, color: "#991B1B", marginLeft: 28, marginTop: 4 },
  mark: { width: 20, textAlign: "center", fontWeight: "900", fontSize: 15 },
  markRed: { color: "#DC2626" },
  markGreen: { color: "#16A34A" },
  dashed: { borderTopWidth: 1, borderStyle: "dashed", borderColor: "#BDB7A6", marginVertical: 8 },
  sumRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4, paddingHorizontal: 6, borderRadius: 6 },
  sumLabel: { fontFamily: MONO, fontSize: 14, color: "#374151" },
  sumValue: { fontFamily: MONO, fontSize: 14, color: "#111827" },
  totalRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 8, paddingHorizontal: 6, borderRadius: 6, marginTop: 4, borderTopWidth: 1, borderColor: "#BDB7A6" },
  totalLabel: { fontFamily: MONO, fontSize: 15, fontWeight: "800", color: "#111827" },
  totalValue: { fontFamily: MONO, fontSize: 15, fontWeight: "800", color: "#111827" },
  note: { fontSize: 12, color: "#6B7280", paddingHorizontal: 6, marginTop: 4 },
  legend: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 10, paddingHorizontal: 4 },
  legendText: { fontSize: 12, color: "#6B7280", marginRight: 12 },
  links: { marginTop: 12, gap: 4 },
  linkBtn: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44 },
  linkText: { color: Colors.primary, fontWeight: "700", fontSize: 14 },
  footer: { padding: 16, borderTopWidth: StyleSheet.hairlineWidth, borderColor: "#D1D5DB", backgroundColor: "#FFFFFF" },
  continueBtn: { minHeight: 50, borderRadius: 12, backgroundColor: Colors.primary, alignItems: "center", justifyContent: "center", paddingHorizontal: 12 },
  continueText: { color: "#FFFFFF", fontWeight: "800", fontSize: 15, textAlign: "center" },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)" },
  sheet: { position: "absolute", left: 0, right: 0, bottom: 0, backgroundColor: "#FFFFFF", borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 16, paddingBottom: 28, gap: 10 },
  totalInput: { borderWidth: 1.5, borderColor: "#D1D5DB", borderRadius: 12, paddingHorizontal: 16, paddingVertical: 12, fontSize: 24, fontWeight: "800", textAlign: "right", color: "#111827" },
});
