import React, { useMemo, useState } from "react";
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "@/constants/colors";
import { useI18nStore } from "@/store/i18nStore";
import type { EditableRow } from "@/lib/receipt-validator";
import type { GapAnswer, GapSuggestion, PrintedTotalGap } from "@/lib/receipt/printedTotalGap";
import { PrintedTotalGapCard } from "@/components/receipt/PrintedTotalGapCard";
import { MirrorLinePanel, type PanelLine } from "./MirrorLinePanel";

// R10 (owner, 03-11-2026) — the receipt review as a mirror of the paper, in
// the app's own colours (design: docs/design/revisao-espelho-app.png): the
// app's dark background and card, the "paper" only in the monospaced type,
// the dashed rules and the layout. Header "Confirmar a fatura · Passo 2 de 3
// · Compara com o papel" with the step bar and the currency button; lines
// red "!" (to confirm), green "✓" (confirmed) or plain; the end of the
// receipt; the R2 question as a red line at the end; Continuar only with no
// red lines. Colours come from constants/colors.ts only.

type Group = { key: string; ids: string[]; name: string; quantity: number; unitPrice: number; total: number; red: boolean; green: boolean; reason?: string; photoBox?: PanelLine["photoBox"] };

type Props = {
  merchant: string;
  date?: string;
  currencyLabel: string;
  items: (EditableRow & { photoBox?: PanelLine["photoBox"] })[];
  attentionIds: Set<string>;
  reasonFor: (id: string) => string;
  formatMoney: (v: number) => string;
  /** The currency card (CurrencyCard): shown when the currency is not known, or opened from the header. */
  currencyCard: React.ReactElement<{ startOpen?: boolean; onChoose: (code: string) => void }>;
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
  onContinue: () => void;
  onBack: () => void;
};

const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

// "2026-10-07" → "07/10/2026"; anything else as it came.
const showDate = (d?: string) => {
  const m = d ? /^(\d{4})-(\d{2})-(\d{2})/.exec(d) : null;
  return m ? `${m[3]}/${m[2]}/${m[1]}` : d;
};

