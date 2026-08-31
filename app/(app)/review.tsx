import React, { useState, useMemo, useEffect, useCallback, useRef } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Image,
  StyleSheet,
  useColorScheme,
  Alert,
  Modal,
  KeyboardAvoidingView,
  Platform,
  useWindowDimensions,
  BackHandler,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect } from "@react-navigation/native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "@/constants/colors";
import { useReceiptStore } from "@/store/receiptStore";
import { useSessionStore } from "@/store/sessionStore";
import { useAuthStore } from "@/store/authStore";
import { CategorySection } from "@/components/receipt/CategorySection";
import { GlobalCostsSection } from "@/components/receipt/GlobalCosts";
import { TipSelector } from "@/components/receipt/TipSelector";
import { Card } from "@/components/ui/Card";
import { formatCurrency } from "@/utils/formatter";
import { supabase, saveOCRCorrection } from "@/lib/supabase";
import { Session, ReceiptItem, ItemCategory, Currency, MenuGroup, ParsedReceipt } from "@/types";
import { generateItemId } from "@/utils/parser";
import { useI18nStore } from "@/store/i18nStore";
import { TranslationKey } from "@/constants/translations";
import { isOfflineSessionId } from "@/constants/dev";

const ORDERED_CATEGORIES: ItemCategory[] = [
  "starters",
  "mains",
  "drinks",
  "desserts",
  "others",
];

const CATEGORY_LABEL_KEYS: Record<ItemCategory, TranslationKey> = {
  starters: "lobby_cat_starters",
  mains: "lobby_cat_mains",
  drinks: "lobby_cat_drinks",
  desserts: "lobby_cat_desserts",
  others: "lobby_cat_others",
};

const isGroupingSuggestion = (item: ReceiptItem) =>
  item.warnings?.some((w) => w.toLowerCase().includes("consider grouping")) ?? false;

