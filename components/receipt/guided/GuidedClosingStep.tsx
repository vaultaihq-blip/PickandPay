/**
 * Step 4 — the close (FIX 45).
 *
 *   sum of items + charges === confirmed total ?
 *
 * Green and done when it balances; when it does not, it says how much is
 * missing or over and offers both ways out. The user is never trapped here:
 * "aceitar mesmo assim" is always available, because they are looking at the
 * paper and may well be right against the app.
 */
import React from "react";
import { View, Text, ScrollView, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "@/constants/colors";
import { StepHeader, PrimaryButton, SecondaryButton, LinkButton, useGuidedTheme, styles as shell } from "./GuidedShell";

interface Props {
  itemsSum: number;
  chargesSum: number;
  confirmedTotal: number;
  /** Signed: positive means the items overshoot the total. */
  difference: number;
  formatMoney: (value: number) => string;
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
  onAccept,
  onReviewAgain,
  onBack,
  onSeeAll,
}: Props) {
  const { textColor, mutedColor, cardColor, borderColor } = useGuidedTheme();
  const balances = Math.abs(difference) < 0.01;

  return (
    <>
      <StepHeader title="Confirmação" caption="4 de 4" onBack={onBack} />
      <ScrollView contentContainerStyle={shell.body} showsVerticalScrollIndicator={false}>
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
              <Text style={[styles.label, { color: mutedColor }]}>Taxas e serviço</Text>
              <Text style={[styles.value, { color: textColor }]}>{formatMoney(chargesSum)}</Text>
            </View>
          )}
          <View style={[styles.divider, { backgroundColor: borderColor }]} />
          <View style={styles.row}>
            <Text style={[styles.label, { color: mutedColor, fontWeight: "700" }]}>
              Total confirmado
            </Text>
            <Text style={[styles.value, { color: textColor, fontSize: 17 }]}>
              {formatMoney(confirmedTotal)}
            </Text>
          </View>
        </View>

        {!balances && (
          <Text style={[styles.freeText, { color: mutedColor }]}>
            Se o que escreveste está certo, aceita mesmo assim — estás a olhar para o papel.
          </Text>
        )}

        <LinkButton label="Ver todos os itens" onPress={onSeeAll} />
      </ScrollView>

      <View style={[shell.actions, { borderTopColor: borderColor }]}>
        <SecondaryButton label="Rever outra vez" onPress={onReviewAgain} />
        <PrimaryButton
          label={balances ? "Aceitar" : "Aceitar mesmo assim"}
          onPress={onAccept}
          tone={balances ? "success" : "warning"}
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
  freeText: { fontSize: 13, lineHeight: 19, fontStyle: "italic", paddingHorizontal: 4 },
});
