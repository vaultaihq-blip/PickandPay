import React, { useState, useMemo, useEffect, useCallback, useRef } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Image,
  Modal,
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
import { validateEditableItems, type EditableRow } from "@/lib/receipt-validator";
import { buildReceiptGuidance, type ReceiptGuidance } from "@/lib/receipt-guidance";
import { GuidedDiagnosisStep } from "@/components/receipt/guided/GuidedDiagnosisStep";
import { GuidedTotalStep } from "@/components/receipt/guided/GuidedTotalStep";
import { GuidedItemStep, type ItemField } from "@/components/receipt/guided/GuidedItemStep";
import { GuidedClosingStep } from "@/components/receipt/guided/GuidedClosingStep";
import { ItemCategory, ParsedReceipt, ReceiptItem } from "@/types";
import { useSessionStore } from "@/store/sessionStore";
import { useI18nStore } from "@/store/i18nStore";
import { TranslationKey } from "@/constants/translations";
import { formatCurrency } from "@/utils/formatter";
import { styles } from "@/components/receipt/reviewReceiptStyles";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CATEGORIES: ItemCategory[] = [
  "starters", "mains", "drinks", "desserts", "others",
];

const STRICT_TOLERANCE = 0.01;

/**
 * FIX 45 — the guided correction flow. Only receipts that already failed
 * validation reach this screen (receipt-preview.tsx routes clean ones
 * straight to /review), so every receipt here has something to fix.
 *
 *   diagnosis -> total -> items (queue) -> closing
 *
 * "all" is the pre-existing full list, kept exactly as it was and reachable
 * from the item and closing steps via "ver todos os itens".
 */
type GuidedStep = "diagnosis" | "total" | "items" | "closing";

function flattenItems(receipt: ParsedReceipt): EditableRow[] {
  const result: EditableRow[] = [];
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
        reviewed: item.reviewed,
        qtyText: String(item.quantity),
        unitPriceText: item.unitPrice.toFixed(2),
        totalText: item.totalPrice.toFixed(2),
      });
    }
  }
  return result;
}

/**
 * FIX 45 — `confirmedTotal` is the total the user confirmed in step 2. It is
 * the anchor the rest of the flow validates against, so when they corrected
 * it (or supplied one the parser never found) it must reach the receipt
 * rather than being discarded at the door. Null keeps the original.
 */