export default function ReviewScreen() {
  const isDark = useColorScheme() === "dark";
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { fromLobby } = useLocalSearchParams<{ fromLobby?: string }>();
  const isFromLobby = fromLobby === "true";
  const {
    receipt,
    rawOcrText,
    rawImageUri,
    setReceipt,
    setTip,
    setTipMode,
    groupItems,
    setRestaurantName,
    addItem,
    removeItem,
    updateItem,
    clearReceipt,
  } = useReceiptStore();
  const { setSession, currentSession, clearSession } = useSessionStore();
  const { profile, user } = useAuthStore();
  const { t, language } = useI18nStore();
  void language;

  const [creating, setCreating] = useState(false);
  const [imageModalVisible, setImageModalVisible] = useState(false);
  const [groupingChecked, setGroupingChecked] = useState<Set<string>>(new Set());
  const [ocrExpanded, setOcrExpanded] = useState(false);
  const [showMenuModal, setShowMenuModal] = useState(
    () => receipt?.needsMenuConfirmation ?? false
  );
  const [verifyModalVisible, setVerifyModalVisible] = useState(false);
  const sumMismatchAlertShownRef = useRef(false);
  const originalReceiptRef = useRef<ParsedReceipt | null>(null);

  // Add-item modal state
  const [addItemModal, setAddItemModal] = useState(false);
  const [newItemName, setNewItemName] = useState("");
  const [newItemCategory, setNewItemCategory] = useState<ItemCategory>("mains");
  const [newItemQty, setNewItemQty] = useState("1");
  const [newItemPrice, setNewItemPrice] = useState("");

  // Edit-item modal state
  const [editItem, setEditItem] = useState<ReceiptItem | null>(null);
  const [editName, setEditName] = useState("");
  const [editCategory, setEditCategory] = useState<ItemCategory>("mains");
  const [editQty, setEditQty] = useState("1");
  const [editUnitPrice, setEditUnitPrice] = useState("");
  const [editTotalPrice, setEditTotalPrice] = useState("");

  useEffect(() => {
    if (receipt) {
      const itemCount = Object.values(receipt.categories).flat().length;
      console.log(`[review] Loaded receipt: ${receipt.restaurant} (${itemCount} items)`);
    }
  }, [receipt?.restaurant]);

  // Snapshot the original OCR output once on mount — used later to diff corrections.
  useEffect(() => {
    if (receipt && !originalReceiptRef.current) {
      originalReceiptRef.current = JSON.parse(JSON.stringify(receipt)) as ParsedReceipt;
    }
  }, [receipt]);

  const handleBack = useCallback(() => {
    if (isFromLobby) {
      router.back();
      return;
    }
    Alert.alert(
      "Cancelar scan?",
      "Voltar atrás irá cancelar o scan atual. Terás de digitalizar novamente.",
      [
        { text: "Continuar", style: "cancel" },
        {
          text: "Cancelar scan",
          style: "destructive",
          onPress: async () => {
            if (
              currentSession &&
              !currentSession.id.startsWith("session_") &&
              !currentSession.id.startsWith("dev_session_")
            ) {
              try {
                await supabase
                  .from("sessions")
                  .update({ status: "closed" })
                  .eq("id", currentSession.id);
              } catch {}
            }
            clearReceipt();
            clearSession();
            router.replace("/(app)");
          },
        },
      ]
    );
  }, [clearReceipt, clearSession, currentSession, isFromLobby]);

  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener("hardwareBackPress", () => {
        handleBack();
        return true;
      });
      return () => sub.remove();
    }, [handleBack])
  );

  const textColor = isDark ? Colors.textPrimaryDark : Colors.textPrimaryLight;
  const mutedColor = isDark ? Colors.textMutedDark : Colors.textMutedLight;
  const bgColor = isDark ? Colors.bgDark : Colors.bgLight;
  const borderColor = isDark ? Colors.cardBorderDark : Colors.cardBorderLight;
  const cardColor = isDark ? Colors.cardDark : Colors.cardLight;

  const allItems = useMemo(
    () => (receipt ? Object.values(receipt.categories).flat() : []),
    [receipt]
  );

  const subtotal = useMemo(
    () => allItems.reduce((s, i) => s + i.totalPrice, 0),
    [allItems]
  );

  const computedTotal = useMemo(() => {
    if (!receipt) return 0;
    const costs = receipt.globalCosts.reduce((s, c) => s + c.amount, 0);
    return subtotal + costs + (receipt.selectedTip ?? 0);
  }, [subtotal, receipt]);

  const mathErrorItemIds = useMemo(() => {
    if (!receipt) return new Set<string>();
    const ids = new Set<string>();
    for (const item of allItems) {
      if (item.unitPrice > 0 && item.totalPrice > 0) {
        const expected = Math.round(item.quantity * item.unitPrice * 100) / 100;
        if (Math.abs(expected - item.totalPrice) > 0.02) ids.add(item.id);
      }
    }
    return ids;
  }, [receipt, allItems]);

  // Informational: items where unit × qty ≠ total by more than €0.10 (likely promos/menus)
  const priceDiscrepancies = useMemo(() => {
    if (!receipt) return [];
    return allItems
      .filter((item) => {
        if (item.totalPrice <= 0 || item.type === "combo") return false;
        const expected = Math.round(item.quantity * item.unitPrice * 100) / 100;
        return Math.abs(expected - item.totalPrice) > 0.10;
      })
      .map((item) => {
        const expected = Math.round(item.quantity * item.unitPrice * 100) / 100;
        return `${item.name}: expected ${formatCurrency(expected, receipt.currency)} but shows ${formatCurrency(item.totalPrice, receipt.currency)}`;
      });
  }, [receipt, allItems]);

  const ocrSecondPass = receipt?.ocr_passes === 2;

  const itemWarnings = useMemo(
    () =>
      allItems
        .filter(
          (item) =>
            item.warnings &&
            item.warnings.length > 0 &&
            !item.warnings.every((w) => w.toLowerCase().includes("consider grouping"))
        )
        .flatMap((item) =>
          (item.warnings ?? [])
            .filter((w) => !w.toLowerCase().includes("consider grouping"))
            .map((w) => `${item.name}: ${w}`)
        ),
    [allItems]
  );

  const sumMismatch = useMemo(() => {
    if (!receipt?.printed_total || receipt.printed_total <= 0) return false;
    const costsTotal = receipt.globalCosts.reduce((s, c) => s + c.amount, 0);
    return Math.abs(subtotal + costsTotal - receipt.printed_total) > 0.50;
  }, [receipt, subtotal]);

  useEffect(() => {
    if (sumMismatchAlertShownRef.current) return;
    if (receipt?.ocr_passes === 2 && sumMismatch) {
      sumMismatchAlertShownRef.current = true;
      Alert.alert(t("review_sum_mismatch_title"), t("review_sum_mismatch_msg"), [{ text: t("ok") }]);
    }
  }, [sumMismatch]); // eslint-disable-line react-hooks/exhaustive-deps

  const groupingCandidates = useMemo(
    () => (receipt ? ORDERED_CATEGORIES.flatMap((c) => receipt.categories[c].filter(isGroupingSuggestion)) : []),
    [receipt]
  );

  const groupingCandidateIds = useMemo(
    () => new Set(groupingCandidates.map((i) => i.id)),
    [groupingCandidates]
  );

  const toggleGroupingCheck = (itemId: string) => {
    setGroupingChecked((prev) => {
      const next = new Set(prev);
      next.has(itemId) ? next.delete(itemId) : next.add(itemId);
      return next;
    });
  };

  const handleItemPress = useCallback(
    (item: ReceiptItem) => {
      setEditItem(item);
      setEditName(item.name);
      setEditCategory(item.category);
      setEditQty(String(item.quantity));
      setEditUnitPrice(String(item.unitPrice));
      setEditTotalPrice(String(item.totalPrice));
    },
    []
  );

  const handleSaveEdit = () => {
    if (!editItem) return;
    const qty = Math.max(1, parseInt(editQty) || 1);
    const unitPrice = Math.max(0, parseFloat(editUnitPrice.replace(",", ".")) || 0);
    const totalPrice = Math.max(0, parseFloat(editTotalPrice.replace(",", ".")) || unitPrice * qty);
    const finalTotal = Math.round(totalPrice * 100) / 100;
    if (editCategory !== editItem.category) {
      removeItem(editItem.id);
      addItem(editCategory, {
        ...editItem,
        name: editName.trim() || editItem.name,
        category: editCategory,
        quantity: qty,
        unitPrice,
        totalPrice: finalTotal,
      });
    } else {
      updateItem(editItem.category, editItem.id, {
        name: editName.trim() || editItem.name,
        quantity: qty,
        unitPrice,
        totalPrice: finalTotal,
      });
    }
    setEditItem(null);
  };

  const handleDeleteFromEdit = () => {
    if (!editItem) return;
    removeItem(editItem.id);
    setEditItem(null);
  };

  const adjustEditQty = (delta: number) => {
    setEditQty((prev) => String(Math.max(1, (parseInt(prev) || 1) + delta)));
  };

  const openAddItem = () => {
    setNewItemName("");
    setNewItemQty("1");
    setNewItemPrice("");
    setNewItemCategory("mains");
    setAddItemModal(true);
  };

  const handleAddItem = () => {
    const qty = Math.max(1, parseInt(newItemQty) || 1);
    const price = parseFloat(newItemPrice.replace(",", ".")) || 0;
    if (!newItemName.trim()) {
      Alert.alert(t("review_missing_name"), t("review_missing_name_msg"));
      return;
    }
    if (price <= 0) {
      Alert.alert(t("review_missing_price"), t("review_missing_price_msg"));
      return;
    }
    const item: ReceiptItem = {
      id: generateItemId(),
      name: newItemName.trim(),
      category: newItemCategory,
      quantity: qty,
      unitPrice: price,
      totalPrice: Math.round(price * qty * 100) / 100,
      type: qty > 1 ? "quantity" : "individual",
    };
    addItem(newItemCategory, item);
    setAddItemModal(false);
  };

  const adjustQty = (delta: number) => {
    setNewItemQty((prev) => String(Math.max(1, (parseInt(prev) || 1) + delta)));
  };

  const handleConfirm = async () => {
    if (!receipt) return;
    if (allItems.length === 0) {
      Alert.alert(t("review_no_items_alert"), t("review_no_items_alert_msg"), [{ text: t("ok") }]);
      return;
    }
    if (!profile) {
      Alert.alert(t("review_profile_required"), t("review_profile_required_msg"));
      router.push("/(auth)/profile-setup");
      return;
    }

    // Returning from lobby to edit receipt — update existing session and go back
    if (isFromLobby && currentSession) {
      setCreating(true);
      try {
        const sessionId = currentSession.id;
        if (!isOfflineSessionId(sessionId)) {
          await supabase
            .from("sessions")
            .update({ receipt_data: receipt })
            .eq("id", sessionId);
        }
        setSession({ ...currentSession, receipt });
        router.back();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        Alert.alert(t("review_failed_create"), msg || t("error_connection"));
      } finally {
        setCreating(false);
      }
      return;
    }

    setCreating(true);
    try {
      console.log("[review] handleConfirm — user:", user?.id, "profile:", profile?.id);
      const existingSession = currentSession;
      // Pre-existing session = created from home before scanning (no receipt yet)
      const isPreExistingSession = !!existingSession?.id && !existingSession.receipt;

      let sessionId: string;
      let existingParticipants = existingSession?.participants ?? [];

      if (isPreExistingSession && existingSession) {
        sessionId = existingSession.id;
        if (user && !isOfflineSessionId(sessionId)) {
          const { error } = await supabase
            .from("sessions")
            .update({ receipt_data: receipt, status: "draft" })
            .eq("id", sessionId);
          if (error) throw error;
        }
      } else if (user) {
        const { data, error } = await supabase
          .from("sessions")
          .insert({
            host_id: user.id,
            receipt_data: receipt,
            status: "draft",
          })
          .select("id")
          .single();
        if (error) throw error;
        sessionId = data.id;
        existingParticipants = [];
        await supabase.from("session_participants").insert({
          session_id: sessionId,
          user_id: user.id,
          selections: [],
          total_owed: 0,
          paid: false,
          confirmed_by_creator: true,
        });
      } else {
        sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        existingParticipants = [];
      }

      const session: Session = {
        id: sessionId,
        creatorId: profile.id,
        receiptId: sessionId,
        receipt,
        status: "draft",
        createdAt: existingSession?.createdAt ?? new Date().toISOString(),
        confirmedBy: [profile.id],
        participants: existingParticipants.length > 0
          ? existingParticipants
          : [
              {
                userId: profile.id,
                profile,
                selections: [],
                totalOwed: 0,
                paid: false,
                confirmedByCreator: true,
              },
            ],
      };
      setSession(session);

      // Fire-and-forget: log OCR corrections for future fine-tuning
      const original = originalReceiptRef.current;
      if (original && user) {
        void (async () => {
          try {
            const origItems = Object.values(original.categories).flat();
            const currItems = Object.values(receipt.categories).flat();
            const origMap = new Map(origItems.map((i) => [i.id, i]));
            const currMap = new Map(currItems.map((i) => [i.id, i]));

            const correctedItems: Array<{ item_id: string; field: string; before: unknown; after: unknown }> = [];
            const correctionTypes = new Set<string>();

            for (const [id, orig] of origMap) {
              const curr = currMap.get(id);
              if (!curr) {
                correctedItems.push({ item_id: id, field: "item", before: orig.name, after: null });
                correctionTypes.add("item_missing");
              } else {
                if (Math.abs(orig.totalPrice - curr.totalPrice) > 0.01) {
                  correctedItems.push({ item_id: id, field: "totalPrice", before: orig.totalPrice, after: curr.totalPrice });
                  correctionTypes.add("price_wrong");
                }
                if (orig.quantity !== curr.quantity) {
                  correctedItems.push({ item_id: id, field: "quantity", before: orig.quantity, after: curr.quantity });
                  correctionTypes.add("qty_wrong");
                }
                if (orig.name !== curr.name) {
                  correctedItems.push({ item_id: id, field: "name", before: orig.name, after: curr.name });
                  correctionTypes.add("item_name_typo");
                }
              }
            }
            for (const [id, curr] of currMap) {
              if (!origMap.has(id)) {
                correctedItems.push({ item_id: id, field: "item", before: null, after: curr.name });
                correctionTypes.add("item_added");
              }
            }

            if (correctedItems.length > 0) {
              await saveOCRCorrection({
                sessionId: sessionId ?? null,
                userId: user.id,
                receiptImagePath: rawImageUri ?? null,
                originalOcrJson: original,
                userCorrectedJson: receipt,
                correctedItems,
                correctionType: [...correctionTypes],
                ocrPasses: receipt.ocr_passes ?? 1,
              });
            }
          } catch {
            // Silently swallow — never impact user flow
          }
        })();
      }

      router.replace(`/(app)/session-lobby/${sessionId}`);
    } catch (err: unknown) {
      console.error("[review] handleConfirm failed:", err);
      const pgErr = err as { message?: string; code?: string; details?: string; hint?: string } | null;
      if (pgErr?.code) {
        console.error("[review] Supabase error code:", pgErr.code, "| details:", pgErr.details, "| hint:", pgErr.hint);
      }
      const msg = err instanceof Error ? err.message : pgErr?.message ?? JSON.stringify(err);
      Alert.alert(t("review_failed_create"), msg || t("error_connection"));
    } finally {
      setCreating(false);
    }
  };

  if (!receipt) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: bgColor }]}>
        <View style={styles.emptyContainer}>
          <Text style={[styles.emptyText, { color: mutedColor }]}>
            {t("review_no_receipt")}
          </Text>
          <TouchableOpacity onPress={() => router.replace("/(app)/scan")}>
            <Text style={{ color: Colors.primary, marginTop: 12, fontSize: 16 }}>
              {t("review_back_to_scan")}
            </Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: bgColor }]}>
      <Stack.Screen options={{ gestureEnabled: false }} />
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={handleBack}>
          <Ionicons name="arrow-back" size={24} color={textColor} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <TextInput
            style={[styles.restaurantInput, { color: textColor }]}
            value={receipt.restaurant}
            onChangeText={setRestaurantName}
            placeholder={t("review_restaurant_ph")}
            placeholderTextColor={mutedColor}
            returnKeyType="done"
          />
          <Text style={[styles.currencyLabel, { color: mutedColor }]}>
            {receipt.currency}
          </Text>
        </View>
        <TouchableOpacity
          onPress={() => setVerifyModalVisible(true)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons
            name="calculator-outline"
            size={22}
            color={ocrSecondPass || sumMismatch || itemWarnings.length > 0 ? "#F59E0B" : mutedColor}
          />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.scroll}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: 16 + Math.max(insets.bottom, 16) },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        {/* Validation error banner */}
        {mathErrorItemIds.size > 0 && (
          <View style={[styles.validationBanner, { backgroundColor: "#F59E0B15", borderColor: "#F59E0B" }]}>
            <Ionicons name="warning-outline" size={16} color="#F59E0B" />
            <Text style={[styles.validationBannerText, { color: "#F59E0B" }]}>
              {mathErrorItemIds.size} {mathErrorItemIds.size !== 1 ? t("session_items") : t("session_item")} {t("review_math_errors_suffix")}
            </Text>
          </View>
        )}

        {/* Price discrepancy info banner (promos/menus — informational) */}
        {priceDiscrepancies.length > 0 && mathErrorItemIds.size === 0 && (
          <View style={[styles.validationBanner, { backgroundColor: "#3B82F615", borderColor: "#3B82F6" }]}>
            <Ionicons name="information-circle-outline" size={16} color="#3B82F6" />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[styles.validationBannerText, { color: "#3B82F6" }]}>
                {t("review_promo_note")}
              </Text>
              {priceDiscrepancies.slice(0, 3).map((d, i) => (
                <Text key={i} style={[styles.discrepancyLine, { color: "#3B82F6" }]}>• {d}</Text>
              ))}
            </View>
          </View>
        )}

        {/* OCR second-pass banner */}
        {ocrSecondPass && (
          <View style={[styles.validationBanner, { backgroundColor: "#F59E0B15", borderColor: "#F59E0B" }]}>
            <Ionicons name="warning-outline" size={16} color="#F59E0B" />
            <Text style={[styles.validationBannerText, { color: "#F59E0B" }]}>
              {t("review_second_pass_banner")}
            </Text>
          </View>
        )}

        {/* Item-level warnings from OCR */}
        {itemWarnings.length > 0 && (
          <View style={[styles.validationBanner, { backgroundColor: "#F59E0B15", borderColor: "#F59E0B" }]}>
            <Ionicons name="warning-outline" size={16} color="#F59E0B" />
            <View style={{ flex: 1, gap: 3 }}>
              {itemWarnings.slice(0, 4).map((w, i) => (
                <Text key={i} style={[styles.discrepancyLine, { color: "#F59E0B" }]}>⚠️ {w}</Text>
              ))}
            </View>
          </View>
        )}

        {/* Sum mismatch disclaimer (non-blocking) */}
        {sumMismatch && (
          <View style={[styles.validationBanner, { backgroundColor: "#EF444415", borderColor: "#EF4444" }]}>
            <Ionicons name="alert-circle-outline" size={16} color="#EF4444" />
            <Text style={[styles.validationBannerText, { color: "#EF4444" }]}>
              {t("review_sum_mismatch_banner")}
            </Text>
          </View>
        )}

        {/* Raw OCR text (collapsible) */}
        {rawOcrText ? (
          <View style={[styles.ocrPanel, { borderColor }]}>
            <TouchableOpacity
              style={styles.ocrPanelHeader}
              onPress={() => setOcrExpanded((v) => !v)}
              activeOpacity={0.7}
            >
              <Text style={[styles.ocrPanelTitle, { color: mutedColor }]}>
                {t("review_raw_ocr")}
              </Text>
              <Ionicons
                name={ocrExpanded ? "chevron-up" : "chevron-down"}
                size={16}
                color={mutedColor}
              />
            </TouchableOpacity>
            {ocrExpanded && (
              <Text style={[styles.ocrPanelBody, { color: mutedColor }]}>
                {rawOcrText}
              </Text>
            )}
          </View>
        ) : null}

        {/* Grouping banner */}
        {groupingCandidates.length > 0 && (
          <View style={[styles.groupingBanner, { borderColor: Colors.warning, backgroundColor: Colors.warning + "15" }]}>
            <View style={styles.groupingBannerLeft}>
              <Ionicons name="git-merge-outline" size={15} color={Colors.warning} />
              <Text style={styles.groupingBannerText}>
                {groupingCandidates.length} {groupingCandidates.length !== 1 ? t("session_items") : t("session_item")} {t("review_grouping_suffix")}
              </Text>
            </View>
            {groupingChecked.size >= 2 && (
              <TouchableOpacity
                style={styles.groupSelectedBtn}
                onPress={() => {
                  groupItems([...groupingChecked]);
                  setGroupingChecked(new Set());
                }}
              >
                <Ionicons name="git-merge-outline" size={13} color="#fff" />
                <Text style={styles.groupSelectedBtnText}>
                  {t("review_group_btn")} ({groupingChecked.size})
                </Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* Receipt card */}
        <Card style={styles.receiptCard} padding={0}>
          {/* Empty state */}
          {allItems.length === 0 && (
            <View style={styles.emptyItemsState}>
              <Ionicons name="receipt-outline" size={40} color={mutedColor} />
              <Text style={[styles.emptyItemsTitle, { color: textColor }]}>
                {t("review_empty_receipt")}
              </Text>
              <Text style={[styles.emptyItemsSub, { color: mutedColor }]}>
                {t("review_empty_receipt_sub")}
              </Text>
            </View>
          )}

          {/* Category sections */}
          {ORDERED_CATEGORIES.map((cat) => (
            <CategorySection
              key={cat}
              category={cat}
              items={receipt.categories[cat]}
              currency={receipt.currency}
              onItemPress={handleItemPress}
              groupingCandidateIds={groupingCandidateIds}
              groupingCheckedIds={groupingChecked}
              onGroupingToggle={toggleGroupingCheck}
              showEditIcon
              mathErrorItemIds={mathErrorItemIds}
            />
          ))}

          {/* Add item button */}
          <TouchableOpacity
            style={[styles.addItemBtn, { borderColor: Colors.primary }]}
            onPress={openAddItem}
            activeOpacity={0.7}
          >
            <Ionicons name="add-circle-outline" size={20} color={Colors.primary} />
            <Text style={[styles.addItemBtnText, { color: Colors.primary }]}>
              {t("review_add_item")}
            </Text>
          </TouchableOpacity>

          {/* Global costs */}
          <GlobalCostsSection
            costs={receipt.globalCosts}
            currency={receipt.currency}
            tipAmount={receipt.selectedTip}
          />

          {/* Tip selector */}
          <TipSelector
            suggestedTips={receipt.suggestedTips}
            currency={receipt.currency}
            subtotal={subtotal}
            currentTipStatus={receipt.tipStatus}
            currentTipAmount={receipt.selectedTip}
            currentTipMode={receipt.tipMode ?? "equal"}
            onSelect={(status, amount, pct) => setTip(status, amount, pct)}
            onTipModeChange={(mode) => {
              setTipMode(mode);
              if (mode === "individual") setTip("removed", 0);
            }}
          />
        </Card>

        {/* Original receipt photo — collapsible preview at bottom of scroll */}
        {rawImageUri && (
          <TouchableOpacity
            style={[styles.photoCard, { borderColor }]}
            onPress={() => setImageModalVisible(true)}
            activeOpacity={0.8}
          >
            <Image source={{ uri: rawImageUri }} style={styles.photoThumb} resizeMode="cover" />
            <View style={styles.photoOverlay}>
              <Ionicons name="expand-outline" size={20} color="#fff" />
              <Text style={styles.photoOverlayText}>{t("review_view_photo")}</Text>
            </View>
          </TouchableOpacity>
        )}

        {/* Items hint when empty */}
        {allItems.length === 0 && (
          <View style={[styles.hintBar, { backgroundColor: Colors.primary + "15", borderColor: Colors.primary }]}>
            <Ionicons name="information-circle-outline" size={16} color={Colors.primary} />
            <Text style={[styles.hintText, { color: Colors.primary }]}>
              {t("review_hint_add_item")}
            </Text>
          </View>
        )}
      </ScrollView>

      {/* Footer */}
      <View
        style={[
          styles.footer,
          {
            backgroundColor: bgColor,
            borderColor,
            paddingBottom: 20 + Math.max(insets.bottom, 16),
          },
        ]}
      >
        {(() => {
          const tipAmount = receipt.selectedTip ?? 0;
          const baseTotal = computedTotal - tipAmount;
          const tipPct = subtotal > 0 && tipAmount > 0
            ? Math.round((tipAmount / subtotal) * 100)
            : 0;
          return tipAmount > 0 ? (
            <>
              <View style={styles.totalRow}>
                <Text style={[styles.totalLabel, { color: mutedColor }]}>{t("review_subtotal")}</Text>
                <Text style={[styles.totalAmountSm, { color: mutedColor }]}>
                  {formatCurrency(baseTotal, receipt.currency)}
                </Text>
              </View>
              <View style={styles.totalRow}>
                <Text style={[styles.totalLabel, { color: mutedColor }]}>
                  {t("review_tip")} {tipPct > 0 ? `(${tipPct}%)` : ""}
                </Text>
                <Text style={[styles.tipLineAmt, { color: Colors.success }]}>
                  +{formatCurrency(tipAmount, receipt.currency)}
                </Text>
              </View>
              <View style={[styles.footerDivider, { backgroundColor: borderColor }]} />
              <View style={styles.totalRow}>
                <Text style={[styles.totalLabel, { color: textColor, fontWeight: "700" }]}>{t("review_total")}</Text>
                <Text style={[styles.totalAmount, { color: textColor }]}>
                  {formatCurrency(computedTotal, receipt.currency)}
                </Text>
              </View>
            </>
          ) : (
            <View style={styles.totalRow}>
              <Text style={[styles.totalLabel, { color: mutedColor }]}>{t("review_total")}</Text>
              <Text style={[styles.totalAmount, { color: textColor }]}>
                {formatCurrency(computedTotal, receipt.currency)}
              </Text>
            </View>
          );
        })()}
        <TouchableOpacity
          style={[
            styles.confirmBtn,
            (creating || allItems.length === 0) && styles.confirmBtnDisabled,
          ]}
          onPress={handleConfirm}
          disabled={creating}
        >
          <Text style={styles.confirmBtnText}>
            {creating ? t("review_creating_session") : t("review_confirm_btn")}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Edit Item Modal */}
      <Modal
        visible={!!editItem}
        transparent
        animationType="slide"
        onRequestClose={() => setEditItem(null)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={styles.modalOverlay}
        >
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            onPress={() => setEditItem(null)}
            activeOpacity={1}
          />
          <View style={[styles.modalCard, { backgroundColor: cardColor }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: textColor }]}>{t("review_edit_item")}</Text>
              <TouchableOpacity onPress={() => setEditItem(null)}>
                <Ionicons name="close" size={24} color={mutedColor} />
              </TouchableOpacity>
            </View>

            {/* Name */}
            <Text style={[styles.fieldLabel, { color: mutedColor }]}>{t("review_field_name")}</Text>
            <TextInput
              style={[styles.fieldInput, { color: textColor, borderColor, backgroundColor: bgColor }]}
              value={editName}
              onChangeText={setEditName}
              placeholder={t("review_field_name")}
              placeholderTextColor={mutedColor}
              autoFocus
              returnKeyType="next"
            />

            {/* Category */}
            <Text style={[styles.fieldLabel, { color: mutedColor }]}>{t("review_field_category")}</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.categoryRow}
            >
              {ORDERED_CATEGORIES.map((cat) => (
                <TouchableOpacity
                  key={cat}
                  style={[
                    styles.categoryChip,
                    { borderColor },
                    editCategory === cat && styles.categoryChipActive,
                  ]}
                  onPress={() => setEditCategory(cat)}
                >
                  <Text
                    style={[
                      styles.categoryChipText,
                      { color: editCategory === cat ? Colors.primary : mutedColor },
                    ]}
                  >
                    {t(CATEGORY_LABEL_KEYS[cat])}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            {/* Qty + Unit Price row */}
            <View style={styles.qtyPriceRow}>
              <View style={styles.qtyBlock}>
                <Text style={[styles.fieldLabel, { color: mutedColor }]}>{t("review_field_qty")}</Text>
                <View style={styles.qtyControl}>
                  <TouchableOpacity
                    style={[styles.qtyBtn, { borderColor }]}
                    onPress={() => adjustEditQty(-1)}
                  >
                    <Ionicons name="remove" size={16} color={textColor} />
                  </TouchableOpacity>
                  <TextInput
                    style={[styles.qtyInput, { color: textColor, borderColor, backgroundColor: bgColor }]}
                    value={editQty}
                    onChangeText={setEditQty}
                    keyboardType="number-pad"
                    textAlign="center"
                  />
                  <TouchableOpacity
                    style={[styles.qtyBtn, { borderColor }]}
                    onPress={() => adjustEditQty(1)}
                  >
                    <Ionicons name="add" size={16} color={textColor} />
                  </TouchableOpacity>
                </View>
              </View>

              <View style={styles.priceBlock}>
                <Text style={[styles.fieldLabel, { color: mutedColor }]}>{t("review_field_unit_price")}</Text>
                <TextInput
                  style={[styles.fieldInput, { color: textColor, borderColor, backgroundColor: bgColor }]}
                  value={editUnitPrice}
                  onChangeText={(v) => {
                    setEditUnitPrice(v);
                    const unit = parseFloat(v.replace(",", "."));
                    const qty = parseInt(editQty) || 1;
                    if (!isNaN(unit)) {
                      setEditTotalPrice(String(Math.round(unit * qty * 100) / 100));
                    }
                  }}
                  placeholder="0.00"
                  placeholderTextColor={mutedColor}
                  keyboardType="decimal-pad"
                />
              </View>
            </View>

            {/* Total price */}
            <Text style={[styles.fieldLabel, { color: mutedColor }]}>{t("review_field_total")}</Text>
            <TextInput
              style={[styles.fieldInput, { color: textColor, borderColor, backgroundColor: bgColor }]}
              value={editTotalPrice}
              onChangeText={setEditTotalPrice}
              placeholder="0.00"
              placeholderTextColor={mutedColor}
              keyboardType="decimal-pad"
            />

            {/* Action buttons */}
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalCancelBtn, { borderColor }]}
                onPress={() => setEditItem(null)}
              >
                <Text style={[styles.modalCancelText, { color: mutedColor }]}>{t("cancel")}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalConfirmBtn} onPress={handleSaveEdit}>
                <Ionicons name="checkmark" size={18} color="#fff" />
                <Text style={styles.modalConfirmText}>{t("save")}</Text>
              </TouchableOpacity>
            </View>

            {/* Delete */}
            <TouchableOpacity style={styles.editDeleteBtn} onPress={handleDeleteFromEdit}>
              <Ionicons name="trash-outline" size={16} color="#FF3B30" />
              <Text style={styles.editDeleteText}>{t("review_delete_item")}</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Menu Confirmation Modal */}
      <Modal
        visible={showMenuModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowMenuModal(false)}
      >
        <View style={styles.modalOverlay}>
          <TouchableOpacity style={StyleSheet.absoluteFill} onPress={() => setShowMenuModal(false)} activeOpacity={1} />
          <View style={[styles.modalCard, { backgroundColor: cardColor }]}>
            <View style={styles.modalHeader}>
              <Text style={{ fontSize: 20 }}>🍔</Text>
              <Text style={[styles.modalTitle, { color: textColor }]}>{t("review_menu_title")}</Text>
              <TouchableOpacity onPress={() => setShowMenuModal(false)}>
                <Ionicons name="close" size={24} color={mutedColor} />
              </TouchableOpacity>
            </View>

            <Text style={[styles.menuModalSub, { color: mutedColor }]}>
              {t("review_menu_body")}
            </Text>

            {/* Preview groups */}
            {(receipt?.suggestedMenuGroups ?? []).slice(0, 2).map((group, gi) => (
              <View key={gi} style={[styles.menuGroupPreview, { borderColor }]}>
                <Text style={[styles.menuGroupParent, { color: textColor }]}>
                  {group.menuItem.name} — {formatCurrency(group.menuItem.totalPrice, receipt!.currency)}
                </Text>
                {group.components.slice(0, 5).map((c, ci) => (
                  <Text key={ci} style={[styles.menuGroupChild, { color: mutedColor }]}>
                    {ci === group.components.length - 1 || ci === 4 ? "└─" : "├─"} {c.name} ({formatCurrency(c.unitPrice, receipt!.currency)} → €0.00)
                  </Text>
                ))}
              </View>
            ))}

            <View style={styles.menuActions}>
              <TouchableOpacity
                style={[styles.menuActionBtn, { backgroundColor: Colors.primary }]}
                onPress={() => {
                  if (!receipt) return;
                  // Attach zero-price items as components of the first combo/menu parent
                  const groups = receipt.suggestedMenuGroups ?? [];
                  if (groups.length > 0) {
                    const updatedCategories = { ...receipt.categories };
                    groups.forEach((group) => {
                      const cat = group.menuItem.category;
                      updatedCategories[cat] = (updatedCategories[cat] ?? []).map((item) => {
                        if (item.id === group.menuItem.id) {
                          return { ...item, components: [...(item.components ?? []), ...group.components] };
                        }
                        return item;
                      });
                    });
                    setReceipt({ ...receipt, categories: updatedCategories, needsMenuConfirmation: false, suggestedMenuGroups: undefined });
                  }
                  setShowMenuModal(false);
                }}
              >
                <Text style={styles.menuActionText}>{t("review_menu_group")}</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.menuActionBtn, { backgroundColor: "#6B7280" }]}
                onPress={() => {
                  if (!receipt) return;
                  // Add zero-price items as-is into their category
                  const groups = receipt.suggestedMenuGroups ?? [];
                  const updatedCategories = { ...receipt.categories };
                  groups.forEach((group) => {
                    group.components.forEach((c) => {
                      const cat = c.category;
                      if (!updatedCategories[cat].find((i) => i.id === c.id)) {
                        updatedCategories[cat] = [...(updatedCategories[cat] ?? []), c];
                      }
                    });
                  });
                  setReceipt({ ...receipt, categories: updatedCategories, needsMenuConfirmation: false, suggestedMenuGroups: undefined });
                  setShowMenuModal(false);
                }}
              >
                <Text style={styles.menuActionText}>{t("review_menu_separate")}</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.menuActionBtn, { backgroundColor: "#EF4444" }]}
                onPress={() => {
                  if (!receipt) return;
                  setReceipt({ ...receipt, needsMenuConfirmation: false, suggestedMenuGroups: undefined });
                  setShowMenuModal(false);
                }}
              >
                <Text style={styles.menuActionText}>{t("review_menu_remove")}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Add Item Modal */}
      <Modal
        visible={addItemModal}
        transparent
        animationType="slide"
        onRequestClose={() => setAddItemModal(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={styles.modalOverlay}
        >
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            onPress={() => setAddItemModal(false)}
            activeOpacity={1}
          />
          <View style={[styles.modalCard, { backgroundColor: cardColor }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: textColor }]}>{t("review_add_item")}</Text>
              <TouchableOpacity onPress={() => setAddItemModal(false)}>
                <Ionicons name="close" size={24} color={mutedColor} />
              </TouchableOpacity>
            </View>

            {/* Name */}
            <Text style={[styles.fieldLabel, { color: mutedColor }]}>{t("review_field_name")}</Text>
            <TextInput
              style={[styles.fieldInput, { color: textColor, borderColor, backgroundColor: bgColor }]}
              value={newItemName}
              onChangeText={setNewItemName}
              placeholder={t("review_item_example")}
              placeholderTextColor={mutedColor}
              autoFocus
              returnKeyType="next"
            />

            {/* Category */}
            <Text style={[styles.fieldLabel, { color: mutedColor }]}>{t("review_field_category")}</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.categoryRow}
            >
              {ORDERED_CATEGORIES.map((cat) => (
                <TouchableOpacity
                  key={cat}
                  style={[
                    styles.categoryChip,
                    { borderColor },
                    newItemCategory === cat && styles.categoryChipActive,
                  ]}
                  onPress={() => setNewItemCategory(cat)}
                >
                  <Text
                    style={[
                      styles.categoryChipText,
                      { color: newItemCategory === cat ? Colors.primary : mutedColor },
                    ]}
                  >
                    {t(CATEGORY_LABEL_KEYS[cat])}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            {/* Qty + Price row */}
            <View style={styles.qtyPriceRow}>
              <View style={styles.qtyBlock}>
                <Text style={[styles.fieldLabel, { color: mutedColor }]}>{t("review_field_qty")}</Text>
                <View style={styles.qtyControl}>
                  <TouchableOpacity
                    style={[styles.qtyBtn, { borderColor }]}
                    onPress={() => adjustQty(-1)}
                  >
                    <Ionicons name="remove" size={16} color={textColor} />
                  </TouchableOpacity>
                  <TextInput
                    style={[styles.qtyInput, { color: textColor, borderColor, backgroundColor: bgColor }]}
                    value={newItemQty}
                    onChangeText={setNewItemQty}
                    keyboardType="number-pad"
                    textAlign="center"
                  />
                  <TouchableOpacity
                    style={[styles.qtyBtn, { borderColor }]}
                    onPress={() => adjustQty(1)}
                  >
                    <Ionicons name="add" size={16} color={textColor} />
                  </TouchableOpacity>
                </View>
              </View>

              <View style={styles.priceBlock}>
                <Text style={[styles.fieldLabel, { color: mutedColor }]}>
                  {t("review_field_price_per_item")}
                </Text>
                <TextInput
                  style={[styles.fieldInput, { color: textColor, borderColor, backgroundColor: bgColor }]}
                  value={newItemPrice}
                  onChangeText={setNewItemPrice}
                  placeholder="0.00"
                  placeholderTextColor={mutedColor}
                  keyboardType="decimal-pad"
                  returnKeyType="done"
                />
              </View>
            </View>

            {/* Total preview */}
            {newItemPrice !== "" && parseFloat(newItemPrice.replace(",", ".")) > 0 && (
              <Text style={[styles.totalPreview, { color: mutedColor }]}>
                {t("review_total")}:{" "}
                {formatCurrency(
                  Math.round(
                    parseFloat(newItemPrice.replace(",", ".")) *
                    (parseInt(newItemQty) || 1) * 100
                  ) / 100,
                  receipt.currency
                )}
              </Text>
            )}

            {/* Buttons */}
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalCancelBtn, { borderColor }]}
                onPress={() => setAddItemModal(false)}
              >
                <Text style={[styles.modalCancelText, { color: mutedColor }]}>
                  {t("cancel")}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.modalConfirmBtn}
                onPress={handleAddItem}
              >
                <Ionicons name="add" size={18} color="#fff" />
                <Text style={styles.modalConfirmText}>{t("review_add_item")}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Verify Receipt Breakdown Modal */}
      <Modal
        visible={verifyModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setVerifyModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <TouchableOpacity style={StyleSheet.absoluteFill} onPress={() => setVerifyModalVisible(false)} activeOpacity={1} />
          <View style={[styles.modalCard, { backgroundColor: cardColor, maxHeight: "80%" }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: textColor }]}>{t("review_verify_title")}</Text>
              <TouchableOpacity onPress={() => setVerifyModalVisible(false)}>
                <Ionicons name="close" size={24} color={mutedColor} />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} style={{ flexGrow: 0 }}>
              {allItems.map((item) => (
                <View key={item.id} style={[styles.verifyRow, { borderColor }]}>
                  <Text style={[styles.verifyItemName, { color: textColor }]} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Text style={[styles.verifyItemCalc, { color: mutedColor }]}>
                    {item.quantity > 1
                      ? `${item.quantity} × ${formatCurrency(item.unitPrice, receipt.currency)} = `
                      : ""}
                    {formatCurrency(item.totalPrice, receipt.currency)}
                  </Text>
                </View>
              ))}

              <View style={[styles.verifyTotalRow, { borderColor }]}>
                <Text style={[styles.verifyTotalLabel, { color: mutedColor }]}>{t("review_verify_items_sum")}</Text>
                <Text style={[styles.verifyTotalAmt, { color: textColor }]}>{formatCurrency(subtotal, receipt.currency)}</Text>
              </View>

              {receipt.printed_total ? (
                <>
                  <View style={styles.verifyTotalRow}>
                    <Text style={[styles.verifyTotalLabel, { color: mutedColor }]}>{t("review_verify_printed")}</Text>
                    <Text style={[styles.verifyTotalAmt, { color: textColor }]}>{formatCurrency(receipt.printed_total, receipt.currency)}</Text>
                  </View>
                  {(() => {
                    const costsTotal = receipt.globalCosts.reduce((s, c) => s + c.amount, 0);
                    const diff = Math.round((subtotal + costsTotal - receipt.printed_total) * 100) / 100;
                    const absDiff = Math.abs(diff);
                    const matched = absDiff <= 0.50;
                    return (
                      <View style={[styles.verifyStatusRow, { backgroundColor: matched ? "#10B98115" : "#EF444415", borderColor: matched ? "#10B981" : "#EF4444" }]}>
                        <Ionicons name={matched ? "checkmark-circle" : "alert-circle"} size={16} color={matched ? "#10B981" : "#EF4444"} />
                        <View style={{ flex: 1 }}>
                          {matched ? (
                            <Text style={[styles.verifyStatusText, { color: "#10B981" }]}>{t("review_verify_ok")}</Text>
                          ) : (
                            <>
                              <Text style={[styles.verifyStatusText, { color: "#EF4444" }]}>
                                {t("review_verify_diff")}: {diff > 0 ? "+" : ""}{formatCurrency(diff, receipt.currency)}
                              </Text>
                              <Text style={[styles.discrepancyLine, { color: "#EF4444" }]}>{t("review_verify_check")}</Text>
                            </>
                          )}
                        </View>
                      </View>
                    );
                  })()}
                </>
              ) : null}
            </ScrollView>
          </View>
        </View>
      </Modal>

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

