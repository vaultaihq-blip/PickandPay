import React, { useState } from "react";
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "@/constants/colors";
import { normalizeCurrencyCode } from "@/lib/receipt/money";
import { getCurrencySymbol } from "@/utils/formatter";
import { useI18nStore } from "@/store/i18nStore";
import type { Currency } from "@/types";

// Currency point (02-11-2026) — the receipt's currency, in the review.
// - Known: "Moeda: TRY (₺) · Alterar" — the host can always correct it
//   (a parser that read no currency answers EUR, and the app can't tell).
// - Not known (`ask`): a red question, "Qual é a moeda desta fatura?",
//   and the receipt is not accepted until it is answered.
type Props = {
  currency: Currency;
  ask: boolean;
  onChoose: (code: Currency) => void;
  textColor: string;
  mutedColor: string;
  cardColor: string;
  borderColor: string;
  /** R10: opened from the header's "TRY ₺ · Alterar" button — shown expanded. */
  startOpen?: boolean;
};

const COMMON: Currency[] = ["EUR", "USD", "GBP", "TRY", "CHF", "BRL"];

export function CurrencyCard({ currency, ask, onChoose, textColor, mutedColor, cardColor, borderColor, startOpen = false }: Props) {
  const { t } = useI18nStore();
  const [open, setOpen] = useState(startOpen);
  const [other, setOther] = useState("");
  const [otherError, setOtherError] = useState(false);
  const expanded = ask || open;

  const choose = (code: Currency) => {
    console.log(`[review-receipt] currency chosen by the host: ${code}${ask ? " (was not known)" : ` (was ${currency})`}`);
    onChoose(code);
    setOpen(false);
    setOther("");
    setOtherError(false);
  };

  const useOther = () => {
    const code = normalizeCurrencyCode(other);
    if (!code) {
      setOtherError(true);
      return;
    }
    choose(code);
  };

  const chips = ask ? COMMON : [currency, ...COMMON.filter((c) => c !== currency)];

  return (
    <View
      style={[
        styles.card,
        ask
          ? { backgroundColor: Colors.errorBg, borderColor: Colors.error }
          : { backgroundColor: cardColor, borderColor },
      ]}
    >
      {ask ? (
        <>
          <View style={styles.row}>
            <Ionicons name="alert-circle" size={18} color={Colors.errorLight} />
            <Text style={[styles.title, { color: textColor }]}>{t("currency_ask_title")}</Text>
          </View>
          <Text style={[styles.msg, { color: mutedColor }]}>{t("currency_ask_msg")}</Text>
        </>
      ) : (
        <View style={styles.row}>
          <Text style={[styles.label, { color: mutedColor }]}>{t("currency_label")}</Text>
          <Text style={[styles.value, { color: textColor }]}>
            {currency} ({getCurrencySymbol(currency)})
          </Text>
          <TouchableOpacity onPress={() => setOpen((v) => !v)} accessibilityRole="button">
            <Text style={styles.link}>{open ? t("cancel") : t("currency_change")}</Text>
          </TouchableOpacity>
        </View>
      )}

      {expanded && (
        <>
          <View style={styles.chips}>
            {chips.map((code) => {
              const current = !ask && code === currency;
              return (
                <TouchableOpacity
                  key={code}
                  style={[styles.chip, { borderColor: current ? Colors.primary : borderColor }, current && styles.chipOn]}
                  onPress={() => choose(code)}
                  accessibilityRole="button"
                >
                  <Text style={[styles.chipText, { color: current ? "#fff" : textColor }]}>
                    {code} {getCurrencySymbol(code) !== code ? getCurrencySymbol(code) : ""}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <View style={styles.row}>
            <TextInput
              value={other}
              onChangeText={(v) => { setOther(v); setOtherError(false); }}
              placeholder={t("currency_other_placeholder")}
              placeholderTextColor={mutedColor}
              autoCapitalize="characters"
              maxLength={4}
              style={[styles.input, { color: textColor, borderColor }]}
            />
            <TouchableOpacity
              style={[styles.useBtn, !other.trim() && { opacity: 0.45 }]}
              onPress={useOther}
              disabled={!other.trim()}
              accessibilityRole="button"
            >
              <Text style={styles.useBtnText}>{t("currency_use")}</Text>
            </TouchableOpacity>
          </View>
          {otherError && <Text style={styles.error}>{t("currency_other_invalid")}</Text>}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 10, marginBottom: 12 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { fontSize: 15, fontWeight: "700", flex: 1 },
  msg: { fontSize: 13, lineHeight: 19 },
  label: { fontSize: 13 },
  value: { fontSize: 14, fontWeight: "700", flex: 1 },
  link: { color: Colors.primary, fontSize: 13, fontWeight: "700" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { borderWidth: 1.5, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 },
  chipOn: { backgroundColor: Colors.primary },
  chipText: { fontSize: 13, fontWeight: "700" },
  input: { flex: 1, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, fontSize: 14 },
  useBtn: { backgroundColor: Colors.primary, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 9 },
  useBtnText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  error: { color: Colors.errorLight, fontSize: 12, lineHeight: 17 },
});
