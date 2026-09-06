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
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "@/constants/colors";
import { useReceiptStore } from "@/store/receiptStore";
import { useCanonicalReceiptStore, visibleIssues } from "@/store/canonicalReceiptStore";
import { validateEditableItems, EditableItem } from "@/lib/receipt-validator";
import { ItemCategory, ParsedReceipt, ReceiptItem } from "@/types";
import { useSessionStore } from "@/store/sessionStore";
import { useI18nStore } from "@/store/i18nStore";
import { TranslationKey } from "@/constants/translations";
import { formatCurrency } from "@/utils/formatter";

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
        addOns: item.addOns,
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
  const userItemsTotal = Math.round(items.reduce((s, i) => s + i.totalPrice, 0) * 100) / 100;
  // Compare user's items against the subtotal (items only), not grand total (includes service/tax).
  const subtotalTarget = original.validation.computedTotal ?? original.validation.receiptTotal;
  const receiptTotal = original.validation.receiptTotal; // grand total kept for display reference
  const difference = Math.round((userItemsTotal - subtotalTarget) * 100) / 100;
  return {
    ...original,
    categories,
    suggestedTips: [
      { percentage: 10, amount: Math.round(userItemsTotal * 0.1 * 100) / 100 },
      { percentage: 15, amount: Math.round(userItemsTotal * 0.15 * 100) / 100 },
      { percentage: 20, amount: Math.round(userItemsTotal * 0.2 * 100) / 100 },
    ],
    validation: {
      receiptTotal,
      computedTotal: userItemsTotal,
      difference,
      status: Math.abs(difference) <= STRICT_TOLERANCE ? "ok" : "error",
    },
  };
}

