/**
 * Step 3 — one item per screen (FIX 45).
 *
 * The three fields and their rule are FIX 44's, unchanged: the parent owns
 * the edit logic (quantity x unitPrice = total, last field edited wins) and
 * this component only renders it, so there is exactly one implementation.
 */
import React from "react";
import { View, Text, TextInput, ScrollView, TouchableOpacity, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "@/constants/colors";
import type { EditableRow } from "@/lib/receipt-validator";
import { StepHeader, PrimaryButton, SecondaryButton, LinkButton, useGuidedTheme, styles as shell } from "./GuidedShell";
import { ReceiptPhotoStrip } from "./ReceiptPhotoStrip";

export type ItemField = "name" | "quantity" | "unitPrice" | "totalPrice";

interface Props {
  item: EditableRow;
  /** 1-based position in the attention queue. */
  position: number;
  total: number;
  /** Why this item is in the queue, when the parser said something specific. */
  reason?: string;
  currencyLabel: string;
  onChangeField: (id: string, field: ItemField, raw: string) => void;
  onToggleReviewed: (id: string) => void;
  onConfirm: () => void;
  onSkip: () => void;
  onBack: () => void;
  onSeeAll: () => void;
}

export function GuidedItemStep({
  item,
  position,
  total,
  reason,
  currencyLabel,
  onChangeField,
  onToggleReviewed,
  onConfirm,
  onSkip,
  onBack,
  onSeeAll,
}: Props) {
  const { textColor, mutedColor, cardColor, borderColor } = useGuidedTheme();

  return (
    <>
      <StepHeader title="Rever prato" caption={`item ${position} de ${total}`} onBack={onBack} />
      <ReceiptPhotoStrip />
      <ScrollView
        contentContainerStyle={shell.body}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={[shell.card, { backgroundColor: cardColor, borderColor }]}>
          {reason && (
            <View style={styles.reasonRow}>
              <Ionicons name="alert-circle-outline" size={16} color={Colors.warning} />
              <Text style={[styles.reason, { color: mutedColor }]}>{reason}</Text>
            </View>
          )}

          <View style={styles.nameRow}>
            <TextInput
              value={item.name}
              onChangeText={(v) => onChangeField(item.id, "name", v)}
              placeholder="Nome do prato"
              placeholderTextColor={mutedColor}
              style={[styles.nameInput, { color: textColor, borderColor }]}
            />
            <TouchableOpacity
              onPress={() => onToggleReviewed(item.id)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Ionicons
                name={item.reviewed ? "checkmark-circle" : "checkmark-circle-outline"}
                size={24}
                color={item.reviewed ? Colors.success : mutedColor}
              />
            </TouchableOpacity>
          </View>

          <View style={styles.fieldRow}>
            <View style={styles.fieldCol}>
              <Text style={[shell.fieldLabel, { color: mutedColor }]}>Qtd</Text>
              <TextInput
                value={item.qtyText}
                onChangeText={(v) => onChangeField(item.id, "quantity", v)}
                keyboardType="number-pad"
                style={[shell.fieldInput, { color: textColor, borderColor }]}
              />
            </View>
            <View style={styles.fieldCol}>
              <Text style={[shell.fieldLabel, { color: mutedColor }]}>Preço un.</Text>
              <TextInput
                value={item.unitPriceText}
                onChangeText={(v) => onChangeField(item.id, "unitPrice", v)}
                keyboardType="decimal-pad"
                style={[shell.fieldInput, { color: textColor, borderColor }]}
              />
            </View>
            <View style={styles.fieldCol}>
              <Text style={[shell.fieldLabel, { color: mutedColor }]}>Total</Text>
              <TextInput
                value={item.totalText}
                onChangeText={(v) => onChangeField(item.id, "totalPrice", v)}
                keyboardType="decimal-pad"
                style={[shell.fieldInput, { color: Colors.primary, borderColor, fontWeight: "700" }]}
              />
            </View>
          </View>

          <Text style={[styles.hint, { color: mutedColor }]}>
            Valores em {currencyLabel}. O total da linha é o que conta para a conta.
          </Text>
        </View>

        <LinkButton label="Ver todos os itens" onPress={onSeeAll} />
      </ScrollView>

      <View style={[shell.actions, { borderTopColor: borderColor }]}>
        <SecondaryButton label="Saltar" onPress={onSkip} />
        <PrimaryButton
          label={position === total ? "Confirmar e terminar" : "Confirmar e seguinte"}
          onPress={onConfirm}
        />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  reasonRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  reason: { fontSize: 13, lineHeight: 19, flex: 1 },
  nameRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  nameInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    fontWeight: "600",
  },
  fieldRow: { flexDirection: "row", gap: 8 },
  fieldCol: { flex: 1, gap: 4 },
  hint: { fontSize: 12, lineHeight: 18, fontStyle: "italic" },
});