const styles = StyleSheet.create({
  safe: { flex: 1 },

  // ── Header ───────────────────────────────────────────────────────────────────
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingHorizontal: 20,
    paddingVertical: 14,
    gap: 12,
  },
  headerCenter: {
    flex: 1,
    alignItems: "center",
    gap: 8,
  },
  restaurantInput: {
    fontSize: 17,
    fontWeight: "700",
    textAlign: "center",
    width: "100%",
    paddingVertical: 2,
  },
  currencyLabel: {
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.5,
  },

  // ── Scroll ───────────────────────────────────────────────────────────────────
  scroll: { flex: 1 },
  scrollContent: {},

  // ── Validation banner ────────────────────────────────────────────────────────
  validationBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  validationBannerText: {
    fontSize: 13,
    fontWeight: "500",
    flex: 1,
    lineHeight: 18,
  },
  discrepancyLine: {
    fontSize: 11,
    lineHeight: 16,
  },
  menuModalSub: {
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 12,
  },
  menuGroupPreview: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    gap: 4,
    marginBottom: 10,
  },
  menuGroupParent: {
    fontSize: 14,
    fontWeight: "700",
    marginBottom: 4,
  },
  menuGroupChild: {
    fontSize: 12,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  menuActions: {
    gap: 8,
    marginTop: 4,
  },
  menuActionBtn: {
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  menuActionText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "700",
  },

  // ── Raw OCR panel ────────────────────────────────────────────────────────────
  ocrPanel: {
    marginHorizontal: 16,
    marginBottom: 10,
    borderRadius: 10,
    borderWidth: 1,
    overflow: "hidden",
  },
  ocrPanelHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  ocrPanelTitle: {
    fontSize: 13,
    fontWeight: "600",
  },
  ocrPanelBody: {
    paddingHorizontal: 12,
    paddingBottom: 12,
    fontSize: 11,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    lineHeight: 16,
  },

  // ── Grouping banner ──────────────────────────────────────────────────────────
  groupingBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  groupingBannerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexShrink: 1,
  },
  groupingBannerText: {
    color: Colors.warning,
    fontSize: 13,
    fontWeight: "600",
    flexShrink: 1,
  },
  groupSelectedBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: Colors.warning,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  groupSelectedBtnText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "700",
  },

  // ── Receipt card ─────────────────────────────────────────────────────────────
  receiptCard: {
    marginHorizontal: 16,
    marginBottom: 12,
    overflow: "hidden",
  },
  emptyItemsState: {
    alignItems: "center",
    paddingVertical: 32,
    paddingHorizontal: 24,
    gap: 8,
  },
  emptyItemsTitle: {
    fontSize: 16,
    fontWeight: "700",
    marginTop: 4,
  },
  emptyItemsSub: {
    fontSize: 13,
    textAlign: "center",
    lineHeight: 18,
  },
  addItemBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginHorizontal: 16,
    marginVertical: 12,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1.5,
    borderStyle: "dashed",
  },
  addItemBtnText: {
    fontSize: 14,
    fontWeight: "600",
  },

  // ── Hint bar ─────────────────────────────────────────────────────────────────
  hintBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginHorizontal: 16,
    marginBottom: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
  },
  hintText: {
    fontSize: 12,
    flex: 1,
  },

  // ── Footer ───────────────────────────────────────────────────────────────────
  footer: {
    padding: 20,
    paddingBottom: 24,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  totalLabel: { fontSize: 16 },
  totalAmount: { fontSize: 24, fontWeight: "800" },
  totalAmountSm: { fontSize: 16, fontWeight: "600" },
  tipLineAmt: { fontSize: 16, fontWeight: "600" },
  footerDivider: { height: StyleSheet.hairlineWidth, marginVertical: 2 },
  confirmBtn: {
    backgroundColor: Colors.primary,
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "center",
    gap: 8,
  },
  confirmBtnDisabled: {
    opacity: 0.5,
  },
  confirmBtnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
  // ── Empty state ──────────────────────────────────────────────────────────────
  emptyContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyText: { fontSize: 16 },

  // ── Add Item Modal ───────────────────────────────────────────────────────────
  modalOverlay: {
    flex: 1,
    justifyContent: "flex-end",
  },
  modalCard: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 24,
    paddingBottom: 36,
    gap: 12,
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: "700",
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginBottom: -4,
  },
  fieldInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  categoryRow: {
    gap: 8,
    paddingVertical: 2,
  },
  categoryChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
  },
  categoryChipActive: {
    backgroundColor: Colors.primary + "18",
    borderColor: Colors.primary,
  },
  categoryChipText: {
    fontSize: 13,
    fontWeight: "600",
  },
  qtyPriceRow: {
    flexDirection: "row",
    gap: 12,
    alignItems: "flex-end",
  },
  qtyBlock: {
    gap: 6,
  },
  qtyControl: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  qtyBtn: {
    width: 36,
    height: 44,
    borderWidth: 1,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  qtyInput: {
    width: 48,
    height: 44,
    borderWidth: 1,
    borderRadius: 10,
    fontSize: 16,
    fontWeight: "600",
    textAlign: "center",
  },
  priceBlock: {
    flex: 1,
    gap: 6,
  },
  totalPreview: {
    fontSize: 13,
    fontStyle: "italic",
    textAlign: "right",
    marginTop: -4,
  },
  modalActions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 4,
  },
  modalCancelBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
    borderWidth: 1,
  },
  modalCancelText: {
    fontSize: 14,
    fontWeight: "600",
  },
  modalConfirmBtn: {
    flex: 2,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: Colors.primary,
  },
  modalConfirmText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "700",
  },
  editDeleteBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 12,
    marginTop: -4,
  },
  editDeleteText: {
    color: "#FF3B30",
    fontSize: 14,
    fontWeight: "600",
  },

  // ── Verify breakdown modal ───────────────────────────────────────────────────
  verifyRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  verifyItemName: { flex: 1, fontSize: 13, fontWeight: "500" },
  verifyItemCalc: { fontSize: 12, textAlign: "right" },
  verifyTotalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  verifyTotalLabel: { fontSize: 13, fontWeight: "600" },
  verifyTotalAmt: { fontSize: 14, fontWeight: "700" },
  verifyStatusRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    marginTop: 10,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
  },
  verifyStatusText: { fontSize: 13, fontWeight: "600" },

  // ── Original receipt photo preview ──────────────────────────────────────────
  photoCard: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    height: 160,
    marginHorizontal: 0,
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
