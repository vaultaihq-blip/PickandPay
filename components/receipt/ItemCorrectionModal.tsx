import React, { useCallback, useMemo, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  type CanonicalReceipt,
  type ReceiptEdit,
  moneyToDecimalString,
  parseMoneyString,
} from "@/lib/receipt";

/**
 * Targeted editor for a single item and its modifiers.
 *
 * The user should never be made to rebuild the whole receipt to fix one
 * misread line, so this edits exactly one item and closes.
 */

interface Props {
  visible: boolean;
  receipt: CanonicalReceipt;
  itemId: string | null;
  onClose: () => void;
  onSubmit: (edits: ReceiptEdit[]) => void;
}

export function ItemCorrectionModal({
  visible,
  receipt,
  itemId,
  onClose,
  onSubmit,
}: Props): React.JSX.Element | null {
  const item = useMemo(
    () => receipt.items.find((candidate) => candidate.id === itemId),
    [receipt.items, itemId]
  );

  const [name, setName] = useState<string>("");
  const [quantity, setQuantity] = useState<string>("1");
  const [unitPrice, setUnitPrice] = useState<string>("");
  const [modifierDrafts, setModifierDrafts] = useState<
    Record<string, { name: string; price: string; free: boolean }>
  >({});
  const [newModifierName, setNewModifierName] = useState<string>("");
  const [newModifierPrice, setNewModifierPrice] = useState<string>("");

  // Re-seed the form whenever a different item is opened.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (visible && item !== undefined && seededFor !== item.id) {
    setSeededFor(item.id);
    setName(item.name);
    setQuantity(String(item.quantity));
    setUnitPrice(
      item.unitPrice !== undefined ? moneyToDecimalString(item.unitPrice) : ""
    );
    setModifierDrafts(
      Object.fromEntries(
        item.modifiers.map((modifier) => [
          modifier.id,
          {
            name: modifier.name,
            price: moneyToDecimalString(modifier.price),
            free: modifier.kind === "free",
          },
        ])
      )
    );
    setNewModifierName("");
    setNewModifierPrice("");
  }

  const handleSave = useCallback(() => {
    if (item === undefined) return;
    const edits: ReceiptEdit[] = [];

    const trimmedName = name.trim();
    if (trimmedName.length > 0 && trimmedName !== item.name) {
      edits.push({ kind: "set_item_name", itemId: item.id, name: trimmedName });
    }

    const parsedQuantity = Number.parseInt(quantity, 10);
    if (Number.isFinite(parsedQuantity) && parsedQuantity >= 1 &&
        parsedQuantity !== item.quantity) {
      edits.push({
        kind: "set_item_quantity",
        itemId: item.id,
        quantity: parsedQuantity,
      });
    }

    const parsedPrice = parseMoneyString(unitPrice, receipt.currency);
    if (parsedPrice !== null &&
        parsedPrice.minor !== (item.unitPrice?.minor ?? -1)) {
      edits.push({
        kind: "set_item_unit_price",
        itemId: item.id,
        unitPrice: parsedPrice,
      });
    }

    for (const modifier of item.modifiers) {
      const draft = modifierDrafts[modifier.id];
      if (draft === undefined) continue;

      const draftName = draft.name.trim();
      if (draftName.length > 0 && draftName !== modifier.name) {
        edits.push({
          kind: "set_modifier_name",
          itemId: item.id,
          modifierId: modifier.id,
          name: draftName,
        });
      }

      const wasFree = modifier.kind === "free";
      if (draft.free !== wasFree) {
        edits.push({
          kind: "set_modifier_free",
          itemId: item.id,
          modifierId: modifier.id,
          free: draft.free,
        });
      }

      if (!draft.free) {
        const draftPrice = parseMoneyString(draft.price, receipt.currency);
        if (draftPrice !== null && draftPrice.minor !== modifier.price.minor) {
          edits.push({
            kind: "set_modifier_price",
            itemId: item.id,
            modifierId: modifier.id,
            price: draftPrice,
          });
        }
      }
    }

    const addedName = newModifierName.trim();
    if (addedName.length > 0) {
      const addedPrice = parseMoneyString(newModifierPrice, receipt.currency);
      edits.push({
        kind: "add_modifier",
        itemId: item.id,
        name: addedName,
        price: addedPrice ?? { minor: 0, currency: receipt.currency },
        free: addedPrice === null || addedPrice.minor === 0,
      });
    }

    onSubmit(edits);
    setSeededFor(null);
    onClose();
  }, [
    item,
    name,
    quantity,
    unitPrice,
    modifierDrafts,
    newModifierName,
    newModifierPrice,
    receipt.currency,
    onSubmit,
    onClose,
  ]);

  const handleRemoveModifier = useCallback(
    (modifierId: string) => {
      if (item === undefined) return;
      onSubmit([{ kind: "remove_modifier", itemId: item.id, modifierId }]);
      setSeededFor(null);
      onClose();
    },
    [item, onSubmit, onClose]
  );

  const handleRemoveItem = useCallback(() => {
    if (item === undefined) return;
    onSubmit([{ kind: "remove_item", itemId: item.id }]);
    setSeededFor(null);
    onClose();
  }, [item, onSubmit, onClose]);

  if (item === undefined) return null;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.sheet}>
          <View style={styles.handle} />

          <View style={styles.titleRow}>
            <Text style={styles.title}>Fix this item</Text>
            <Pressable onPress={onClose} accessibilityRole="button" hitSlop={10}>
              <Ionicons name="close" size={22} color={MUTED} />
            </Pressable>
          </View>

          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
          >
            <Field label="Name">
              <TextInput
                style={styles.input}
                value={name}
                onChangeText={setName}
                placeholder="Item name"
                placeholderTextColor={MUTED}
              />
            </Field>

            <View style={styles.pair}>
              <Field label="Quantity" style={styles.pairItem}>
                <TextInput
                  style={styles.input}
                  value={quantity}
                  onChangeText={setQuantity}
                  keyboardType="number-pad"
                  placeholder="1"
                  placeholderTextColor={MUTED}
                />
              </Field>
              <Field
                label={`Unit price (${receipt.currency})`}
                style={styles.pairItem}
              >
                <TextInput
                  style={styles.input}
                  value={unitPrice}
                  onChangeText={setUnitPrice}
                  keyboardType="decimal-pad"
                  placeholder="0.00"
                  placeholderTextColor={MUTED}
                />
              </Field>
            </View>

            <Text style={styles.sectionLabel}>Extras</Text>

            {item.modifiers.length === 0 && (
              <Text style={styles.empty}>No extras on this item yet.</Text>
            )}

            {item.modifiers.map((modifier) => {
              const draft = modifierDrafts[modifier.id] ?? {
                name: modifier.name,
                price: moneyToDecimalString(modifier.price),
                free: modifier.kind === "free",
              };
              return (
                <View key={modifier.id} style={styles.modifierRow}>
                  <TextInput
                    style={[styles.input, styles.modifierName]}
                    value={draft.name}
                    onChangeText={(value) =>
                      setModifierDrafts((current) => ({
                        ...current,
                        [modifier.id]: { ...draft, name: value },
                      }))
                    }
                    placeholder="Extra"
                    placeholderTextColor={MUTED}
                  />
                  <TextInput
                    style={[
                      styles.input,
                      styles.modifierPrice,
                      draft.free && styles.inputDisabled,
                    ]}
                    value={draft.free ? "" : draft.price}
                    editable={!draft.free}
                    onChangeText={(value) =>
                      setModifierDrafts((current) => ({
                        ...current,
                        [modifier.id]: { ...draft, price: value },
                      }))
                    }
                    keyboardType="decimal-pad"
                    placeholder={draft.free ? "free" : "0.00"}
                    placeholderTextColor={MUTED}
                  />
                  <Pressable
                    onPress={() =>
                      setModifierDrafts((current) => ({
                        ...current,
                        [modifier.id]: { ...draft, free: !draft.free },
                      }))
                    }
                    style={styles.iconButton}
                    accessibilityRole="button"
                    accessibilityLabel={
                      draft.free ? "Mark as paid" : "Mark as free"
                    }
                  >
                    <Ionicons
                      name={draft.free ? "pricetag-outline" : "pricetag"}
                      size={17}
                      color={draft.free ? MUTED : ACCENT}
                    />
                  </Pressable>
                  <Pressable
                    onPress={() => handleRemoveModifier(modifier.id)}
                    style={styles.iconButton}
                    accessibilityRole="button"
                    accessibilityLabel="Remove extra"
                  >
                    <Ionicons name="trash-outline" size={17} color={DANGER} />
                  </Pressable>
                </View>
              );
            })}

            <View style={styles.modifierRow}>
              <TextInput
                style={[styles.input, styles.modifierName]}
                value={newModifierName}
                onChangeText={setNewModifierName}
                placeholder="Add an extra"
                placeholderTextColor={MUTED}
              />
              <TextInput
                style={[styles.input, styles.modifierPrice]}
                value={newModifierPrice}
                onChangeText={setNewModifierPrice}
                keyboardType="decimal-pad"
                placeholder="0.00"
                placeholderTextColor={MUTED}
              />
            </View>

            <Pressable
              onPress={handleRemoveItem}
              style={styles.removeItem}
              accessibilityRole="button"
            >
              <Ionicons name="trash-outline" size={16} color={DANGER} />
              <Text style={styles.removeItemText}>Remove this item</Text>
            </Pressable>
          </ScrollView>

          <Pressable
            style={styles.save}
            onPress={handleSave}
            accessibilityRole="button"
          >
            <Text style={styles.saveText}>Save and recheck</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Field({
  label,
  children,
  style,
}: {
  label: string;
  children: React.ReactNode;
  style?: object;
}): React.JSX.Element {
  return (
    <View style={[styles.field, style]}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

// ─── Theme ────────────────────────────────────────────────────────────────────

const MUTED = "#8A8F98";
const ACCENT = "#6366F1";
const DANGER = "#EF4444";
const BORDER = "#232830";

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "#000000AA" },
  sheet: {
    backgroundColor: "#0F1115",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 18,
    paddingBottom: 24,
    paddingTop: 10,
    maxHeight: "88%",
  },
  handle: {
    alignSelf: "center",
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: BORDER,
    marginBottom: 12,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 14,
  },
  title: { color: "#FFFFFF", fontSize: 18, fontWeight: "700" },

  scroll: { flexGrow: 0 },
  scrollContent: { gap: 14, paddingBottom: 12 },

  field: { gap: 6 },
  fieldLabel: {
    color: MUTED,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  input: {
    backgroundColor: "#14171C",
    borderWidth: 1,
    borderColor: BORDER,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    color: "#FFFFFF",
    fontSize: 15,
  },
  inputDisabled: { opacity: 0.45 },

  pair: { flexDirection: "row", gap: 10 },
  pairItem: { flex: 1 },

  sectionLabel: {
    color: MUTED,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.5,
    textTransform: "uppercase",
    marginTop: 4,
  },
  empty: { color: MUTED, fontSize: 13 },

  modifierRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  modifierName: { flex: 1 },
  modifierPrice: { width: 92, textAlign: "right" },
  iconButton: { padding: 6 },

  removeItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 10,
    paddingVertical: 8,
  },
  removeItemText: { color: DANGER, fontSize: 14, fontWeight: "500" },

  save: {
    backgroundColor: ACCENT,
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: "center",
    marginTop: 12,
  },
  saveText: { color: "#FFFFFF", fontSize: 16, fontWeight: "600" },
});