function rebuildReceipt(
  original: ParsedReceipt,
  items: EditableRow[],
  confirmedTotal: number | null = null
): ParsedReceipt {
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
      reviewed: item.reviewed,
    } as ReceiptItem);
  }
  const userItemsTotal = Math.round(items.reduce((s, i) => s + i.totalPrice, 0) * 100) / 100;
  // Compare user's items against the subtotal (items only), not grand total (includes service/tax).
  const subtotalTarget = original.validation.computedTotal ?? original.validation.receiptTotal;
  const receiptTotal = confirmedTotal ?? original.validation.receiptTotal;
  const difference = Math.round((userItemsTotal - subtotalTarget) * 100) / 100;
  return {
    ...original,
    printed_total: confirmedTotal ?? original.printed_total,
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

  const [items, setItems] = useState<EditableRow[]>(() =>
    receipt ? flattenItems(receipt) : []
  );
  const [imageModalVisible, setImageModalVisible] = useState(false);

  // ── FIX 45 — guided flow state ─────────────────────────────────────────────
  // Every step renders inside this same component, so nothing unmounts and no
  // edit is ever lost by moving back and forth between steps.
  const [step, setStep] = useState<GuidedStep>("diagnosis");
  const [queueIndex, setQueueIndex] = useState(0);
  const [showAllItems, setShowAllItems] = useState(false);

  useEffect(() => {
    if (!receipt) {
      router.replace("/(app)/scan");
      return;
    }
    const itemCount = Object.values(receipt.categories).flat().length;
    console.log(`[review-receipt] Loaded receipt: ${receipt.restaurant} (${itemCount} items)`);
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

  const formatMoney = useCallback(
    (value: number) => formatCurrency(value, currency as any),
    [currency]
  );

  const chargesSum = useMemo(
    () =>
      Math.round((receipt?.globalCosts ?? []).reduce((s, c) => s + (c.amount ?? 0), 0) * 100) / 100,
    [receipt]
  );

  // FIX 45 — computed ONCE, from the analysis as it arrived. Recomputing it
  // as the user edits would make items disappear from the queue mid-flow
  // ("item 2 de 5" turning into "item 2 de 3" under their thumb); the queue
  // is the list of things the parser flagged, not a live to-do list.
  const [guidance] = useState<ReceiptGuidance>(() =>
    buildReceiptGuidance(
      {
        canonical: useCanonicalReceiptStore.getState().receipt,
        items,
        printedTotal: receipt?.validation.receiptTotal ?? null,
        itemsSum: receipt?.validation.computedTotal ?? 0,
        chargesSum: Math.round(
          (receipt?.globalCosts ?? []).reduce((s, c) => s + (c.amount ?? 0), 0) * 100
        ) / 100,
      },
      (value) => formatCurrency(value, (receipt?.currency ?? "EUR") as any)
    )
  );

  // The anchor. Blank when the parser never identified a total, which is
  // exactly when step 2 matters most.
  const [confirmedTotalText, setConfirmedTotalText] = useState(() => {
    if (guidance.missingTotal) return "";
    const printed = receipt?.validation.receiptTotal ?? 0;
    return printed > 0 ? printed.toFixed(2) : "";
  });

  const confirmedTotal = useMemo(() => {
    const parsed = parseFloat(confirmedTotalText.replace(",", "."));
    return Number.isNaN(parsed) ? 0 : parsed;
  }, [confirmedTotalText]);

  /** Ids in the queue that still exist in `items` (an item can be deleted). */
  const attentionQueue = useMemo(
    () => guidance.attentionItemIds.filter((id) => items.some((i) => i.id === id)),
    [guidance, items]
  );

  // Tapping an issue scrolls to and briefly highlights the item it points at
  // (issue.itemId survives the canonical -> legacy projection unchanged, see
  // lib/receipt/adapter.ts:toLegacyItem, so it matches an EditableItem.id
  // here directly). No modal: ItemCorrectionModal edits CanonicalReceipt via
  // ReceiptEdit, a model this screen's own items/rebuildReceipt never reads
  // from — wiring it in without also bridging that would let a "fix" vanish
  // silently when the user saves. Scrolling to the existing, already-wired
  // inline fields is the safe option.
  const scrollViewRef = useRef<ScrollView>(null);
  const itemLayoutY = useRef<Record<string, number>>({});
  const [highlightedItemId, setHighlightedItemId] = useState<string | null>(null);

  const scrollToItem = useCallback((itemId: string | undefined) => {
    if (itemId === undefined) return;
    const y = itemLayoutY.current[itemId];
    if (y !== undefined) {
      scrollViewRef.current?.scrollTo({ y: Math.max(0, y - 100), animated: true });
    }
    setHighlightedItemId(itemId);
    setTimeout(() => {
      setHighlightedItemId((current) => (current === itemId ? null : current));
    }, 2500);
  }, []);

  const errorMap = useMemo(() => {
    const m = new Map<string, string>();
    validation.errors.forEach((e) => { if (e.itemId) m.set(e.itemId, e.message); });
    return m;
  }, [validation]);

  const totalDiff = calculatedTotal - subtotalTarget;
  // FIX 44 — editing must never be refused for not reconciling ("a app pode
  // mostrar que a soma não bate, não pode recusar"). The Continue button is
  // always enabled (see handleContinue and the JSX below); hasBlockingIssues
  // only drives the informational banners, unchanged from before.
  const hasBlockingIssues = !validation.isValid;
  const isWarning = validation.isWarning;
  const fixSuggestions = useMemo(() => buildFixSuggestions(totalDiff, t, currency), [totalDiff, t, currency]);

  // FIX 44 — the three-field rule: quantity x unitPrice = total. Whichever
  // field the user just edited keeps its own raw text exactly as typed; the
  // OTHER dependent field(s) recompute from it (see EditableRow's own header
  // comment for why raw text is tracked separately from the numeric value).
  // Editing anything on an item activates its reviewed mark automatically.
  const updateItem = useCallback(
    (id: string, field: ItemField, raw: string) => {
      setItems((prev) =>
        prev.map((item) => {
          if (item.id !== id) return item;
          if (field === "name") return { ...item, name: raw, reviewed: true };

          if (field === "quantity") {
            const qty = Math.max(1, parseInt(raw) || 1);
            const total = Math.round(qty * item.unitPrice * 100) / 100;
            return { ...item, qtyText: raw, quantity: qty, totalPrice: total, totalText: total.toFixed(2), reviewed: true };
          }

          if (field === "unitPrice") {
            const price = parseFloat(raw.replace(",", ".")) || 0;
            const total = Math.round(item.quantity * price * 100) / 100;
            return { ...item, unitPriceText: raw, unitPrice: price, totalPrice: total, totalText: total.toFixed(2), reviewed: true };
          }

          // field === "totalPrice" — the exact typed value is the ground
          // truth ("o que conta para a conta é o total"); unitPrice is
          // re-derived by division and rounded for display only.
          const total = parseFloat(raw.replace(",", ".")) || 0;
          const unitPrice = item.quantity > 0 ? Math.round((total / item.quantity) * 100) / 100 : item.unitPrice;
          return { ...item, totalText: raw, totalPrice: total, unitPrice, unitPriceText: unitPrice.toFixed(2), reviewed: true };
        })
      );
    },
    []
  );

  // FIX 44 — toggled by hand, independent of editing a field ("pode ser
  // ativada à mão sem editar nada, para confirmar que está certo").
  const toggleReviewed = useCallback((id: string) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, reviewed: !item.reviewed } : item)));
  }, []);

  const addItem = useCallback(() => {
    setItems((prev) => [
      ...prev,
      {
        id: `manual_${Date.now()}`,
        category: "others",
        name: "",
        quantity: 1,
        unitPrice: 0,
        totalPrice: 0,
        qtyText: "1",
        unitPriceText: "0.00",
        totalText: "0.00",
      },
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
    // FIX 45 — the total the user confirmed wins over whatever was parsed.
    // Zero means they left it blank; in that case keep the original rather
    // than writing a total of 0.00 onto the receipt.
    const rebuilt = rebuildReceipt(receipt, items, confirmedTotal > 0 ? confirmedTotal : null);
    setReceipt(rebuilt);

    const liveId = currentSession?.id;
    const isLiveSession = liveId && !liveId.startsWith("session_");
    console.log(
      `[review-receipt] handleContinue: isLiveSession=${!!isLiveSession} sessionId=${liveId ?? "none"} -> ${isLiveSession ? `session-lobby/${liveId}` : "review"}`
    );
    if (isLiveSession) {
      setSession({ ...currentSession!, receipt: rebuilt });
      router.replace(`/(app)/session-lobby/${liveId}`);
    } else {
      router.replace("/(app)/review");
    }
  };

  // ── FIX 45 — step navigation ───────────────────────────────────────────────
  // Every transition is logged, matching FIX 44's own navigation logging, so
  // a real-device run still shows where the user actually went.
  const goToStep = (next: GuidedStep) => {
    console.log(`[review-receipt] guided step: ${step} -> ${next} (queue ${attentionQueue.length})`);
    setStep(next);
  };

  /** After the total: the item queue, or straight to the close when empty. */
  const afterTotal = () => {
    if (attentionQueue.length === 0) {
      goToStep("closing");
      return;
    }
    setQueueIndex(0);
    goToStep("items");
  };

  const advanceQueue = (confirmed: boolean) => {
    const current = attentionQueue[queueIndex];
    if (confirmed && current !== undefined) {
      setItems((prev) =>
        prev.map((item) => (item.id === current ? { ...item, reviewed: true } : item))
      );
    }
    if (queueIndex + 1 >= attentionQueue.length) {
      goToStep("closing");
      return;
    }
    setQueueIndex(queueIndex + 1);
  };

  const retreatQueue = () => {
    if (queueIndex === 0) {
      goToStep("total");
      return;
    }
    setQueueIndex(queueIndex - 1);
  };

  const reviewAgain = () => {
    if (attentionQueue.length === 0) {
      setShowAllItems(true);
      return;
    }
    setQueueIndex(0);
    goToStep("items");
  };

  const guidedItem = items.find((i) => i.id === attentionQueue[queueIndex]);
  const itemReason = guidedItem ? guidance.attentionReasons[guidedItem.id] : undefined;
  const itemsSum = calculatedTotal;
  const closingDifference = Math.round((itemsSum + chargesSum - confirmedTotal) * 100) / 100;

  // ── FIX 45 — guided flow renders instead of the full list, unless the user
  // asked to see everything. The list below is unchanged from before. ────────
  if (!showAllItems) {
    if (step === "diagnosis") {
      return (
        <SafeAreaView style={[styles.safe, { backgroundColor: bgColor }]}>
          <GuidedDiagnosisStep
            merchantName={receipt.restaurant ?? "Fatura"}
            problems={guidance.problems}
            onStart={() => goToStep("total")}
            onBack={() => router.back()}
          />
        </SafeAreaView>
      );
    }

    if (step === "total") {
      return (
        <SafeAreaView style={[styles.safe, { backgroundColor: bgColor }]}>
          <KeyboardAvoidingView
            style={{ flex: 1 }}
            behavior={Platform.OS === "ios" ? "padding" : undefined}
          >
            <GuidedTotalStep
              merchantName={receipt.restaurant ?? "Fatura"}
              totalText={confirmedTotalText}
              onChangeTotal={setConfirmedTotalText}
              missingTotal={guidance.missingTotal}
              currencyLabel={currency}
              onConfirm={afterTotal}
              onBack={() => goToStep("diagnosis")}
            />
          </KeyboardAvoidingView>
        </SafeAreaView>
      );
    }

    if (step === "items" && guidedItem !== undefined) {
      return (
        <SafeAreaView style={[styles.safe, { backgroundColor: bgColor }]}>
          <KeyboardAvoidingView
            style={{ flex: 1 }}
            behavior={Platform.OS === "ios" ? "padding" : undefined}
          >
            <GuidedItemStep
              item={guidedItem}
              position={queueIndex + 1}
              total={attentionQueue.length}
              reason={itemReason}
              currencyLabel={currency}
              onChangeField={updateItem}
              onToggleReviewed={toggleReviewed}
              onConfirm={() => advanceQueue(true)}
              onSkip={() => advanceQueue(false)}
              onBack={retreatQueue}
              onSeeAll={() => setShowAllItems(true)}
            />
          </KeyboardAvoidingView>
        </SafeAreaView>
      );
    }

    if (step === "closing" || step === "items") {
      return (
        <SafeAreaView style={[styles.safe, { backgroundColor: bgColor }]}>
          <GuidedClosingStep
            itemsSum={itemsSum}
            chargesSum={chargesSum}
            confirmedTotal={confirmedTotal}
            difference={closingDifference}
            formatMoney={formatMoney}
            onAccept={handleContinue}
            onReviewAgain={reviewAgain}
            onBack={() => (attentionQueue.length > 0 ? goToStep("items") : goToStep("total"))}
            onSeeAll={() => setShowAllItems(true)}
          />
        </SafeAreaView>
      );
    }
  }

  // ─── Render — the full item list ("ver todos os itens") ───────────────────
  // Unchanged from before FIX 45 apart from the back button, which returns to
  // the guided flow instead of leaving the screen when that is where the user
  // came from. The reviewed marks (FIX 44) stay visible here.

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: bgColor }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => (showAllItems ? setShowAllItems(false) : router.back())}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="arrow-back" size={24} color={textColor} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: textColor }]} numberOfLines={1}>
          {receipt?.restaurant ?? "Bill Scan"}
        </Text>
        <View style={{ width: 24 }} />
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView
          ref={scrollViewRef}
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
          {isWarning && !hasBlockingIssues && (
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

          {/* Discrepancy state — informational only, never blocks Continue
              (FIX 44 — "a app pode mostrar que a soma não bate, não pode
              recusar"). Same box as before, just no longer a refusal. */}
          {hasBlockingIssues && (
            <View style={styles.blockedBox}>
              <View style={styles.blockedHeader}>
                <Ionicons name="warning" size={18} color="#DC2626" />
                <Text style={styles.blockedTitle}>Items don't add up</Text>
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

          {/* Canonical evidence issues — separate origin from the warnings above.
              diagnoseReceipt returns competing hypotheses for the SAME delta,
              ranked by confidence, not independent defects — so only the top
              one is actionable; the rest are alternative explanations, not
              additional problems, and are collapsed into a count. */}
          {canonicalIssues.length > 0 && (
            <View style={styles.evidenceBanner}>
              <Ionicons name="search" size={15} color={Colors.primary} />
              <View style={{ flex: 1, gap: 10 }}>
                <Text style={styles.evidenceBannerTitle}>
                  {t("review_receipt_possible_read_error")}
                </Text>
                <View style={styles.evidenceIssueRow}>
                  <TouchableOpacity
                    disabled={canonicalIssues[0].itemId === undefined}
                    onPress={() => scrollToItem(canonicalIssues[0].itemId)}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.evidenceIssueMessage}>{canonicalIssues[0].message}</Text>
                    {canonicalIssues[0].sourceLine && (
                      <Text style={styles.evidenceIssueSourceLine}>
                        {t("review_receipt_cited_line")} "{canonicalIssues[0].sourceLine}"
                      </Text>
                    )}
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.evidenceDismissBtn}
                    onPress={() => dismissCanonicalIssue(canonicalIssues[0].id)}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.evidenceDismissBtnText}>
                      {t("review_receipt_dismiss")}
                    </Text>
                  </TouchableOpacity>
                </View>
                {canonicalIssues.length > 1 && (
                  <Text style={styles.evidenceMoreText}>
                    + {canonicalIssues.length - 1} {t("review_receipt_more")}
                  </Text>
                )}
              </View>
            </View>
          )}

          {/* Items */}
          <Text style={[styles.sectionTitle, { color: mutedColor }]}>
            {t("review_receipt_items_label")} ({items.length})
          </Text>

          {items.map((item, index) => {
            const hasError = errorMap.has(item.id);
            const isHighlighted = item.id === highlightedItemId;
            return (
              <View
                key={item.id}
                onLayout={(e) => { itemLayoutY.current[item.id] = e.nativeEvent.layout.y; }}
                style={[
                  styles.itemCard,
                  {
                    backgroundColor: cardColor,
                    borderColor: hasError ? "#EF4444" : isHighlighted ? Colors.primary : borderColor,
                    borderWidth: isHighlighted ? 2 : 1,
                  },
                ]}
              >
                <View style={styles.itemHeader}>
                  <Text style={[styles.itemIndex, { color: mutedColor }]}>#{index + 1}</Text>
                  <View style={styles.itemHeaderActions}>
                    <TouchableOpacity
                      onPress={() => toggleReviewed(item.id)}
                      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                    >
                      <Ionicons
                        name={item.reviewed ? "checkmark-circle" : "checkmark-circle-outline"}
                        size={18}
                        color={item.reviewed ? Colors.success : mutedColor}
                      />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => removeItem(item.id)} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                      <Ionicons name="trash-outline" size={16} color={mutedColor} />
                    </TouchableOpacity>
                  </View>
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
                      value={item.qtyText}
                      onChangeText={(v) => updateItem(item.id, "quantity", v)}
                      keyboardType="number-pad"
                      style={[styles.fieldInput, { color: textColor, borderColor }]}
                    />
                  </View>
                  <View style={styles.fieldCol}>
                    <Text style={[styles.fieldLabel, { color: mutedColor }]}>{t("review_receipt_unit_price")}</Text>
                    <TextInput
                      value={item.unitPriceText}
                      onChangeText={(v) => updateItem(item.id, "unitPrice", v)}
                      keyboardType="decimal-pad"
                      style={[styles.fieldInput, { color: textColor, borderColor }]}
                    />
                  </View>
                  <View style={styles.fieldCol}>
                    <Text style={[styles.fieldLabel, { color: mutedColor }]}>{t("review_total")}</Text>
                    <TextInput
                      value={item.totalText}
                      onChangeText={(v) => updateItem(item.id, "totalPrice", v)}
                      keyboardType="decimal-pad"
                      style={[
                        styles.fieldInput,
                        { color: hasError ? "#EF4444" : Colors.primary, borderColor: hasError ? "#EF4444" : borderColor, fontWeight: "700" },
                      ]}
                    />
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
            { backgroundColor: hasBlockingIssues ? "#FEF2F2" : cardColor, borderColor: hasBlockingIssues ? "#FCA5A5" : borderColor },
          ]}>
            <View style={styles.totalRow}>
              <Text style={[styles.totalLabel, { color: mutedColor }]}>{t("review_receipt_items_sum")}</Text>
              <Text style={[styles.totalValue, { color: hasBlockingIssues ? "#DC2626" : textColor }]}>
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
              {!hasBlockingIssues ? (
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
              (isWarning || hasBlockingIssues) && styles.continueBtnWarning,
            ]}
            onPress={handleContinue}
            activeOpacity={0.85}
          >
            {!isWarning && !hasBlockingIssues ? (
              <Text style={styles.continueBtnText}>{t("review_receipt_looks_good")}</Text>
            ) : (
              <Text style={styles.continueBtnText}>Continue anyway →</Text>
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
