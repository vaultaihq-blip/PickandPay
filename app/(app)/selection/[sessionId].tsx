import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  useColorScheme,
  Alert,
  Modal,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "@/constants/colors";
import { useSessionStore } from "@/store/sessionStore";
import { useAuthStore } from "@/store/authStore";
import { useSessionMonitor } from "@/hooks/useSessionMonitor";
import { GlobalCostsSection } from "@/components/receipt/GlobalCosts";
import { SelectableItem } from "@/components/selection/SelectableItem";
import { SharedItemModal } from "@/components/selection/SharedItemModal";
import { Avatar } from "@/components/ui/Avatar";
import { Card } from "@/components/ui/Card";
import { formatCurrency } from "@/utils/formatter";
import { ReceiptItem, ItemSelection } from "@/types";
import { supabase } from "@/lib/supabase";

const ORDERED_CATEGORIES = [
  "starters",
  "mains",
  "drinks",
  "desserts",
  "others",
] as const;

// ── Smart item grouping ──────────────────────────────────────────────────────

type GroupedEntry =
  | { kind: "single"; item: ReceiptItem }
  | { kind: "merged"; item: ReceiptItem; originalIds: string[] }
  | { kind: "variant"; item: ReceiptItem; isLast: boolean };

function groupItemsByName(items: ReceiptItem[]): GroupedEntry[] {
  const byName = new Map<string, ReceiptItem[]>();
  for (const item of items) {
    const key = item.name.trim().toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key)!.push(item);
  }

  const processed = new Set<string>();
  const result: GroupedEntry[] = [];

  for (const item of items) {
    const key = item.name.trim().toLowerCase();
    if (processed.has(key)) continue;
    processed.add(key);

    const group = byName.get(key)!;
    if (group.length === 1) {
      result.push({ kind: "single", item });
      continue;
    }

    const allSamePrice = group.every((g) => g.unitPrice === group[0].unitPrice);
    if (allSamePrice) {
      const totalQty = group.reduce((s, g) => s + g.quantity, 0);
      const totalPrice = Math.round(group.reduce((s, g) => s + g.totalPrice, 0) * 100) / 100;
      const merged: ReceiptItem = { ...group[0], quantity: totalQty, totalPrice };
      result.push({ kind: "merged", item: merged, originalIds: group.map((g) => g.id) });
    } else {
      group.forEach((g, i) =>
        result.push({ kind: "variant", item: g, isLast: i === group.length - 1 })
      );
    }
  }

  return result;
}

const TIP_PERCENTAGES = [0, 5, 10, 15, 20] as const;

