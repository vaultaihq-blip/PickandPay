/**
 * R2 — the difference between the items (plus their own charge lines) and
 * the printed total, as a question the host has to answer before Continue:
 *
 *   under → "É um encargo ou falta um item?"
 *   over  → "É um desconto ou um item a mais?"
 *
 * The likely answer comes pre-chosen when the receipt gives a clue, but only
 * "Confirmar" answers it. A confirmed answer turns green and can be changed;
 * if the items are edited afterwards the gap changes and the question comes
 * back (see answerHolds).
 */
import React, { useEffect, useState } from "react";
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useI18nStore } from "@/store/i18nStore";
import { answerHolds, type GapAnswer, type GapSuggestion, type PrintedTotalGap } from "@/lib/receipt/printedTotalGap";

interface Props {
  gap: PrintedTotalGap;
  answer: GapAnswer | null;
  suggestion: GapSuggestion;
  formatMoney: (value: number) => string;
  onAnswer: (answer: GapAnswer | null) => void;
  /** "Adicionar item em falta" (under). */
  onAddMissing: () => void;
  /** "Rever os itens" (over: an item read twice or that is not on the paper). */
  onReviewItems: () => void;
}

const RED = { bg: "#FEF2F2", border: "#DC2626", text: "#7F1D1D" };
const GREEN = { bg: "#F0FDF4", border: "#16A34A", text: "#14532D" };

export function PrintedTotalGapCard({ gap, answer, suggestion, formatMoney, onAnswer, onAddMissing, onReviewItems }: Props) {
  const { t } = useI18nStore();
  const under = gap.kind === "under";
  const defaultName = t(under ? "gap_charge_default" : "gap_discount_default");
  const [open, setOpen] = useState(suggestion !== null);
  const [name, setName] = useState(defaultName);

  // A new gap (the items changed) starts from the suggestion again.
  useEffect(() => {
    setOpen(suggestion !== null);
  }, [gap.kind, gap.amount, suggestion]);

  if (gap.kind === "none") return null;
  const amount = formatMoney(gap.amount);

  if (answerHolds(gap, answer)) {
    return (
      <View style={[styles.card, { backgroundColor: GREEN.bg, borderColor: GREEN.border }]}>
        <View style={styles.titleRow}>
          <Ionicons name="checkmark-circle" size={22} color={GREEN.border} />
          <Text style={[styles.title, { color: GREEN.text }]}>
            {answer!.name} · {under ? "+" : "−"}{amount}
          </Text>
        </View>
        <Text style={[styles.body, { color: GREEN.text }]}>
          {t(under ? "gap_split_note_charge" : "gap_split_note_discount").replace("{amount}", amount)}
        </Text>
        <TouchableOpacity style={styles.linkBtn} onPress={() => onAnswer(null)} activeOpacity={0.7}>
          <Text style={[styles.linkText, { color: GREEN.text }]}>{t("gap_change")}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const confirm = () => {
    const trimmed = name.trim() || defaultName;
    console.log(`[review-receipt] R2 gap answered: ${under ? "charge" : "discount"} "${trimmed}" ${gap.amount}`);
    onAnswer({ answer: under ? "charge" : "discount", name: trimmed, amount: gap.amount });
  };

  return (
    <View style={[styles.card, { backgroundColor: RED.bg, borderColor: RED.border }]}>
      <View style={styles.titleRow}>
        <Ionicons name="alert-circle" size={22} color={RED.border} />
        <Text style={[styles.title, { color: RED.text }]}>
          {t(under ? "gap_under_title" : "gap_over_title").replace("{amount}", amount)}
        </Text>
      </View>
      <Text style={[styles.question, { color: RED.text }]}>
        {t(under ? "gap_under_question" : "gap_over_question")}
      </Text>
      {suggestion !== null && (
        <Text style={[styles.body, { color: RED.text }]}>
          {t(suggestion === "charge" ? "gap_suggested_charge" : "gap_suggested_discount")}
        </Text>
      )}

      <View style={styles.choices}>
        <TouchableOpacity
          style={[styles.choice, { borderColor: RED.border }]}
          onPress={under ? onAddMissing : onReviewItems}
          activeOpacity={0.8}
        >
          <Ionicons name={under ? "add" : "list"} size={18} color={RED.text} />
          <Text style={[styles.choiceText, { color: RED.text }]}>
            {t(under ? "gap_add_missing" : "gap_review_items")}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.choice, { borderColor: RED.border }, open && { backgroundColor: RED.border }]}
          onPress={() => setOpen(true)}
          activeOpacity={0.8}
          accessibilityState={{ selected: open }}
        >
          <Ionicons name={open ? "radio-button-on" : "radio-button-off"} size={18} color={open ? "#fff" : RED.text} />
          <Text style={[styles.choiceText, { color: open ? "#fff" : RED.text }]}>
            {t(under ? "gap_is_charge" : "gap_is_discount")}
          </Text>
        </TouchableOpacity>
      </View>

      {open && (
        <View style={styles.nameBlock}>
          <Text style={[styles.label, { color: RED.text }]}>{t("gap_name_label")}</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder={defaultName}
            placeholderTextColor="#B91C1C99"
            maxLength={40}
            style={[styles.input, { color: RED.text, borderColor: RED.border }]}
          />
          <TouchableOpacity style={[styles.confirmBtn, { backgroundColor: RED.border }]} onPress={confirm} activeOpacity={0.85}>
            <Text style={styles.confirmText}>{t("gap_confirm")}</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 2, borderRadius: 14, padding: 16, gap: 10 },
  titleRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  title: { flex: 1, fontSize: 16, fontWeight: "700", lineHeight: 22 },
  question: { fontSize: 15, fontWeight: "600" },
  body: { fontSize: 14, lineHeight: 20 },
  choices: { gap: 8 },
  choice: {
    minHeight: 48,
    borderWidth: 1.5,
    borderRadius: 12,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  choiceText: { fontSize: 15, fontWeight: "600", flexShrink: 1 },
  nameBlock: { gap: 6 },
  label: { fontSize: 13, fontWeight: "600" },
  input: { minHeight: 48, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, fontSize: 15, backgroundColor: "#fff" },
  confirmBtn: { minHeight: 48, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  confirmText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  linkBtn: { minHeight: 44, justifyContent: "center", alignSelf: "flex-start" },
  linkText: { fontSize: 14, fontWeight: "600", textDecorationLine: "underline" },
});
