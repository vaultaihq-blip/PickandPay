import React, { useState, useMemo, useEffect, useCallback } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Image,
  Modal,
  StyleSheet,
  useColorScheme,
  Alert,
  KeyboardAvoidingView,
  Platform,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "@/constants/colors";
import { useReceiptStore } from "@/store/receiptStore";
import { validateEditableItems, EditableItem } from "@/lib/receipt-validator";
import { ItemCategory, ParsedReceipt, ReceiptItem } from "@/types";
import { useSessionStore } from "@/store/sessionStore";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CATEGORIES: ItemCategory[] = [
  "starters", "mains", "drinks", "desserts", "others",
];

const STRICT_TOLERANCE = 0.01;

function flattenItems(receipt: ParsedReceipt): EditableItem[] {
  const result: EditableItem[] = [];
  for (const cat of CATEGORIES) {
    for (const item of receipt.categories[cat] ?? []) {
      result.push({
        id: item.id,
        category: cat,
        name: item.name,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        totalPrice: item.totalPrice,
      });
    }
  }
  return result;
}

function rebuildReceipt(original: ParsedReceipt, items: EditableItem[]): ParsedReceipt {
  const categories: ParsedReceipt["categories"] = {
    starters: [], mains: [], drinks: [], desserts: [], others: [],
  };
  for (const item of items) {
    if (item.name.trim() === "") continue;
    const cat = (CATEGORIES.includes(item.category as ItemCategory)
      ? item.category : "others") as ItemCategory;
    categories[cat].push({
      id: item.id,
      name: item.name,
      category: cat,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      totalPrice: item.totalPrice,
      type: "individual",
    } as ReceiptItem);
  }
  const computedTotal = Math.round(items.reduce((s, i) => s + i.totalPrice, 0) * 100) / 100;
  const receiptTotal = original.validation.receiptTotal;
  const difference = Math.round((computedTotal - receiptTotal) * 100) / 100;
  return {
    ...original,
    categories,
    suggestedTips: [
      { percentage: 10, amount: Math.round(computedTotal * 0.1 * 100) / 100 },
      { percentage: 15, amount: Math.round(computedTotal * 0.15 * 100) / 100 },
      { percentage: 20, amount: Math.round(computedTotal * 0.2 * 100) / 100 },
    ],
    validation: {
      receiptTotal,
      computedTotal,
      difference,
      status: Math.abs(difference) <= STRICT_TOLERANCE ? "ok" : "error",
    },
  };
}