export function MirrorReview(p: Props) {
  const { t } = useI18nStore();
  const [panel, setPanel] = useState<PanelLine | null>(null);
  const [gapOpen, setGapOpen] = useState(false);
  const [totalOpen, setTotalOpen] = useState(false);
  const [currencyOpen, setCurrencyOpen] = useState(false);

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
  const totalAddsUp = !noTotal && gapOk;
  const buttonLabel =
    redCount > 0 ? (redCount === 1 ? t("mirror_confirm_1") : t("mirror_confirm_n").replace("{n}", String(redCount)))
    : !p.currencyOk ? t("currency_continue_blocked")
    : noTotal ? t("mirror_total_missing")
    : !gapOk ? t("gap_continue_blocked") : t("mirror_continue");

  const open = (g: Group) => setPanel({ ids: g.ids, name: g.name, quantity: g.quantity, unitPrice: g.unitPrice, photoBox: g.photoBox });
  const showCurrency = !p.currencyOk || currencyOpen;

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <TouchableOpacity onPress={p.onBack} hitSlop={12} accessibilityRole="button" accessibilityLabel={t("back")}>
          <Ionicons name="arrow-back" size={26} color={Colors.textPrimaryDark} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{t("mirror_title")}</Text>
          <Text style={styles.subtitle}>{t("mirror_step").replace("{n}", "2").replace("{m}", "3")} · {t("mirror_compare")}</Text>
        </View>
        <TouchableOpacity style={styles.currencyPill} onPress={() => setCurrencyOpen((v) => !v)} accessibilityRole="button">
          <Text style={styles.currencyPillText}>{p.currencyLabel} · {t("currency_change")}</Text>
        </TouchableOpacity>
      </View>
      {/* C2 for this screen: photo → confirm → split */}
      <View style={styles.stepBar} accessibilityLabel={t("mirror_step").replace("{n}", "2").replace("{m}", "3")}>
        {[0, 1, 2].map((i) => (
          <View key={i} style={[styles.stepLine, i <= 1 && { backgroundColor: Colors.primary }]} />
        ))}
      </View>

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {showCurrency
          ? React.cloneElement(p.currencyCard, {
              startOpen: true,
              onChoose: (code: string) => { p.currencyCard.props.onChoose(code); setCurrencyOpen(false); },
            })
          : null}

        <View style={styles.paper}>
          <Text style={styles.merchant}>{p.merchant.toUpperCase()}</Text>
          {p.date ? <Text style={styles.date}>{showDate(p.date)}</Text> : null}
          <View style={styles.dashed} />

          {groups.map((g) => (
            <Pressable key={g.key} onPress={() => open(g)} style={[styles.line, g.red && styles.lineRed, !g.red && g.green && styles.lineGreen]} accessibilityRole="button">
              <View style={styles.lineMain}>
                {g.red ? <Ionicons name="alert-circle-outline" size={22} color={Colors.errorLight} style={styles.icon} />
                  : g.green ? <Ionicons name="checkmark-circle-outline" size={22} color={Colors.successLight} style={styles.icon} /> : null}
                <Text style={styles.lineName} numberOfLines={2}>{g.quantity} × {g.name || "—"}</Text>
                <Text style={styles.lineAmount}>{p.formatMoney(g.total)}</Text>
              </View>
              {g.red && g.reason ? <Text style={styles.reason}>{g.reason}</Text> : null}
            </Pressable>
          ))}

          {gapOpenLine && (
            <Pressable style={[styles.line, styles.lineRed]} onPress={() => setGapOpen(true)} accessibilityRole="button">
              <View style={styles.lineMain}>
                <Ionicons name="alert-circle-outline" size={22} color={Colors.errorLight} style={styles.icon} />
                <Text style={styles.lineName}>{p.gap.kind === "under" ? t("mirror_gap_under") : t("mirror_gap_over")}</Text>
                <Text style={styles.lineAmount}>{p.formatMoney(p.gap.amount)}</Text>
              </View>
            </Pressable>
          )}

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
            <Pressable style={styles.sumRow} onPress={() => setGapOpen(true)} accessibilityRole="button">
              <Text style={styles.sumLabel}>
                {answeredSigned >= 0 ? "+" : "−"} {p.gapAnswer.name || (answeredSigned >= 0 ? t("mirror_unlined") : t("mirror_discount"))}
              </Text>
              <Text style={styles.sumValue}>{p.formatMoney(Math.abs(answeredSigned))}</Text>
            </Pressable>
          )}
          <Pressable style={[styles.sumRow, noTotal && styles.lineRed]} onPress={() => setTotalOpen(true)} accessibilityRole="button">
            <Text style={[styles.totalLabel, totalAddsUp && { color: Colors.successLight }]}>{t("mirror_printed_total")} {totalAddsUp ? "✓" : ""}</Text>
            <Text style={[styles.totalValue, totalAddsUp && { color: Colors.successLight }]}>{noTotal ? "—" : p.formatMoney(p.confirmedTotal)}</Text>
          </Pressable>
          {p.gapAnswered && p.gapAnswer?.answer === "charge" && (
            <Text style={styles.note}>{t("mirror_proportional").replace("{amount}", p.formatMoney(p.gapAnswer.amount))}</Text>
          )}
        </View>

        <Text style={styles.legend}>{t("mirror_legend")}</Text>

        <View style={styles.actions}>
          <TouchableOpacity onPress={p.onAddItem} style={styles.addBtn} accessibilityRole="button">
            <Text style={styles.addText}>+ {t("mirror_add_missing")}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={p.onSeePhoto} style={styles.photoBtn} accessibilityRole="button">
            <Text style={styles.photoText}>{t("mirror_see_photo")}</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      <View style={styles.footer}>
        <TouchableOpacity style={[styles.continueBtn, !canContinue && styles.continueOff]} disabled={!canContinue} onPress={p.onContinue} accessibilityRole="button" accessibilityState={{ disabled: !canContinue }}>
          <Text style={[styles.continueText, !canContinue && { color: Colors.textMutedDark }]}>{buttonLabel}</Text>
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
          <Text style={styles.sheetLabel}>{t("mirror_total_edit")}</Text>
          <TextInput value={p.confirmedTotalText} onChangeText={p.onChangeTotal} keyboardType="decimal-pad" autoFocus style={styles.totalInput} placeholder="0,00" placeholderTextColor={Colors.textMutedDark} />
          <TouchableOpacity style={styles.continueBtn} onPress={() => setTotalOpen(false)} accessibilityRole="button">
            <Text style={styles.continueText}>{t("mirror_save")}</Text>
          </TouchableOpacity>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.bgDark },
  header: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 16, paddingTop: 12 },
  title: { fontSize: 22, fontWeight: "800", color: Colors.textPrimaryDark },
  subtitle: { fontSize: 14, color: Colors.textSecondaryDark, marginTop: 2 },
  currencyPill: { borderWidth: 1, borderColor: Colors.cardBorderDark, backgroundColor: Colors.cardDark, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8, minHeight: 40, justifyContent: "center", maxWidth: 140 },
  currencyPillText: { color: Colors.textPrimaryDark, fontSize: 13, fontWeight: "600", textAlign: "center" },
  stepBar: { flexDirection: "row", gap: 6, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 12 },
  stepLine: { flex: 1, height: 4, borderRadius: 2, backgroundColor: Colors.cardBorderDark },
  body: { paddingHorizontal: 16, paddingBottom: 24, gap: 12 },
  paper: { backgroundColor: Colors.cardDark, borderRadius: 16, borderWidth: 1, borderColor: Colors.cardBorderDark, paddingVertical: 16, paddingHorizontal: 12 },
  merchant: { fontFamily: MONO, fontSize: 16, fontWeight: "800", color: Colors.textPrimaryDark, textAlign: "center", letterSpacing: 1 },
  date: { fontFamily: MONO, fontSize: 14, color: Colors.textSecondaryDark, textAlign: "center", marginTop: 6 },
  dashed: { borderTopWidth: 1, borderStyle: "dashed", borderColor: Colors.cardBorderDark, marginVertical: 12, marginHorizontal: 4 },
  line: { paddingVertical: 8, paddingHorizontal: 8, borderRadius: 8, borderWidth: 1, borderColor: "transparent", marginVertical: 2 },
  lineRed: { backgroundColor: Colors.errorBg, borderColor: Colors.error },
  lineGreen: { backgroundColor: Colors.successBg, borderColor: Colors.success },
  lineMain: { flexDirection: "row", alignItems: "center" },
  icon: { marginRight: 8 },
  lineName: { flex: 1, fontFamily: MONO, fontSize: 15, color: Colors.textPrimaryDark },
  lineAmount: { fontFamily: MONO, fontSize: 15, color: Colors.textPrimaryDark, marginLeft: 8 },
  reason: { fontSize: 12, color: Colors.errorLight, marginLeft: 30, marginTop: 4 },
  sumRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4, paddingHorizontal: 8, borderRadius: 8 },
  sumLabel: { fontFamily: MONO, fontSize: 15, color: Colors.textPrimaryDark },
  sumValue: { fontFamily: MONO, fontSize: 15, color: Colors.textPrimaryDark },
  totalLabel: { fontFamily: MONO, fontSize: 16, fontWeight: "800", color: Colors.textPrimaryDark },
  totalValue: { fontFamily: MONO, fontSize: 16, fontWeight: "800", color: Colors.textPrimaryDark },
  note: { fontSize: 13, color: Colors.textSecondaryDark, paddingHorizontal: 8, marginTop: 6, lineHeight: 19 },
  legend: { fontSize: 14, color: Colors.textSecondaryDark, textAlign: "center", lineHeight: 20, paddingHorizontal: 8 },
  actions: { flexDirection: "row", gap: 12 },
  addBtn: { flex: 1, minHeight: 52, borderRadius: 14, borderWidth: 1.5, borderStyle: "dashed", borderColor: Colors.primary, alignItems: "center", justifyContent: "center", paddingHorizontal: 8 },
  addText: { color: Colors.primaryLight, fontWeight: "700", fontSize: 15 },
  photoBtn: { minHeight: 52, borderRadius: 14, borderWidth: 1, borderColor: Colors.cardBorderDark, backgroundColor: Colors.cardDark, alignItems: "center", justifyContent: "center", paddingHorizontal: 18 },
  photoText: { color: Colors.textPrimaryDark, fontWeight: "600", fontSize: 15 },
  footer: { padding: 16, borderTopWidth: StyleSheet.hairlineWidth, borderColor: Colors.cardBorderDark, backgroundColor: Colors.bgDark },
  continueBtn: { minHeight: 52, borderRadius: 14, backgroundColor: Colors.primary, alignItems: "center", justifyContent: "center", paddingHorizontal: 12 },
  continueOff: { backgroundColor: Colors.cardBorderDark },
  continueText: { color: Colors.white, fontWeight: "800", fontSize: 16, textAlign: "center" },
  backdrop: { flex: 1, backgroundColor: Colors.overlay },
  sheet: { position: "absolute", left: 0, right: 0, bottom: 0, backgroundColor: Colors.surfaceDark, borderTopLeftRadius: 18, borderTopRightRadius: 18, borderWidth: 1, borderColor: Colors.cardBorderDark, padding: 16, paddingBottom: 28, gap: 10 },
  sheetLabel: { fontSize: 13, color: Colors.textSecondaryDark, fontWeight: "600" },
  totalInput: { borderWidth: 1.5, borderColor: Colors.cardBorderDark, backgroundColor: Colors.cardDark, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 12, fontSize: 24, fontWeight: "800", textAlign: "right", color: Colors.textPrimaryDark },
});
