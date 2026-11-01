/**
 * Step 4 — the close (FIX 45).
 *
 *   sum of items + charges === confirmed total ?
 *
 * Green and done when it balances. When it does not, R2 (01-11-2026) asks
 * the host what the difference is (gapCard): a charge or discount with no
 * line of its own, or an item missing or read twice. "Aceitar" waits for
 * that answer; it used to say "aceitar mesmo assim" and save a split that
 * did not reach the printed total (Oligark, 30-10-2026).
 */
import React from "react";
import { View, Text, ScrollView, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "@/constants/colors";
import { useI18nStore } from "@/store/i18nStore";
import type { GapAnswer } from "@/lib/receipt/printedTotalGap";
import { StepHeader, PrimaryButton, SecondaryButton, LinkButton, useGuidedTheme, styles as shell } from "./GuidedShell";
import { ReceiptPhotoStrip } from "./ReceiptPhotoStrip";

interface Props {
  itemsSum: number;
  chargesSum: number;
  confirmedTotal: number;
  /** Signed: positive means the items overshoot the total. */
  difference: number;
  formatMoney: (value: number) => string;
  /** R2 — the question about the gap (renders nothing when there is none). */
  gapCard: React.ReactNode;
  /** R2 — the answer that holds for the current gap, if any. */
  gapAnswer: GapAnswer | null;
  /** R2 — false while the gap has no answer. */
  canAccept: boolean;
  onAccept: () => void;
  onReviewAgain: () => void;
  onBack: () => void;
  onSeeAll: () => void;
}

export function GuidedClosingStep({
  itemsSum,
  chargesSum,
  confirmedTotal,
  difference,
  formatMoney,
  gapCard,
  gapAnswer,
  canAccept,
  onAccept,
  onReviewAgain,
  onBack,
  onSeeAll,
}: Props) {
  const { textColor, mutedColor, cardColor, borderColor } = useGuidedTheme();
  const { t } = useI18nStore();
  const balances = canAccept;
  const signedGap = gapAnswer ? (gapAnswer.answer === "charge" ? gapAnswer.amount : -gapAnswer.amount) : 0;

  return (
    <>
      <StepHeader title="Confirmação" caption="3 de 3" onBack={onBack} />
      <ReceiptPhotoStrip />
      <ScrollView contentContainerStyle={shell.body} showsVerticalScrollIndicator={false}>
        {gapCard}

        <View
          style={[
            shell.card,
            {
              backgroundColor: balances ? cardColor : "#FEF2F2",
              borderColor: balances ? Colors.success : "#FCA5A5",
            },
          ]}
        >
          <View style={styles.verdictRow}>
            <Ionicons
              name={balances ? "checkmark-circle" : "warning"}
              size={22}
              color={balances ? Colors.success : "#DC2626"}
            />
            <Text style={[styles.verdict, { color: balances ? Colors.success : "#DC2626" }]}>
              {balances
                ? "As contas batem certo."
                : difference < 0
                ? `Faltam ${formatMoney(Math.abs(difference))} para o total.`
                : `Sobram ${formatMoney(difference)} face ao total.`}
            </Text>
          </View>

          <View style={styles.row}>
            <Text style={[styles.label, { color: mutedColor }]}>Soma dos pratos</Text>
            <Text style={[styles.value, { color: textColor }]}>{formatMoney(itemsSum)}</Text>
          </View>
          {chargesSum !== 0 && (
            <View style={styles.row}>
              <Text style={[styles.label, { color: mutedColor }]}>{t("gap_lined_charges")}</Text>
              <Text style={[styles.value, { color: textColor }]}>{formatMoney(chargesSum)}</Text>
            </View>
          )}
          {gapAnswer && (
            <View style={styles.row}>
              <Text style={[styles.label, { color: mutedColor }]}>{signedGap > 0 ? "+" : "−"} {gapAnswer.name}</Text>
              <Text style={[styles.value, { color: textColor }]}>{formatMoney(Math.abs(signedGap))}</Text>
            </View>
          )}
          <View style={[styles.divider, { backgroundColor: borderColor }]} />
          <View style={styles.row}>
            <Text style={[styles.label, { color: mutedColor, fontWeight: "700" }]}>
              {t("review_receipt_total_label")}
            </Text>
            <Text style={[styles.value, { color: textColor, fontSize: 17 }]}>
              {formatMoney(confirmedTotal)}
            </Text>
          </View>
        </View>

        <LinkButton label="Ver todos os itens" onPress={onSeeAll} />
      </ScrollView>

      <View style={[shell.actions, { borderTopColor: borderColor }]}>
        <SecondaryButton label="Rever outra vez" onPress={onReviewAgain} />
        <PrimaryButton
          label={balances ? "Aceitar" : t("gap_continue_blocked")}
          onPress={onAccept}
          tone={balances ? "success" : "warning"}
          disabled={!balances}
        />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  verdictRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  verdict: { fontSize: 16, fontWeight: "700", flex: 1, lineHeight: 22 },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  label: { fontSize: 14 },
  value: { fontSize: 15, fontWeight: "700" },
  divider: { height: StyleSheet.hairlineWidth },
});