function buildFixSuggestions(diff: number): string[] {
  if (Math.abs(diff) <= STRICT_TOLERANCE) return [];
  if (diff > 0) {
    return [
      `Total is ${diff.toFixed(2)}€ too high.`,
      "· Check for duplicate items and remove them",
      "· Verify quantities (e.g. entered 2 instead of 1)",
      "· Check that no free items were given a price",
    ];
  }
  return [
    `Total is ${Math.abs(diff).toFixed(2)}€ too low.`,
    "· Look for missing items on the physical receipt",
    '· Use "+ Add Missing Item" to add them',
    "· Check quantities (e.g. entered 1 instead of 2)",
    "· Retry scan with better lighting if receipt is unclear",
  ];
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ReviewReceiptScreen() {
  const isDark = useColorScheme() === "dark";
  const { width } = useWindowDimensions();
  const { receipt, setReceipt, rawImageUri } = useReceiptStore();
  const { currentSession, setSession } = useSessionStore();

  // ── All hooks before any conditional return ────────────────────────────────

  const [items, setItems] = useState<EditableItem[]>(() =>
    receipt ? flattenItems(receipt) : []
  );
  const [imageModalVisible, setImageModalVisible] = useState(false);

  useEffect(() => {
    if (!receipt) router.replace("/(app)/scan");
  }, []);

  const textColor = isDark ? Colors.textPrimaryDark : Colors.textPrimaryLight;
  const mutedColor = isDark ? Colors.textMutedDark : Colors.textMutedLight;
  const bgColor = isDark ? Colors.bgDark : Colors.bgLight;
  const borderColor = isDark ? Colors.cardBorderDark : Colors.cardBorderLight;
  const cardColor = isDark ? Colors.cardDark : Colors.cardLight;

  const receiptTotal = receipt?.validation.receiptTotal ?? 0;

  const calculatedTotal = useMemo(
    () => Math.round(items.reduce((s, i) => s + i.totalPrice, 0) * 100) / 100,
    [items]
  );

  const validation = useMemo(
    () => validateEditableItems(items, receiptTotal),
    [items, receiptTotal]
  );

  const errorMap = useMemo(() => {
    const m = new Map<string, string>();
    validation.errors.forEach((e) => { if (e.itemId) m.set(e.itemId, e.message); });
    return m;
  }, [validation]);

  const totalDiff = calculatedTotal - receiptTotal;
  const canContinue = validation.isValid;
  const fixSuggestions = useMemo(() => buildFixSuggestions(totalDiff), [totalDiff]);

  const updateItem = useCallback(
    (id: string, field: "name" | "quantity" | "unitPrice", raw: string) => {
      setItems((prev) =>
        prev.map((item) => {
          if (item.id !== id) return item;
          if (field === "name") return { ...item, name: raw };
          if (field === "quantity") {
            const qty = Math.max(1, parseInt(raw) || 1);
            return { ...item, quantity: qty, totalPrice: Math.round(qty * item.unitPrice * 100) / 100 };
          }
          const price = parseFloat(raw.replace(",", ".")) || 0;
          return { ...item, unitPrice: price, totalPrice: Math.round(item.quantity * price * 100) / 100 };
        })
      );
    },
    []
  );

  const addItem = useCallback(() => {
    setItems((prev) => [
      ...prev,
      { id: `manual_${Date.now()}`, category: "others", name: "", quantity: 1, unitPrice: 0, totalPrice: 0 },
    ]);
  }, []);

  const removeItem = useCallback((id: string) => {
    Alert.alert("Remove Item", "Remove this item from the receipt?", [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: () => setItems((p) => p.filter((i) => i.id !== id)) },
    ]);
  }, []);

  // ── Early return after all hooks ────────────────────────────────────────────
  if (!receipt) return null;

  const handleContinue = () => {
    if (!canContinue) {
      Alert.alert(
        "Fix Errors First",
        `The items must add up to exactly ${receiptTotal.toFixed(2)}€.\n\nCurrent difference: ${totalDiff > 0 ? "+" : ""}${totalDiff.toFixed(2)}€`,
        [{ text: "OK" }]
      );
      return;
    }
    const rebuilt = rebuildReceipt(receipt, items);
    setReceipt(rebuilt);

    const liveId = currentSession?.id;
    const isLiveSession = liveId && !liveId.startsWith("session_");
    if (isLiveSession) {
      // Set receipt in session store so the redirectToSelection effect can fire
      setSession({ ...currentSession!, receipt: rebuilt });
      // Replace (not push) so the user can't accidentally re-confirm via back
      router.replace(`/(app)/session/${liveId}?redirectToSelection=1`);
    } else {
      router.push("/(app)/review");
    }
  };

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: bgColor }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="arrow-back" size={24} color={textColor} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: textColor }]} numberOfLines={1}>
          {receipt?.restaurant ?? "Bill Scan"}
        </Text>
        <View style={{ width: 24 }} />
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">

          {/* Restaurant */}
          <View style={[styles.restaurantCard, { backgroundColor: cardColor, borderColor }]}>
            <Ionicons name="restaurant-outline" size={16} color={mutedColor} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.restaurantName, { color: textColor }]}>{receipt.restaurant}</Text>
              {receipt.date && <Text style={[styles.restaurantDate, { color: mutedColor }]}>{receipt.date}</Text>}
            </View>
          </View>

          {/* Blocked state — prominent error box */}
          {!canContinue && (
            <View style={styles.blockedBox}>
              <View style={styles.blockedHeader}>
                <Ionicons name="lock-closed" size={18} color="#DC2626" />
                <Text style={styles.blockedTitle}>Cannot continue — fix errors first</Text>
              </View>
              <Text style={styles.blockedDesc}>
                Items must add up to exactly{" "}
                <Text style={styles.blockedAmount}>{receiptTotal.toFixed(2)}€</Text>.
                {" "}Current total: <Text style={styles.blockedAmount}>{calculatedTotal.toFixed(2)}€</Text>.
              </Text>
              {fixSuggestions.length > 0 && (
                <View style={styles.fixSuggestions}>
                  {fixSuggestions.map((s, i) => (
                    <Text key={i} style={[styles.fixSuggestionLine, i === 0 && styles.fixSuggestionHead]}>
                      {s}
                    </Text>
                  ))}
                </View>
              )}
            </View>
          )}

          {/* Per-item errors */}
          {errorMap.size > 0 && (
            <View style={styles.errorBanner}>
              <Ionicons name="alert-circle" size={15} color="#EF4444" />
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={styles.errorBannerTitle}>
                  {validation.errors.length} item error{validation.errors.length !== 1 ? "s" : ""}
                </Text>
                {validation.errors.filter(e => e.itemId).slice(0, 3).map((e, i) => (
                  <Text key={i} style={styles.errorBannerItem}>· {e.message}</Text>
                ))}
                {validation.errors.filter(e => e.itemId).length > 3 && (
                  <Text style={styles.errorBannerMore}>+ {validation.errors.filter(e => e.itemId).length - 3} more</Text>
                )}
              </View>
            </View>
          )}

          {/* Warnings */}
          {validation.warnings.length > 0 && (
            <View style={styles.warningBanner}>
              <Ionicons name="information-circle" size={15} color={Colors.warning} />
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={styles.warningBannerTitle}>
                  {validation.warnings.length} warning{validation.warnings.length !== 1 ? "s" : ""}
                </Text>
                {validation.warnings.map((w, i) => (
                  <Text key={i} style={styles.warningBannerItem}>· {w.message}</Text>
                ))}
              </View>
            </View>
          )}

          {/* Items */}
          <Text style={[styles.sectionTitle, { color: mutedColor }]}>
            ITEMS ({items.length})
          </Text>

          {items.map((item, index) => {
            const hasError = errorMap.has(item.id);
            return (
              <View
                key={item.id}
                style={[
                  styles.itemCard,
                  { backgroundColor: cardColor, borderColor: hasError ? "#EF4444" : borderColor },
                ]}
              >
                <View style={styles.itemHeader}>
                  <Text style={[styles.itemIndex, { color: mutedColor }]}>#{index + 1}</Text>
                  <TouchableOpacity onPress={() => removeItem(item.id)} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                    <Ionicons name="trash-outline" size={16} color={mutedColor} />
                  </TouchableOpacity>
                </View>

                {hasError && (
                  <View style={styles.itemErrorRow}>
                    <Ionicons name="warning" size={11} color="#EF4444" />
                    <Text style={styles.itemErrorText} numberOfLines={2}>{errorMap.get(item.id)}</Text>
                  </View>
                )}

                <TextInput
                  value={item.name}
                  onChangeText={(v) => updateItem(item.id, "name", v)}
                  placeholder="Item name"
                  placeholderTextColor={mutedColor}
                  style={[styles.nameInput, { color: textColor, borderColor }]}
                />

                <View style={styles.fieldRow}>
                  <View style={styles.fieldCol}>
                    <Text style={[styles.fieldLabel, { color: mutedColor }]}>Qty</Text>
                    <TextInput
                      value={String(item.quantity)}
                      onChangeText={(v) => updateItem(item.id, "quantity", v)}
                      keyboardType="number-pad"
                      style={[styles.fieldInput, { color: textColor, borderColor }]}
                    />
                  </View>
                  <View style={styles.fieldCol}>
                    <Text style={[styles.fieldLabel, { color: mutedColor }]}>Unit Price</Text>
                    <TextInput
                      value={item.unitPrice.toFixed(2)}
                      onChangeText={(v) => updateItem(item.id, "unitPrice", v)}
                      keyboardType="decimal-pad"
                      style={[styles.fieldInput, { color: textColor, borderColor }]}
                    />
                  </View>
                  <View style={styles.fieldCol}>
                    <Text style={[styles.fieldLabel, { color: mutedColor }]}>Total</Text>
                    <View style={[styles.fieldReadonly, { borderColor: hasError ? "#EF4444" : borderColor }]}>
                      <Text style={[styles.fieldReadonlyText, { color: hasError ? "#EF4444" : Colors.primary }]}>
                        {item.totalPrice.toFixed(2)}
                      </Text>
                    </View>
                  </View>
                </View>
              </View>
            );
          })}

          {/* Add item */}
          <TouchableOpacity style={[styles.addItemBtn, { borderColor: Colors.primary }]} onPress={addItem} activeOpacity={0.7}>
            <Ionicons name="add" size={18} color={Colors.primary} />
            <Text style={styles.addItemText}>Add Missing Item</Text>
          </TouchableOpacity>

          {/* Original receipt photo — tap to expand */}
          {rawImageUri && (
            <TouchableOpacity
              style={[styles.photoCard, { borderColor }]}
              onPress={() => setImageModalVisible(true)}
              activeOpacity={0.8}
            >
              <Image
                source={{ uri: rawImageUri }}
                style={styles.photoThumb}
                resizeMode="cover"
              />
              <View style={styles.photoOverlay}>
                <Ionicons name="expand-outline" size={20} color="#fff" />
                <Text style={styles.photoOverlayText}>View Original Receipt</Text>
              </View>
            </TouchableOpacity>
          )}

          {/* Totals — prominent, shows match or mismatch */}
          <View style={[
            styles.totalCard,
            { backgroundColor: canContinue ? cardColor : "#FEF2F2", borderColor: canContinue ? borderColor : "#FCA5A5" },
          ]}>
            <View style={styles.totalRow}>
              <Text style={[styles.totalLabel, { color: mutedColor }]}>Items sum</Text>
              <Text style={[styles.totalValue, { color: canContinue ? textColor : "#DC2626" }]}>
                {calculatedTotal.toFixed(2)} {receipt.currency}
              </Text>
            </View>
            <View style={[styles.totalDivider, { backgroundColor: borderColor }]} />
            <View style={styles.totalRow}>
              <Text style={[styles.totalLabel, { color: mutedColor }]}>Receipt total</Text>
              <Text style={[styles.totalValue, { color: textColor }]}>
                {receiptTotal.toFixed(2)} {receipt.currency}
              </Text>
            </View>
            <View style={[styles.totalDivider, { backgroundColor: borderColor }]} />
            <View style={styles.totalRow}>
              {canContinue ? (
                <>
                  <View style={styles.matchRow}>
                    <Ionicons name="checkmark-circle" size={15} color="#10B981" />
                    <Text style={styles.matchText}>Totals match — ready to continue</Text>
                  </View>
                </>
              ) : (
                <>
                  <Text style={styles.diffLabel}>Difference</Text>
                  <Text style={styles.diffValue}>
                    {totalDiff > 0 ? "+" : ""}{totalDiff.toFixed(2)} {receipt.currency}
                  </Text>
                </>
              )}
            </View>
          </View>

        </ScrollView>

        {/* Bottom actions */}
        <View style={[styles.actions, { borderTopColor: borderColor, backgroundColor: bgColor }]}>
          <TouchableOpacity
            style={[styles.retryBtn, { borderColor }]}
            onPress={() => router.back()}
            activeOpacity={0.8}
          >
            <Ionicons name="refresh-outline" size={15} color={mutedColor} />
            <Text style={[styles.retryBtnText, { color: mutedColor }]}>Retry Scan</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.continueBtn, !canContinue && styles.continueBtnLocked]}
            onPress={handleContinue}
            activeOpacity={canContinue ? 0.85 : 1}
          >
            {canContinue ? (
              <Text style={styles.continueBtnText}>Looks Good →</Text>
            ) : (
              <View style={styles.lockedBtnInner}>
                <Ionicons name="lock-closed" size={14} color="#9CA3AF" />
                <Text style={styles.continueBtnTextLocked}>Fix Errors First</Text>
              </View>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>

      {/* Full-screen receipt photo modal */}
      {rawImageUri && (
        <Modal
          visible={imageModalVisible}
          transparent
          animationType="fade"
          onRequestClose={() => setImageModalVisible(false)}
        >
          <View style={styles.photoModalOverlay}>
            <TouchableOpacity
              style={styles.photoModalClose}
              onPress={() => setImageModalVisible(false)}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            >
              <Ionicons name="close-circle" size={36} color="#fff" />
            </TouchableOpacity>
            <Image
              source={{ uri: rawImageUri }}
              style={[styles.photoModalImage, { width }]}
              resizeMode="contain"
            />
          </View>
        </Modal>
      )}
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  headerTitle: { fontSize: 17, fontWeight: "700" },
  scroll: { paddingHorizontal: 20, paddingBottom: 20, gap: 14 },

  restaurantCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 14,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  restaurantName: { fontSize: 15, fontWeight: "700" },
  restaurantDate: { fontSize: 12, marginTop: 2 },

  // ── Blocked state ──────────────────────────────────────────────────────────
  blockedBox: {
    padding: 16,
    borderRadius: 14,
    backgroundColor: "#FEF2F2",
    borderWidth: 1.5,
    borderColor: "#FCA5A5",
    gap: 10,
  },
  blockedHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  blockedTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: "#DC2626",
    flex: 1,
  },
  blockedDesc: {
    fontSize: 13,
    color: "#7F1D1D",
    lineHeight: 20,
  },
  blockedAmount: {
    fontWeight: "700",
  },
  fixSuggestions: {
    gap: 4,
    paddingTop: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#FCA5A5",
  },
  fixSuggestionHead: {
    fontWeight: "700",
    paddingTop: 4,
  },
  fixSuggestionLine: {
    fontSize: 12,
    color: "#991B1B",
    lineHeight: 18,
  },

  // ── Errors / warnings ─────────────────────────────────────────────────────
  errorBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    padding: 12,
    borderRadius: 10,
    backgroundColor: "#FEF2F2",
    borderWidth: 1,
    borderColor: "#FCA5A5",
  },
  errorBannerTitle: { fontSize: 12, fontWeight: "700", color: "#EF4444" },
  errorBannerItem: { fontSize: 11, color: "#DC2626", lineHeight: 16 },
  errorBannerMore: { fontSize: 11, color: "#DC2626", fontStyle: "italic" },

  warningBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    padding: 12,
    borderRadius: 10,
    backgroundColor: "#FFFBEB",
    borderWidth: 1,
    borderColor: "#FCD34D",
  },
  warningBannerTitle: { fontSize: 12, fontWeight: "700", color: Colors.warning },
  warningBannerItem: { fontSize: 11, color: Colors.warning, lineHeight: 16 },

  sectionTitle: {
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.5,
    textTransform: "uppercase",
    marginBottom: -4,
  },

  // ── Item cards ─────────────────────────────────────────────────────────────
  itemCard: { borderRadius: 12, borderWidth: 1, padding: 14, gap: 10 },
  itemHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  itemIndex: { fontSize: 11, fontWeight: "600" },
  itemErrorRow: { flexDirection: "row", alignItems: "flex-start", gap: 5 },
  itemErrorText: { fontSize: 11, color: "#EF4444", flex: 1, lineHeight: 16 },
  nameInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 14,
  },
  fieldRow: { flexDirection: "row", gap: 8 },
  fieldCol: { flex: 1, gap: 4 },
  fieldLabel: { fontSize: 10, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.3 },
  fieldInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    textAlign: "right",
  },
  fieldReadonly: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    alignItems: "flex-end",
  },
  fieldReadonlyText: { fontSize: 14, fontWeight: "700" },

  // ── Add item ───────────────────────────────────────────────────────────────
  addItemBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1.5,
    borderStyle: "dashed",
  },
  addItemText: { color: Colors.primary, fontSize: 14, fontWeight: "600" },

  // ── Totals ─────────────────────────────────────────────────────────────────
  totalCard: { borderRadius: 14, borderWidth: 1.5, padding: 16, gap: 12 },
  totalRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  totalLabel: { fontSize: 14 },
  totalValue: { fontSize: 15, fontWeight: "700" },
  totalDivider: { height: StyleSheet.hairlineWidth },
  matchRow: { flexDirection: "row", alignItems: "center", gap: 6, flex: 1 },
  matchText: { fontSize: 13, color: "#10B981", fontWeight: "600" },
  diffLabel: { fontSize: 14, fontWeight: "700", color: "#DC2626" },
  diffValue: { fontSize: 15, fontWeight: "800", color: "#DC2626" },

  // ── Bottom actions ─────────────────────────────────────────────────────────
  actions: {
    flexDirection: "row",
    gap: 10,
    padding: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  retryBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 15,
    borderRadius: 12,
    borderWidth: 1,
  },
  retryBtnText: { fontSize: 13, fontWeight: "600" },
  continueBtn: {
    flex: 2,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 15,
    borderRadius: 12,
    backgroundColor: Colors.primary,
  },
  continueBtnLocked: {
    backgroundColor: "#F3F4F6",
  },
  continueBtnText: { color: "#fff", fontSize: 15, fontWeight: "700" },
  continueBtnTextLocked: { color: "#9CA3AF", fontSize: 14, fontWeight: "600" },
  lockedBtnInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },

  // ── Original receipt photo preview ─────────────────────────────────────────
  photoCard: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    height: 160,
  },
  photoThumb: {
    width: "100%",
    height: "100%",
  },
  photoOverlay: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 10,
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  photoOverlayText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "600",
  },

  // ── Full-screen photo modal ────────────────────────────────────────────────
  photoModalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.92)",
    alignItems: "center",
    justifyContent: "center",
  },
  photoModalClose: {
    position: "absolute",
    top: 56,
    right: 20,
    zIndex: 10,
  },
  photoModalImage: {
    flex: 1,
  },
});
