/**
 * Step 1 — what is wrong, in one or two plain sentences (FIX 45).
 *
 * Every sentence comes from lib/receipt-guidance.ts, which reads the
 * parser's own diagnosis. Nothing here decides what is wrong; it only says it.
 */
import React from "react";
import { View, Text, ScrollView, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "@/constants/colors";
import type { ReceiptProblem } from "@/lib/receipt-guidance";
import { summarizeProblems } from "@/lib/receipt-guidance";
import { StepHeader, PrimaryButton, SecondaryButton, useGuidedTheme, styles as shell } from "./GuidedShell";

interface Props {
  merchantName: string;
  problems: readonly ReceiptProblem[];
  onStart: () => void;
  onBack: () => void;
}

export function GuidedDiagnosisStep({ merchantName, problems, onStart, onBack }: Props) {
  const { textColor, mutedColor, cardColor, borderColor } = useGuidedTheme();
  const { headline, extraCount } = summarizeProblems(problems);

  return (
    <>
      <StepHeader title={merchantName} caption="1 de 4" onBack={onBack} />
      <ScrollView contentContainerStyle={shell.body} showsVerticalScrollIndicator={false}>
        <View style={[shell.card, { backgroundColor: cardColor, borderColor }]}>
          <View style={styles.headlineRow}>
            <Ionicons name="alert-circle" size={22} color={Colors.warning} />
            <Text style={[styles.headline, { color: textColor }]}>{headline}</Text>
          </View>

          {extraCount > 0 && (
            <Text style={[styles.extra, { color: mutedColor }]}>
              {extraCount === 1 ? "Há mais 1 coisa a rever." : `Há mais ${extraCount} coisas a rever.`}
            </Text>
          )}

          <Text style={[styles.lead, { color: mutedColor }]}>
            Vamos corrigir isto passo a passo. Começamos pelo total da fatura.
          </Text>
        </View>
      </ScrollView>

      <View style={[shell.actions, { borderTopColor: borderColor }]}>
        <SecondaryButton label="Voltar" onPress={onBack} />
        <PrimaryButton label="Começar" onPress={onStart} />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  headlineRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  headline: { fontSize: 17, fontWeight: "700", flex: 1, lineHeight: 24 },
  extra: { fontSize: 13, lineHeight: 19 },
  lead: { fontSize: 14, lineHeight: 20 },
});