function buildFixSuggestions(diff: number, t: (k: TranslationKey) => string, currency: string): string[] {
  if (Math.abs(diff) <= STRICT_TOLERANCE) return [];
  if (diff > 0) {
    return [
      `${t("review_fix_prefix")} ${diff.toFixed(2)} ${currency} ${t("review_fix_too_high")}`,
      t("review_fix_dup"),
      t("review_fix_qty_hint"),
      t("review_fix_free_items"),
    ];
  }
  return [
    `${t("review_fix_prefix")} ${Math.abs(diff).toFixed(2)} ${currency} ${t("review_fix_too_low")}`,
    t("review_fix_missing_items"),
    t("review_fix_add_hint"),
    t("review_fix_qty_hint2"),
    t("review_fix_retry_scan"),
  ];
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ReviewReceiptScreen() {
  const isDark = useColorScheme() === "dark";
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { receipt, setReceipt, rawImageUri } = useReceiptStore();
  const { currentSession, setSession } = useSessionStore();
  const { t, language } = useI18nStore();
  void language;

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

  // subtotalTarget = items-only sum from OCR (before service charge / tax).
  // Grand total (receiptTotal) is only used for the display row, not for validation.
  const subtotalTarget = receipt?.validation.computedTotal ?? receipt?.validation.receiptTotal ?? 0;
  const grandTotal = receipt?.validation.receiptTotal ?? subtotalTarget;
  const currency = receipt?.currency ?? "EUR";

  const calculatedTotal = useMemo(
    () => Math.round(items.reduce((s, i) => s + i.totalPrice, 0) * 100) / 100,
    [items]
  );

  const validation = useMemo(
    () => validateEditableItems(items, subtotalTarget, currency),
    [items, subtotalTarget, currency]
  );

  // Separate origin from validateEditableItems above: these come from the
  // canonical pipeline's evidence check (lib/receipt/evidence.ts), which
  // compares a value against the model's own cited line text — catches a
  // different class of defect (a value that reconciles but doesn't match
  // what was read) than the item-math/price-variant checks above.
  const canonicalIssues = useCanonicalReceiptStore(visibleIssues);
  const dismissCanonicalIssue = useCanonicalReceiptStore((s) => s.dismissIssue);

  const errorMap = useMemo(() => {
    const m = new Map<string, string>();
    validation.errors.forEach((e) => { if (e.itemId) m.set(e.itemId, e.message); });
    return m;
  }, [validation]);

  const totalDiff = calculatedTotal - subtotalTarget;
  const canContinue = validation.isValid;
  const isWarning = validation.isWarning;
  const fixSuggestions = useMemo(() => buildFixSuggestions(totalDiff, t, currency), [totalDiff, t, currency]);

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
    Alert.alert(t("review_receipt_remove_title"), t("review_receipt_remove_msg"), [
      { text: t("cancel"), style: "cancel" },
      { text: t("review_receipt_remove_btn"), style: "destructive", onPress: () => setItems((p) => p.filter((i) => i.id !== id)) },
    ]);
  }, [t]);

  // ── Early return after all hooks ────────────────────────────────────────────
  if (!receipt) return null;

  const handleContinue = () => {
    if (!canContinue) {
      Alert.alert(
        t("review_receipt_fix_title"),
        `The items must add up to exactly ${formatCurrency(subtotalTarget, currency as any)}.\n\nCurrent difference: ${totalDiff > 0 ? "+" : ""}${formatCurrency(Math.abs(totalDiff), currency as any)}`,
        [{ text: t("ok") }]
      );
      return;
    }
    const rebuilt = rebuildReceipt(receipt, items);
    setReceipt(rebuilt);

    const liveId = currentSession?.id;
    const isLiveSession = liveId && !liveId.startsWith("session_");
    if (isLiveSession) {
      setSession({ ...currentSession!, receipt: rebuilt });
      router.replace(`/(app)/session-lobby/${liveId}`);
    } else {
      router.replace("/(app)/review");
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
        <ScrollView
          contentContainerStyle={[
            styles.scroll,
            { paddingBottom: 20 + Math.max(insets.bottom, 16) },
          ]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >

          {/* Restaurant */}
          <View style={[styles.restaurantCard, { backgroundColor: cardColor, borderColor }]}>
            <Ionicons name="restaurant-outline" size={16} color={mutedColor} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.restaurantName, { color: textColor }]}>{receipt.restaurant}</Text>
              {receipt.date && <Text style={[styles.restaurantDate, { color: mutedColor }]}>{receipt.date}</Text>}
            </View>
          </View>

          {/* Warning state — small discrepancy, can continue */}
          {isWarning && canContinue && (
            <View style={styles.warningBox}>
              <View style={styles.warningBoxHeader}>
                <Ionicons name="warning" size={18} color={Colors.warning} />
                <Text style={styles.warningBoxTitle}>Small discrepancy</Text>
              </View>
              <Text style={styles.warningBoxDesc}>
                Items sum to{" "}
                <Text style={styles.warningBoxAmount}>{formatCurrency(calculatedTotal, currency as any)}</Text>
                {" "}but receipt subtotal is{" "}
                <Text style={styles.warningBoxAmount}>{formatCurrency(subtotalTarget, currency as any)}</Text>
                {" "}(diff: {totalDiff > 0 ? "+" : ""}{formatCurrency(Math.abs(totalDiff), currency as any)}).
              </Text>
              <Text style={styles.warningBoxHint}>
                Likely missing add-ons or rounding. You can continue or retry the scan for better accuracy.
              </Text>
            </View>
          )}

          {/* Blocked state — prominent error box */}
          {!canContinue && (
            <View style={styles.blockedBox}>
              <View style={styles.blockedHeader}>
                <Ionicons name="lock-closed" size={18} color="#DC2626" />
                <Text style={styles.blockedTitle}>{t("review_receipt_cant_continue")}</Text>
              </View>
              <Text style={styles.blockedDesc}>
                Items must add up to exactly{" "}
                <Text style={styles.blockedAmount}>{formatCurrency(subtotalTarget, currency as any)}</Text>.
                {" "}Current total: <Text style={styles.blockedAmount}>{formatCurrency(calculatedTotal, currency as any)}</Text>.
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
                  {validation.errors.length} {validation.errors.length !== 1 ? t("review_receipt_item_errors") : t("review_receipt_item_error")}
                </Text>
                {validation.errors.filter(e => e.itemId).slice(0, 3).map((e, i) => (
                  <Text key={i} style={styles.errorBannerItem}>· {e.message}</Text>
                ))}
                {validation.errors.filter(e => e.itemId).length > 3 && (
                  <Text style={styles.errorBannerMore}>+ {validation.errors.filter(e => e.itemId).length - 3} {t("review_receipt_more")}</Text>
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
                  {validation.warnings.length} {validation.warnings.length !== 1 ? t("review_receipt_warnings") : t("review_receipt_warning")}
                </Text>
                {validation.warnings.map((w, i) => (
                  <Text key={i} style={styles.warningBannerItem}>· {w.message}</Text>
                ))}
              </View>
            </View>
          )}

          {/* Canonical evidence issues — separate origin from the warnings above */}
          {canonicalIssues.length > 0 && (
            <View style={styles.evidenceBanner}>
              <Ionicons name="search" size={15} color={Colors.primary} />
              <View style={{ flex: 1, gap: 10 }}>
                <Text style={styles.evidenceBannerTitle}>
                  {t("review_receipt_possible_read_error")}
                </Text>
                {canonicalIssues.map((issue) => (
                  <View key={issue.id} style={styles.evidenceIssueRow}>
                    <Text style={styles.evidenceIssueMessage}>{issue.message}</Text>
                    {issue.sourceLine && (
                      <Text style={styles.evidenceIssueSourceLine}>
                        {t("review_receipt_cited_line")} "{issue.sourceLine}"
                      </Text>
                    )}
                    <TouchableOpacity
                      style={styles.evidenceDismissBtn}
                      onPress={() => dismissCanonicalIssue(issue.id)}
                      activeOpacity={0.7}
                    >
                      <Text style={styles.evidenceDismissBtnText}>
                        {t("review_receipt_dismiss")}
                      </Text>
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            </View>
          )}

          {/* Items */}
          <Text style={[styles.sectionTitle, { color: mutedColor }]}>
            {t("review_receipt_items_label")} ({items.length})
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
                    <Text style={[styles.fieldLabel, { color: mutedColor }]}>{t("review_field_qty")}</Text>
                    <TextInput
                      value={String(item.quantity)}
                      onChangeText={(v) => updateItem(item.id, "quantity", v)}
                      keyboardType="number-pad"
                      style={[styles.fieldInput, { color: textColor, borderColor }]}
                    />
                  </View>
                  <View style={styles.fieldCol}>
                    <Text style={[styles.fieldLabel, { color: mutedColor }]}>{t("review_receipt_unit_price")}</Text>
                    <TextInput
                      value={item.unitPrice.toFixed(2)}
                      onChangeText={(v) => updateItem(item.id, "unitPrice", v)}
                      keyboardType="decimal-pad"
                      style={[styles.fieldInput, { color: textColor, borderColor }]}
                    />
                  </View>
                  <View style={styles.fieldCol}>
                    <Text style={[styles.fieldLabel, { color: mutedColor }]}>{t("review_total")}</Text>
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
            <Text style={styles.addItemText}>{t("review_receipt_add_missing")}</Text>
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
                <Text style={styles.photoOverlayText}>{t("review_receipt_view_original")}</Text>
              </View>
            </TouchableOpacity>
          )}

          {/* Totals — prominent, shows match or mismatch */}
          <View style={[
            styles.totalCard,
            { backgroundColor: canContinue ? cardColor : "#FEF2F2", borderColor: canContinue ? borderColor : "#FCA5A5" },
          ]}>
            <View style={styles.totalRow}>
              <Text style={[styles.totalLabel, { color: mutedColor }]}>{t("review_receipt_items_sum")}</Text>
              <Text style={[styles.totalValue, { color: canContinue ? textColor : "#DC2626" }]}>
                {formatCurrency(calculatedTotal, currency as any)}
              </Text>
            </View>
            <View style={[styles.totalDivider, { backgroundColor: borderColor }]} />
            <View style={styles.totalRow}>
              <Text style={[styles.totalLabel, { color: mutedColor }]}>{t("review_receipt_total_label")}</Text>
              <Text style={[styles.totalValue, { color: textColor }]}>
                {formatCurrency(subtotalTarget, currency as any)}
              </Text>
            </View>
            {grandTotal !== subtotalTarget && (
              <>
                <View style={[styles.totalDivider, { backgroundColor: borderColor }]} />
                <View style={styles.totalRow}>
                  <Text style={[styles.totalLabel, { color: mutedColor }]}>Grand total</Text>
                  <Text style={[styles.totalValue, { color: mutedColor }]}>
                    {formatCurrency(grandTotal, currency as any)}
                  </Text>
                </View>
              </>
            )}
            <View style={[styles.totalDivider, { backgroundColor: borderColor }]} />
            <View style={styles.totalRow}>
              {canContinue ? (
                <>
                  <View style={styles.matchRow}>
                    <Ionicons name="checkmark-circle" size={15} color="#10B981" />
                    <Text style={styles.matchText}>{t("review_receipt_match")}</Text>
                  </View>
                </>
              ) : (
                <>
                  <Text style={styles.diffLabel}>{t("review_receipt_diff_label")}</Text>
                  <Text style={styles.diffValue}>
                    {totalDiff > 0 ? "+" : ""}{formatCurrency(Math.abs(totalDiff), currency as any)}
                  </Text>
                </>
              )}
            </View>
          </View>

        </ScrollView>

        {/* Bottom actions */}
        <View
          style={[
            styles.actions,
            {
              borderTopColor: borderColor,
              backgroundColor: bgColor,
              paddingBottom: 16 + Math.max(insets.bottom, 16),
            },
          ]}
        >
          <TouchableOpacity
            style={[styles.retryBtn, { borderColor }]}
            onPress={() => router.back()}
            activeOpacity={0.8}
          >
            <Ionicons name="refresh-outline" size={15} color={mutedColor} />
            <Text style={[styles.retryBtnText, { color: mutedColor }]}>{t("review_receipt_retry")}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.continueBtn,
              !canContinue && styles.continueBtnLocked,
              isWarning && canContinue && styles.continueBtnWarning,
            ]}
            onPress={handleContinue}
            activeOpacity={canContinue ? 0.85 : 1}
          >
            {canContinue && !isWarning ? (
              <Text style={styles.continueBtnText}>{t("review_receipt_looks_good")}</Text>
            ) : canContinue && isWarning ? (
              <Text style={styles.continueBtnText}>Continue anyway →</Text>
            ) : (
              <View style={styles.lockedBtnInner}>
                <Ionicons name="lock-closed" size={14} color="#9CA3AF" />
                <Text style={styles.continueBtnTextLocked}>{t("review_receipt_locked_btn")}</Text>
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
  scroll: { paddingHorizontal: 20, gap: 14 },

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

  // ── Warning state (small discrepancy, can continue) ───────────────────────
  warningBox: {
    padding: 16,
    borderRadius: 14,
    backgroundColor: "#FFFBEB",
    borderWidth: 1.5,
    borderColor: "#FCD34D",
    gap: 8,
  },
  warningBoxHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  warningBoxTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: "#92400E",
    flex: 1,
  },
  warningBoxDesc: {
    fontSize: 13,
    color: "#78350F",
    lineHeight: 20,
  },
  warningBoxAmount: {
    fontWeight: "700",
  },
  warningBoxHint: {
    fontSize: 12,
    color: "#92400E",
    lineHeight: 18,
    fontStyle: "italic",
  },

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

  evidenceBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    padding: 12,
    borderRadius: 10,
    backgroundColor: "#EEF2FF",
    borderWidth: 1,
    borderColor: "#C7D2FE",
  },
  evidenceBannerTitle: { fontSize: 12, fontWeight: "700", color: Colors.primary },
  evidenceIssueRow: { gap: 4 },
  evidenceIssueMessage: { fontSize: 11, color: "#3730A3", lineHeight: 16 },
  evidenceIssueSourceLine: { fontSize: 11, color: "#4338CA", fontStyle: "italic" },
  evidenceDismissBtn: { alignSelf: "flex-start", paddingVertical: 2 },
  evidenceDismissBtnText: {
    fontSize: 11,
    fontWeight: "600",
    color: Colors.primary,
    textDecorationLine: "underline",
  },

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
  continueBtnWarning: {
    backgroundColor: Colors.warning,
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
