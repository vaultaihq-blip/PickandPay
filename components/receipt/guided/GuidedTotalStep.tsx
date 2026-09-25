/**
 * Step 2 — confirm the total (FIX 45).
 *
 * The total is the anchor everything else validates against. When the parser
 * could not identify one, this step is a blank question and becomes the most
 * important of the four.
 */
import React from "react";
import { View, Text, TextInput, ScrollView, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "@/constants/colors";
import { StepHeader, PrimaryButton, SecondaryButton, useGuidedTheme, styles as shell } from "./GuidedShell";

interface Props {
  merchantName: string;
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
  totalText,
  onChangeTotal,
  missingTotal,
  currencyLabel,
  onConfirm,
  onBack,
}: Props) {
  const { textColor, mutedColor, cardColor, borderColor } = useGuidedTheme();

  return (
    <>
      <StepHeader title={merchantName} caption="2 de 4" onBack={onBack} />
      <ScrollView
        contentContainerStyle={shell.body}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={[shell.card, { backgroundColor: cardColor, borderColor }]}>
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