export default function SelectionScreen() {
  const { sessionId, userId, returnTo, takenBy } = useLocalSearchParams<{
    sessionId: string;
    userId: string;
    returnTo?: string;
    takenBy?: string;
  }>();
  const isDark = useColorScheme() === "dark";
  const { currentSession, updateSelections, countdownActive } = useSessionStore();
  const { profile } = useAuthStore();

  // ── Selections state ─────────────────────────────────────────────────────────
  const [selections, setSelections] = useState<Map<string, ItemSelection>>(() => {
    const existing =
      currentSession?.participants.find((p) => p.userId === userId)?.selections ?? [];
    return new Map(existing.map((s) => [s.itemId, s]));
  });

  // ── Individual tip state ─────────────────────────────────────────────────────
  const [tipContribution, setTipContribution] = useState<number>(() => {
    const p = currentSession?.participants.find((p) => p.userId === userId);
    return p?.tipContribution ?? 0;
  });
  const [tipInputMode, setTipInputMode] = useState<"choose" | "customPct" | "customAmt">("choose");
  const [customTipPct, setCustomTipPct] = useState("");
  const [customTipAmt, setCustomTipAmt] = useState("");

  const [sharedModalItem, setSharedModalItem] = useState<ReceiptItem | null>(null);
  const [saving, setSaving] = useState(false);

  // Force-navigate home if host closes the session while we're selecting
  useSessionMonitor();

  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  const textColor = isDark ? Colors.textPrimaryDark : Colors.textPrimaryLight;
  const mutedColor = isDark ? Colors.textMutedDark : Colors.textMutedLight;
  const bgColor = isDark ? Colors.bgDark : Colors.bgLight;
  const borderColor = isDark ? Colors.cardBorderDark : Colors.cardBorderLight;
  const cardColor = isDark ? Colors.cardDark : Colors.cardLight;

  const session = currentSession;
  const receipt = session?.receipt;
  const isIndividualTip = receipt?.tipMode === "individual";

  const activeParticipant =
    session?.participants.find((p) => p.userId === userId) ??
    session?.participants.find((p) => p.userId === profile?.id);

  const activeProfile = activeParticipant?.profile ?? profile;
  const accentColor = activeProfile?.color ?? Colors.primary;

  // ── Issue 1: Sync selections when userId changes (e.g. host switches users) ──
  useEffect(() => {
    if (!currentSession) return;
    const existing =
      currentSession.participants.find((p) => p.userId === userId)?.selections ?? [];
    setSelections(new Map(existing.map((s) => [s.itemId, s])));
    const tipAmt =
      currentSession.participants.find((p) => p.userId === userId)?.tipContribution ?? 0;
    setTipContribution(tipAmt);
    setTipInputMode("choose");
  }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Supabase broadcast channel — send only (selection_complete broadcasts) ─
  useEffect(() => {
    const sid = sessionId ?? session?.id;
    if (!sid || String(sid).startsWith("session_") || String(sid).startsWith("dev_session_")) return;
    const channelName = returnTo === "lobby" ? `lobby:${sid}` : `selection:${sid}`;
    const ch = supabase.channel(channelName).subscribe();
    channelRef.current = ch;
    return () => { supabase.removeChannel(ch); };
  }, [sessionId, session?.id, returnTo]);

  // ── Countdown started by host (via store) — pop back to lobby ───────────
  useEffect(() => {
    if (countdownActive && returnTo === "lobby") {
      router.back(); // reveals lobby (still mounted in stack) where countdown card is shown
    }
  }, [countdownActive]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── IDs claimed by other Done participants (selections saved to store) ────────
  const otherDoneSelectionIds = useMemo(() => {
    const ids = new Set<string>();
    if (!session) return ids;
    for (const p of session.participants) {
      if (p.userId === userId) continue;
      for (const s of p.selections) ids.add(s.itemId);
    }
    return ids;
  }, [session, userId]);

  // ── All items flat list (shared across memos) ────────────────────────────────
  const allItems = useMemo<ReceiptItem[]>(() => {
    if (!receipt) return [];
    return [
      ...receipt.categories.starters,
      ...receipt.categories.mains,
      ...receipt.categories.drinks,
      ...receipt.categories.desserts,
      ...receipt.categories.others,
    ];
  }, [receipt]);

  // ── Items not claimed by any participant (combines local + persisted) ─────────
  const unassignedItems = useMemo<ReceiptItem[]>(() => {
    if (!session || !receipt) return [];
    const assignedIds = new Set<string>();
    for (const id of selections.keys()) assignedIds.add(id);
    for (const p of session.participants) {
      if (p.userId === userId) continue;
      for (const s of p.selections) assignedIds.add(s.itemId);
    }
    return allItems.filter((item) => !assignedIds.has(item.id));
  }, [allItems, session, receipt, selections, userId]);

  // ── This person's items-only subtotal (used for tip % calculation) ───────────
  const personalItemsSubtotal = useMemo(() => {
    if (!receipt) return 0;
    let total = 0;
    for (const [itemId, sel] of selections) {
      const item = allItems.find((i) => i.id === itemId);
      if (!item) continue;
      if (
        item.type === "individual" ||
        item.type === "combo" ||
        item.type === "group"
      ) {
        total += item.totalPrice;
        if (item.addOns) for (const addon of item.addOns) total += addon.totalPrice;
      } else if (item.type === "quantity") {
        const othersCount =
          session?.participants.filter(
            (p) => p.userId !== userId && p.selections.some((s) => s.itemId === itemId)
          ).length ?? 0;
        const shareCount = Math.max(othersCount + 1, 1);
        total += item.totalPrice / shareCount;
        if (item.addOns)
          for (const addon of item.addOns) total += addon.totalPrice / shareCount;
      } else if (item.type === "shareable") {
        const shareCount = Math.max(sel.sharedWith?.length ?? 1, 1);
        total += item.totalPrice / shareCount;
      }
    }
    return Math.round(total * 100) / 100;
  }, [selections, allItems, receipt, session, userId]);

  // ── Running total (items + global costs share + tip) ─────────────────────────
  const runningTotal = useMemo(() => {
    let total = personalItemsSubtotal;

    if (session && receipt && receipt.globalCosts.length > 0) {
      const n = session.participants.length;
      if (n > 0) {
        for (const cost of receipt.globalCosts) total += cost.amount / n;
      }
    }

    if (receipt && isIndividualTip) {
      total += tipContribution;
    } else if (receipt?.tipPercentage && receipt.tipPercentage > 0) {
      // Percentage tip: each person pays their own percentage of their items
      total += Math.round(personalItemsSubtotal * (receipt.tipPercentage / 100) * 100) / 100;
    } else if (session && receipt?.selectedTip && receipt.selectedTip > 0) {
      // Flat custom tip: divided equally among all participants
      const n = session.participants.length;
      if (n > 0) total += receipt.selectedTip / n;
    }

    return Math.round(total * 100) / 100;
  }, [personalItemsSubtotal, receipt, session, isIndividualTip, tipContribution]);

  // ── Save selections to store (without Supabase) ──────────────────────────────
  const saveToStore = useCallback(() => {
    if (!session || !activeParticipant) return;
    const selectionArray = Array.from(selections.values());
    const tipContrib = isIndividualTip ? tipContribution : undefined;
    updateSelections(activeParticipant.userId, selectionArray, tipContrib);
  }, [session, activeParticipant, selections, isIndividualTip, tipContribution, updateSelections]);

  // ── Quantity change for individual items ────────────────────────────────────
  const handleQuantityChange = useCallback((itemId: string, delta: number) => {
    setSelections((prev) => {
      const next = new Map(prev);
      const current = next.get(itemId);
      if (!current) return next;
      const item = allItems.find((i) => i.id === itemId);
      if (!item) return next;
      const othersAllocated = session?.participants
        .filter((p) => p.userId !== userId)
        .reduce((sum, p) => {
          const sel = p.selections.find((s) => s.itemId === itemId);
          return sum + (sel ? (sel.quantity ?? 1) : 0);
        }, 0) ?? 0;
      const maxQty = item.quantity - othersAllocated;
      const newQty = Math.max(1, Math.min(maxQty, (current.quantity ?? 1) + delta));
      next.set(itemId, { ...current, quantity: newQty });
      return next;
    });
  }, [allItems, userId, session]);

  // ── Done: save + broadcast finalization ─────────────────────────────────────
  const handleDone = async () => {
    if (!session || !activeParticipant) return;
    setSaving(true);
    try {
      const selectionArray = Array.from(selections.values());
      const tipContrib = isIndividualTip ? tipContribution : undefined;
      updateSelections(activeParticipant.userId, selectionArray, tipContrib);

      const isTestUser = activeParticipant.userId.startsWith("test_") || activeParticipant.userId.startsWith("dev_");
      const isOfflineSession = session.id.startsWith("session_") || session.id.startsWith("dev_session_");
      if (!isOfflineSession && !isTestUser) {
        await supabase
          .from("session_participants")
          .update({ selections: selectionArray, total_owed: runningTotal })
          .eq("session_id", session.id)
          .eq("user_id", activeParticipant.userId);
      }

      if (returnTo === "lobby") {
        // Lobby flow: broadcast selection_complete and return to lobby
        if (!isOfflineSession && channelRef.current) {
          channelRef.current.send({
            type: "broadcast",
            event: "selection_complete",
            payload: { userId: activeParticipant.userId, selections: selectionArray },
          });
        }
        router.replace(`/(app)/session-lobby/${session.id}`);
        return;
      }

      // Standalone session: broadcast finalized and handle overlay/back
      if (!isOfflineSession && channelRef.current) {
        channelRef.current.send({
          type: "broadcast",
          event: "finalized",
          payload: { userId: activeParticipant.userId },
        });
      }

      // Host selecting for someone else → go back; selecting for self → stay (allReady shows overlay)
      const isTakeover = userId && userId !== profile?.id;
      if (isTakeover) {
        router.back();
      }
    } catch (err) {
      Alert.alert("Error", "Failed to save selections.");
    } finally {
      setSaving(false);
    }
  };

  // ── Back press — behaves exactly like Done ───────────────────────────────────
  const handleBack = () => {
    Alert.alert(
      "Confirm Selection",
      "Are you done selecting your items?",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Confirm", onPress: handleDone },
      ]
    );
  };

  const handleToggleItem = useCallback(
    (item: ReceiptItem) => {
      setSelections((prev) => {
        const next = new Map(prev);
        if (next.has(item.id)) {
          next.delete(item.id);
        } else {
          next.set(item.id, {
            itemId: item.id,
            quantity: 1,
            isShared: item.type === "shareable",
            sharedWith: item.type === "shareable" ? [activeProfile?.id ?? ""] : [],
          });
        }
        return next;
      });
    },
    [activeProfile?.id]
  );

  const handleToggleMerged = useCallback((originalIds: string[]) => {
    setSelections((prev) => {
      const next = new Map(prev);
      const myClaimedFromGroup = originalIds.filter((id) => next.has(id));
      if (myClaimedFromGroup.length > 0) {
        // Deselect all mine from this group
        for (const id of myClaimedFromGroup) next.delete(id);
      } else {
        // Claim the first unclaimed id (not taken by other participants)
        const sess = useSessionStore.getState().currentSession;
        const claimedByOthers = new Set<string>();
        if (sess) {
          for (const p of sess.participants) {
            if (p.userId === userId) continue;
            for (const s of p.selections) claimedByOthers.add(s.itemId);
          }
        }
        const firstUnclaimed = originalIds.find((id) => !claimedByOthers.has(id));
        if (firstUnclaimed) {
          next.set(firstUnclaimed, { itemId: firstUnclaimed, quantity: 1, isShared: false, sharedWith: [] });
        }
      }
      return next;
    });
  }, [userId]);

  const groupedCategories = useMemo(() => {
    if (!receipt) return {} as Record<string, GroupedEntry[]>;
    return Object.fromEntries(
      ORDERED_CATEGORIES.map((cat) => [cat, groupItemsByName(receipt.categories[cat])])
    ) as Record<typeof ORDERED_CATEGORIES[number], GroupedEntry[]>;
  }, [receipt]);

  const handleShareConfirm = useCallback(
    (sharedWith: string[]) => {
      if (!sharedModalItem) return;
      setSelections((prev) => {
        const next = new Map(prev);
        next.set(sharedModalItem.id, {
          itemId: sharedModalItem.id,
          quantity: 1,
          isShared: true,
          sharedWith,
        });
        return next;
      });
      setSharedModalItem(null);
    },
    [sharedModalItem]
  );

  // ── Individual tip helpers ───────────────────────────────────────────────────
  const applyTipPct = (pct: number) => {
    const amt = pct === 0 ? 0 : Math.round(personalItemsSubtotal * (pct / 100) * 100) / 100;
    setTipContribution(amt);
  };

  const applyCustomPct = () => {
    const pct = parseFloat(customTipPct);
    if (!isNaN(pct) && pct >= 0) {
      setTipContribution(Math.round(personalItemsSubtotal * (pct / 100) * 100) / 100);
      setTipInputMode("choose");
      setCustomTipPct("");
    }
  };

  const applyCustomAmt = () => {
    const amt = parseFloat(customTipAmt);
    if (!isNaN(amt) && amt >= 0) {
      setTipContribution(Math.round(amt * 100) / 100);
      setTipInputMode("choose");
      setCustomTipAmt("");
    }
  };

  const currencySymbol =
    receipt?.currency === "EUR"
      ? "€"
      : receipt?.currency === "GBP"
      ? "£"
      : receipt?.currency === "CAD"
      ? "C$"
      : "$";

  if (!session || !receipt || !activeParticipant) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: bgColor }]}>
        <View style={styles.emptyContainer}>
          <Text style={[styles.emptyText, { color: mutedColor }]}>Session not found.</Text>
        </View>
      </SafeAreaView>
    );
  }

  const selectedIds = new Set(selections.keys());
  const curr = receipt.currency as "EUR" | "USD" | "CAD" | "GBP";

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: bgColor }]}>
      {/* Header */}
      <View style={styles.header}>
        {/* Issue 1: back saves first */}
        <TouchableOpacity onPress={handleBack}>
          <Ionicons name="arrow-back" size={24} color={textColor} />
        </TouchableOpacity>
        <View style={styles.personInfo}>
          <Avatar
            name={activeProfile?.name ?? "?"}
            avatarIcon={activeProfile?.avatarIcon}
            avatarUrl={activeProfile?.avatarUrl}
            color={accentColor}
            size={34}
          />
          <View>
            <Text style={[styles.selectingFor, { color: mutedColor }]}>
              Selecting for:
            </Text>
            <Text style={[styles.personName, { color: textColor }]}>
              {activeProfile?.name ?? "Unknown"}
            </Text>
          </View>
        </View>
        <View style={{ width: 60 }} />
      </View>

      {/* Takeover banner */}
      {takenBy && (
        <View style={styles.takeoverBanner}>
          <Text style={styles.takeoverBannerText}>
            🤝 Selecting on behalf of {activeProfile?.name ?? "this user"}
          </Text>
        </View>
      )}

      {/* Item list */}
      <ScrollView
        style={styles.scroll}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingBottom: isIndividualTip
            ? 210
            : (receipt.selectedTip ?? 0) > 0
            ? 180
            : 110,
        }}
      >
        <Card style={styles.receiptCard} padding={0}>
          {ORDERED_CATEGORIES.map((cat) => {
            const groups = groupedCategories[cat] ?? [];
            if (groups.length === 0) return null;
            return (
              <View key={cat}>
                <View style={[styles.catHeader, { borderColor }]}>
                  <Text style={[styles.catLabel, { color: mutedColor }]}>
                    {cat.toUpperCase()}
                  </Text>
                </View>
                {groups.map((entry) => {
                  if (entry.kind === "merged") {
                    const { item, originalIds } = entry;
                    const myClaimedFromGroup = originalIds.filter((id) => selectedIds.has(id));
                    const claimedByOthers = originalIds.filter((id) => otherDoneSelectionIds.has(id)).length;
                    const totalQty = originalIds.length;
                    const availableQty = totalQty - claimedByOthers;
                    return (
                      <SelectableItem
                        key={`merged_${item.id}`}
                        item={item}
                        currency={receipt.currency}
                        selected={myClaimedFromGroup.length > 0}
                        selectionColor={accentColor}
                        sharedWith={[]}
                        availableQty={availableQty}
                        totalQty={totalQty}
                        onToggle={() => handleToggleMerged(originalIds)}
                        onShareTap={() => {}}
                      />
                    );
                  }
                  if (entry.kind === "variant") {
                    const othersAllocatedVariant = session?.participants
                      .filter((p) => p.userId !== userId)
                      .reduce((sum, p) => {
                        const sel = p.selections.find((s) => s.itemId === entry.item.id);
                        return sum + (sel ? (sel.quantity ?? 1) : 0);
                      }, 0) ?? 0;
                    return (
                      <React.Fragment key={entry.item.id}>
                        <SelectableItem
                          item={entry.item}
                          currency={receipt.currency}
                          selected={selectedIds.has(entry.item.id)}
                          selectionColor={accentColor}
                          sharedWith={selections.get(entry.item.id)?.sharedWith ?? []}
                          hasPriceVariant
                          quantitySelected={selections.get(entry.item.id)?.quantity ?? 1}
                          totalAllocatedByOthers={othersAllocatedVariant}
                          onToggle={() => handleToggleItem(entry.item)}
                          onShareTap={() => setSharedModalItem(entry.item)}
                          onQuantityChange={(delta) => handleQuantityChange(entry.item.id, delta)}
                        />
                        {entry.isLast && (
                          <View style={styles.variantInfoRow}>
                            <Ionicons name="information-circle-outline" size={14} color={Colors.warning} />
                            <Text style={styles.variantInfoText}>
                              Note: these items have different prices
                            </Text>
                          </View>
                        )}
                      </React.Fragment>
                    );
                  }
                  const othersAllocatedSingle = session?.participants
                    .filter((p) => p.userId !== userId)
                    .reduce((sum, p) => {
                      const sel = p.selections.find((s) => s.itemId === entry.item.id);
                      return sum + (sel ? (sel.quantity ?? 1) : 0);
                    }, 0) ?? 0;
                  return (
                    <SelectableItem
                      key={entry.item.id}
                      item={entry.item}
                      currency={receipt.currency}
                      selected={selectedIds.has(entry.item.id)}
                      selectionColor={accentColor}
                      sharedWith={selections.get(entry.item.id)?.sharedWith ?? []}
                      quantitySelected={selections.get(entry.item.id)?.quantity ?? 1}
                      totalAllocatedByOthers={othersAllocatedSingle}
                      onToggle={() => handleToggleItem(entry.item)}
                      onShareTap={() => setSharedModalItem(entry.item)}
                      onQuantityChange={(delta) => handleQuantityChange(entry.item.id, delta)}
                    />
                  );
                })}
              </View>
            );
          })}
          <GlobalCostsSection
            costs={receipt.globalCosts}
            currency={receipt.currency}
            tipAmount={isIndividualTip ? undefined : receipt.selectedTip}
          />
        </Card>
      </ScrollView>

      {/* ── Equal tip breakdown info card ── */}
      {!isIndividualTip && (receipt.selectedTip ?? 0) > 0 && session.participants.length > 0 && (
        <View style={[styles.tipInfoCard, { backgroundColor: cardColor, borderColor }]}>
          {receipt.tipPercentage && receipt.tipPercentage > 0 ? (
            // Percentage tip: each person pays their own % of their items
            <>
              <View style={styles.tipInfoRow}>
                <Text style={[styles.tipInfoLabel, { color: mutedColor }]}>Tip rate</Text>
                <Text style={[styles.tipInfoValue, { color: textColor }]}>
                  {receipt.tipPercentage}% of your items
                </Text>
              </View>
              <View style={[styles.tipInfoRowTotal, { borderColor }]}>
                <Text style={[styles.tipInfoLabel, { color: textColor, fontWeight: "700" }]}>
                  Your tip
                </Text>
                <Text style={[styles.tipInfoValueBold, { color: accentColor }]}>
                  {formatCurrency(
                    Math.round(personalItemsSubtotal * (receipt.tipPercentage / 100) * 100) / 100,
                    curr
                  )}
                </Text>
              </View>
            </>
          ) : (
            // Flat custom amount: divided equally
            <>
              <View style={styles.tipInfoRow}>
                <Text style={[styles.tipInfoLabel, { color: mutedColor }]}>Total tip</Text>
                <Text style={[styles.tipInfoValue, { color: textColor }]}>
                  {formatCurrency(receipt.selectedTip!, curr)}
                </Text>
              </View>
              <Text style={[styles.tipInfoDivide, { color: mutedColor }]}>
                ÷ {session.participants.length} people
              </Text>
              <View style={[styles.tipInfoRowTotal, { borderColor }]}>
                <Text style={[styles.tipInfoLabel, { color: textColor, fontWeight: "700" }]}>
                  = per person
                </Text>
                <Text style={[styles.tipInfoValueBold, { color: accentColor }]}>
                  {formatCurrency(
                    Math.round((receipt.selectedTip! / session.participants.length) * 100) / 100,
                    curr
                  )}
                </Text>
              </View>
            </>
          )}
        </View>
      )}

      {/* ── Issue 3: Individual tip selector panel ── */}
      {isIndividualTip && (
        <View style={[styles.tipPanel, { backgroundColor: bgColor, borderColor }]}>
          <View style={styles.tipPanelHeader}>
            <Text style={[styles.tipPanelTitle, { color: mutedColor }]}>Your tip</Text>
            <Text style={[styles.tipPanelAmount, { color: tipContribution > 0 ? accentColor : mutedColor }]}>
              Tip: {formatCurrency(tipContribution, curr)}
            </Text>
          </View>

          {tipInputMode === "choose" && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.tipChipRow}
            >
              {TIP_PERCENTAGES.map((pct) => {
                const amt =
                  pct === 0
                    ? 0
                    : Math.round(personalItemsSubtotal * (pct / 100) * 100) / 100;
                const isSelected =
                  pct === 0 ? tipContribution === 0 : tipContribution === amt;
                return (
                  <TouchableOpacity
                    key={pct}
                    style={[
                      styles.tipChip,
                      { borderColor: isSelected ? accentColor : borderColor },
                      isSelected && { backgroundColor: accentColor + "22" },
                    ]}
                    onPress={() => applyTipPct(pct)}
                  >
                    <Text
                      style={[
                        styles.tipChipText,
                        { color: isSelected ? accentColor : mutedColor },
                      ]}
                    >
                      {pct === 0 ? "No tip" : `${pct}%`}
                    </Text>
                  </TouchableOpacity>
                );
              })}
              <TouchableOpacity
                style={[styles.tipChip, { borderColor }]}
                onPress={() => setTipInputMode("customPct")}
              >
                <Text style={[styles.tipChipText, { color: mutedColor }]}>Custom %</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.tipChip, { borderColor }]}
                onPress={() => setTipInputMode("customAmt")}
              >
                <Text style={[styles.tipChipText, { color: mutedColor }]}>
                  Custom {currencySymbol}
                </Text>
              </TouchableOpacity>
            </ScrollView>
          )}

          {tipInputMode === "customPct" && (
            <View style={styles.tipCustomRow}>
              <TextInput
                style={[styles.tipCustomInput, { color: textColor, borderColor }]}
                value={customTipPct}
                onChangeText={setCustomTipPct}
                placeholder="18"
                placeholderTextColor={mutedColor}
                keyboardType="decimal-pad"
                autoFocus
              />
              <Text style={[styles.tipCustomLabel, { color: mutedColor }]}>%</Text>
              <TouchableOpacity
                style={[styles.tipCustomApply, { backgroundColor: accentColor }]}
                onPress={applyCustomPct}
              >
                <Text style={styles.tipCustomApplyText}>Apply</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setTipInputMode("choose")}>
                <Text style={[styles.tipCustomCancel, { color: mutedColor }]}>Cancel</Text>
              </TouchableOpacity>
            </View>
          )}

          {tipInputMode === "customAmt" && (
            <View style={styles.tipCustomRow}>
              <Text style={[styles.tipCustomLabel, { color: mutedColor }]}>
                {currencySymbol}
              </Text>
              <TextInput
                style={[styles.tipCustomInput, { color: textColor, borderColor }]}
                value={customTipAmt}
                onChangeText={setCustomTipAmt}
                placeholder="0.00"
                placeholderTextColor={mutedColor}
                keyboardType="decimal-pad"
                autoFocus
              />
              <TouchableOpacity
                style={[styles.tipCustomApply, { backgroundColor: accentColor }]}
                onPress={applyCustomAmt}
              >
                <Text style={styles.tipCustomApplyText}>Apply</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setTipInputMode("choose")}>
                <Text style={[styles.tipCustomCancel, { color: mutedColor }]}>Cancel</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      )}

      {/* Running total bar */}
      <View style={[styles.totalBar, { backgroundColor: bgColor, borderColor }]}>
        <View style={styles.totalInfo}>
          <Text style={[styles.totalLabel, { color: mutedColor }]}>Items selected</Text>
          <Text style={[styles.totalAmount, { color: accentColor }]}>
            {selections.size} item{selections.size !== 1 ? "s" : ""}
          </Text>
        </View>
        <TouchableOpacity
          style={[
            styles.doneBarBtn,
            { backgroundColor: accentColor },
            saving && { opacity: 0.6 },
          ]}
          onPress={handleDone}
          disabled={saving}
        >
          <Text style={styles.doneBarBtnText}>{saving ? "..." : "Done →"}</Text>
        </TouchableOpacity>
      </View>

      <SharedItemModal
        visible={!!sharedModalItem}
        item={sharedModalItem}
        participants={session.participants}
        currentUserId={activeParticipant.userId}
        initialSharedWith={
          sharedModalItem ? (selections.get(sharedModalItem.id)?.sharedWith ?? []) : []
        }
        currency={receipt.currency}
        onConfirm={handleShareConfirm}
        onClose={() => setSharedModalItem(null)}
      />

    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 12,
    minHeight: 64,
  },
  personInfo: { flexDirection: "row", alignItems: "center", gap: 10 },
  selectingFor: { fontSize: 11, fontWeight: "500" },
  personName: { fontSize: 15, fontWeight: "700" },
  doneBtn: {
    backgroundColor: Colors.primary,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    minHeight: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  doneBtnText: { color: "#fff", fontWeight: "700", fontSize: 14 },
  scroll: { flex: 1 },
  receiptCard: { marginHorizontal: 16, marginVertical: 8, overflow: "hidden" },
  catHeader: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  catLabel: { fontSize: 11, fontWeight: "600", letterSpacing: 0.5 },
  variantInfoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: "#F59E0B18",
  },
  variantInfoText: {
    fontSize: 12,
    color: Colors.warning,
    fontWeight: "500",
    flex: 1,
  },

  // ── Individual tip panel ─────────────────────────────────────────────────────
  tipPanel: {
    position: "absolute",
    bottom: 95,
    left: 0,
    right: 0,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  tipPanelHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  tipPanelTitle: { fontSize: 12, fontWeight: "600", letterSpacing: 0.4 },
  tipPanelAmount: { fontSize: 13, fontWeight: "700" },
  tipChipRow: { gap: 6, flexDirection: "row" },
  tipChip: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  tipChipText: { fontSize: 12, fontWeight: "500" },
  tipCustomRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  tipCustomInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 15,
    width: 72,
    textAlign: "center",
  },
  tipCustomLabel: { fontSize: 15, fontWeight: "600" },
  tipCustomApply: {
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  tipCustomApplyText: { color: "#fff", fontWeight: "600", fontSize: 13 },
  tipCustomCancel: { fontSize: 13 },

  // ── Running total bar ────────────────────────────────────────────────────────
  totalBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 14,
    paddingBottom: 28,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  totalInfo: { flex: 1, gap: 2 },
  totalLabel: { fontSize: 12 },
  totalAmount: { fontSize: 24, fontWeight: "800" },
  doneBarBtn: {
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 12,
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  doneBarBtnText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  emptyContainer: { flex: 1, alignItems: "center", justifyContent: "center" },
  emptyText: { fontSize: 16 },

  // ── Equal tip info card ───────────────────────────────────────────────────────
  tipInfoCard: {
    position: "absolute",
    bottom: 95,
    left: 16,
    right: 16,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 8,
    gap: 3,
  },
  tipInfoRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  tipInfoLabel: {
    fontSize: 12,
  },
  tipInfoValue: {
    fontSize: 12,
    fontWeight: "500",
  },
  tipInfoDivide: {
    fontSize: 11,
    fontWeight: "500",
  },
  tipInfoRowTotal: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 4,
    marginTop: 2,
  },
  tipInfoValueBold: {
    fontSize: 14,
    fontWeight: "700",
  },

  // ── Takeover banner ───────────────────────────────────────────────────────────
  takeoverBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 8,
    paddingHorizontal: 16,
    backgroundColor: Colors.primary + "18",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.primary + "44",
  },
  takeoverBannerText: {
    fontSize: 13,
    fontWeight: "600",
    color: Colors.primary,
    textAlign: "center",
  },

  // ── Unassigned banner ────────────────────────────────────────────────────────
  unassignedBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 4,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: "#FF950018",
    borderWidth: 1,
    borderColor: "#FF950055",
    borderRadius: 10,
  },
  unassignedBannerText: {
    flex: 1,
    fontSize: 13,
    fontWeight: "500",
    color: "#FF9500",
  },
  unassignedBannerLink: {
    fontSize: 13,
    fontWeight: "700",
    color: "#FF9500",
  },

  // ── Unassigned modal sheet ────────────────────────────────────────────────────
  modalBackdrop: {
    flex: 1,
    backgroundColor: "#00000055",
  },
  unassignedSheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 10,
    paddingBottom: 40,
    maxHeight: "60%",
  },
  unassignedSheetHandle: {
    width: 38,
    height: 4,
    borderRadius: 2,
    alignSelf: "center",
    marginBottom: 14,
  },
  unassignedSheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    marginBottom: 4,
  },
  unassignedSheetTitle: {
    fontSize: 17,
    fontWeight: "700",
  },
  unassignedSheetSubtitle: {
    fontSize: 13,
    paddingHorizontal: 20,
    marginBottom: 12,
  },
  unassignedList: {
    paddingHorizontal: 20,
  },
  unassignedRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  unassignedRowInfo: { flex: 1, gap: 2 },
  unassignedItemName: { fontSize: 14, fontWeight: "600" },
  unassignedItemCat: { fontSize: 12 },
  unassignedItemPrice: { fontSize: 14, fontWeight: "700" },

  // ── Status overlay ────────────────────────────────────────────────────────────
  statusOverlay: {
    position: "absolute",
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: "rgba(0,0,0,0.72)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  statusCard: {
    borderRadius: 20,
    padding: 24,
    width: "100%",
    maxHeight: "80%",
    gap: 14,
  },
  statusTitle: {
    fontSize: 20,
    fontWeight: "800",
    textAlign: "center",
  },
  statusSubtitle: {
    fontSize: 14,
    textAlign: "center",
    marginTop: -6,
  },
  statusList: {
    maxHeight: 240,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  statusName: {
    flex: 1,
    fontSize: 15,
    fontWeight: "600",
  },
  statusBadge: {
    alignItems: "flex-end",
  },
  statusReady: {
    fontSize: 13,
    fontWeight: "700",
    color: "#22C55E",
  },
  statusWaiting: {
    fontSize: 13,
    fontWeight: "500",
  },
  statusActions: {
    gap: 10,
    marginTop: 4,
  },
  statusBackBtn: {
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  statusBackBtnText: {
    fontSize: 15,
    fontWeight: "600",
  },
  statusFinalizeBtn: {
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    backgroundColor: Colors.primary,
  },
  statusFinalizeBtnText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "700",
  },
});
