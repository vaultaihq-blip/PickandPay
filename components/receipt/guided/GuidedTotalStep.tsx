/**
 * Step 1 of 3 — what's wrong, and confirm the total (FIX 46).
 *
 * FIX 45 had this as two screens (diagnosis, then total). FIX 46 merges them:
 * the total is the anchor everything else validates against, so the
 * explanation of what's wrong belongs right next to the question that
 * matters most, not on a screen the user has to click past.
 */
import React from "react";
import { View, Text, TextInput, ScrollView, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "@/constants/colors";
import type { ReceiptProblem } from "@/lib/receipt-guidance";
import { summarizeProblems } from "@/lib/receipt-guidance";
import { StepHeader, PrimaryButton, SecondaryButton, useGuidedTheme, styles as shell } from "./GuidedShell";
import { ReceiptPhotoStrip } from "./ReceiptPhotoStrip";

interface Props {
  merchantName: string;
  problems: readonly ReceiptProblem[];
  /** Raw text of the total field — owned by the parent so edits survive navigation. */
  totalText: string;
  onChangeTotal: (raw: string) => void;
  /** True when the receipt printed no total the parser could identify. */
  missingTotal: boolean;
  currencyLabel: string;
  onConfirm: () => void;
  onBack: () => void;
}

export function GuidedTotalStep({
  merchantName,
  problems,
  totalText,
  onChangeTotal,
  missingTotal,
  currencyLabel,
  onConfirm,
  onBack,
}: Props) {
  const { textColor, mutedColor, cardColor, borderColor } = useGuidedTheme();
  const { headline, extraCount } = summarizeProblems(problems);

  return (
    <>
      <StepHeader title={merchantName} caption="1 de 3" onBack={onBack} />
      <ReceiptPhotoStrip />
      <ScrollView
        contentContainerStyle={shell.body}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={[shell.card, { backgroundColor: cardColor, borderColor }]}>
          <View style={styles.headlineRow}>
            <Ionicons name="alert-circle" size={20} color={Colors.warning} />
            <Text style={[styles.headline, { color: textColor }]}>{headline}</Text>
          </View>
          {extraCount > 0 && (
            <Text style={[styles.extra, { color: mutedColor }]}>
              {extraCount === 1 ? "Há mais 1 coisa a rever." : `Há mais ${extraCount} coisas a rever.`}
            </Text>
          )}

          <View style={[styles.divider, { backgroundColor: borderColor }]} />

          <Text style={[styles.question, { color: textColor }]}>
            {missingTotal
              ? "Qual é o total desta fatura?"
              : "O total da fatura está certo?"}
          </Text>

          {missingTotal && (
            <View style={styles.noticeRow}>
              <Ionicons name="information-circle" size={16} color={Colors.warning} />
              <Text style={[styles.notice, { color: mutedColor }]}>
                Não consegui lê-lo. Escreve o valor que está no papel.
              </Text>
            </View>
          )}

          <Text style={[shell.fieldLabel, { color: mutedColor }]}>Total ({currencyLabel})</Text>
          <TextInput
            value={totalText}
            onChangeText={onChangeTotal}
            keyboardType="decimal-pad"
            placeholder="0.00"
            placeholderTextColor={mutedColor}
            autoFocus={missingTotal}
            style={[styles.totalInput, { color: textColor, borderColor }]}
          />

          <Text style={[styles.hint, { color: mutedColor }]}>
            É este valor que vamos usar para verificar tudo o resto.
          </Text>
        </View>
      </ScrollView>

      <View style={[shell.actions, { borderTopColor: borderColor }]}>
        <SecondaryButton label="Atrás" onPress={onBack} />
        <PrimaryButton label="Confirmar total" onPress={onConfirm} />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  headlineRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  headline: { fontSize: 16, fontWeight: "700", flex: 1, lineHeight: 22 },
  extra: { fontSize: 13, lineHeight: 19 },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: 2 },
  question: { fontSize: 17, fontWeight: "700", lineHeight: 24 },
  noticeRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  notice: { fontSize: 13, lineHeight: 19, flex: 1 },
  totalInput: {
    borderWidth: 1.5,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 28,
    fontWeight: "800",
    textAlign: "right",
  },
  hint: { fontSize: 12, lineHeight: 18, fontStyle: "italic" },
});
