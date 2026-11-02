import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  useColorScheme,
  Modal,
  BackHandler,
} from "react-native";
import { showDialog } from "@/lib/dialog";
import { endSession, showEndSessionError } from "@/lib/endSession";
import { leaveSession } from "@/lib/leaveSession";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useLocalSearchParams, Stack } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "@/constants/colors";
import { useSessionStore } from "@/store/sessionStore";
import { useAuthStore } from "@/store/authStore";
import { useReceiptStore } from "@/store/receiptStore";
import { useSessionMonitor } from "@/hooks/useSessionMonitor";
import { GlobalCostsSection } from "@/components/receipt/GlobalCosts";
import { SelectableItem, SelectorInfo } from "@/components/selection/SelectableItem";
import { SharedItemModal } from "@/components/selection/SharedItemModal";
import { Avatar } from "@/components/ui/Avatar";
import { Card } from "@/components/ui/Card";
import { formatCurrency } from "@/utils/formatter";
import { ReceiptItem, ItemSelection } from "@/types";
import { supabase } from "@/lib/supabase";
import { expectRows, showLeaveWriteError, showWriteError, withTimeout, WriteError } from "@/lib/checkedWrite";
import { useI18nStore } from "@/store/i18nStore";
import { groupItems, groupState, ItemGroup, selectionAmount, sessionInitials } from "@/lib/units";
import { manageShareRequest, pickUnits, requestShare, shareUnit, showUnitsError, UnitHolder } from "@/lib/shareUnits";
import { PersonDots, DotPerson } from "@/components/selection/PersonDot";
import { ShareWithModal } from "@/components/selection/ShareWithModal";
import { ShareRequestsModals } from "@/components/session/ShareRequestsPanel";
import { useShareRequestsStore } from "@/store/shareRequestsStore";

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
  const insets = useSafeAreaInsets();
  const { currentSession, updateSelections, countdownActive, clearSession } = useSessionStore();
  const { clearReceipt } = useReceiptStore();
  const { profile } = useAuthStore();
  const { t, language } = useI18nStore();
  void language;

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
  // Prevent re-firing the "selecting" status update when the store changes mid-session
  const hasSetSelectingRef = useRef(false);
  // Stop draft broadcasts the moment Done is pressed (before router.back() finishes)
  const doneRef = useRef(false);
  // Last "[selection] blocked" line printed — see the not-found branch below.
  const lastBlockedLogRef = useRef<string | null>(null);

  const textColor = isDark ? Colors.textPrimaryDark : Colors.textPrimaryLight;
  const mutedColor = isDark ? Colors.textMutedDark : Colors.textMutedLight;
  const bgColor = isDark ? Colors.bgDark : Colors.bgLight;
  const borderColor = isDark ? Colors.cardBorderDark : Colors.cardBorderLight;
  const cardColor = isDark ? Colors.cardDark : Colors.cardLight;

  const session = currentSession;
  const receipt = session?.receipt;
  const isIndividualTip = receipt?.tipMode === "individual";
  const isCreator = session?.creatorId === profile?.id;

  const activeParticipant =
    session?.participants.find((p) => p.userId === userId) ??
    session?.participants.find((p) => p.userId === profile?.id);

  const activeProfile = activeParticipant?.profile ?? profile;
  const accentColor = activeProfile?.color ?? Colors.primary;

  // R12 — picking for myself in an online session from the lobby: every tap
  // asks the server for units (pick_units) and the others see it live. The
  // host picking for someone else and offline sessions keep the local path.
  const live =
    !!session && !!profile?.id && returnTo === "lobby" &&
    !session.id.startsWith("session_") && !session.id.startsWith("dev_session_") &&
    activeParticipant?.userId === profile.id;
  const myId = profile?.id;
  const shareRequests = useShareRequestsStore((s) => s.requests);
  const [busyGroup, setBusyGroup] = useState<string | null>(null);
  const [shareGroup, setShareGroup] = useState<ItemGroup | null>(null);
  const [shareBusy, setShareBusy] = useState(false);
  const storeMine = live ? session?.participants.find((p) => p.userId === myId)?.selections : undefined;

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

  // R12 — the server's view of my picks wins: a share accepted, a unit
  // released by someone I shared with, a pick answered by pick_units.
  useEffect(() => {
    if (live && storeMine) setSelections(new Map(storeMine.map((s) => [s.itemId, s])));
  }, [live, storeMine]);

  // R12 — the screen always opens with what the server has (my units, the
  // others' circles, "N de M livre"), not with what this phone remembered:
  // coming back from the lobby, after a rejoin, after a cancel was accepted.
  const liveSessionId = live ? session?.id : undefined;
  useEffect(() => {
    if (!liveSessionId) return;
    let alive = true;
    supabase
      .from("session_participants")
      .select("user_id, selections")
      .eq("session_id", liveSessionId)
      .then(({ data, error }) => {
        if (!alive) return;
        if (error) {
          console.log(`[selection] read picks failed: ${error.code ?? "?"}: ${error.message}`);
          return;
        }
        const store = useSessionStore.getState();
        let mine = 0;
        for (const row of data ?? []) {
          const sels = Array.isArray(row.selections) ? (row.selections as ItemSelection[]) : [];
          if (row.user_id === profile?.id) mine = sels.length;
          if (store.currentSession?.participants.some((p) => p.userId === row.user_id)) {
            store.updateSelections(row.user_id as string, sels);
          }
        }
        console.log(`[selection] picks from the server: ${data?.length ?? 0} people, ${mine} line(s) mine`);
      });
    return () => {
      alive = false;
    };
  }, [liveSessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Supabase broadcast channel — send only (selection_complete broadcasts) ─
  useEffect(() => {
    const sid = sessionId ?? session?.id;
    if (!sid || String(sid).startsWith("session_") || String(sid).startsWith("dev_session_")) return;
    const channelName = returnTo === "lobby" ? `lobby:${sid}` : `selection:${sid}`;
    // FIX 49 — supabase.channel() returns the *existing* channel object when
    // one with this topic is already open. Coming from the lobby, that's the
    // lobby's own presence/broadcast channel (it stays mounted underneath),
    // and removing it here on unmount left the lobby deaf: no broadcasts and
    // no way to re-track presence, so the user showed as disconnected to
    // everyone. This screen is a guest on a channel it didn't open — borrow
    // it for sends, never close it. Only a channel created here is removed.
    const existing = supabase.getChannels().find((c) => c.topic === `realtime:${channelName}`);
    if (existing) {
      channelRef.current = existing;
      return () => {
        channelRef.current = null;
      };
    }
    // C.2 — session channels are private (realtime.messages RLS: host or member).
    const ch = supabase.channel(channelName, { config: { private: true } }).subscribe();
    channelRef.current = ch;
    return () => {
      channelRef.current = null;
      supabase.removeChannel(ch);
    };
  }, [sessionId, session?.id, returnTo]);

  // ── Countdown started by host (via store) — pop back to lobby ───────────
  useEffect(() => {
    if (countdownActive && returnTo === "lobby") {
      router.back(); // reveals lobby (still mounted in stack) where countdown card is shown
    }
  }, [countdownActive]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (hasSetSelectingRef.current) return;
    const sid = sessionId ?? session?.id;
    if (
      returnTo !== "lobby" ||
      !sid ||
      !activeParticipant ||
      String(sid).startsWith("session_") ||
      String(sid).startsWith("dev_session_")
    ) {
      return;
    }
    hasSetSelectingRef.current = true;
    expectRows(
      "selection: mark selecting",
      supabase
        .from("session_participants")
        .update({ status: "selecting" })
        .eq("session_id", sid)
        .eq("user_id", activeParticipant.userId)
        .select("id")
    ).catch((err) => showWriteError(err, t));
  }, [activeParticipant, returnTo, session?.id, sessionId, t]);

  const closeConfirmedSession = useCallback(async () => {
    if (!session) return;
    const isOfflineSession = session.id.startsWith("session_") || session.id.startsWith("dev_session_");
    const leave = () => {
      clearSession();
      router.replace("/(app)");
    };
    try {
      if (isCreator && !isOfflineSession) {
        await endSession("selection: host ends session", session.id);
      } else if (!isCreator && !isOfflineSession && profile?.id) {
        await leaveSession("selection: participant leaves", session.id);
      }
      leave();
    } catch (err) {
      // The host stays: the session is still open on the server (D.5).
      if (isCreator) showEndSessionError(err, t);
      else showLeaveWriteError(err, t, leave);
    }
  }, [clearSession, isCreator, profile?.id, session, t]);

  const confirmExitSession = useCallback(() => {
    showDialog(
      isCreator ? "Terminar sessão?" : "Sair da sessão?",
      isCreator
        ? "A fatura já foi confirmada. Voltar atrás irá terminar a sessão para todos."
        : "A fatura já foi confirmada. Voltar atrás irá sair da sessão.",
      [
        { text: "Ficar", style: "cancel" },
        {
          text: isCreator ? "Terminar sessão" : "Sair da sessão",
          style: "destructive",
          onPress: closeConfirmedSession,
        },
      ]
    );
  }, [closeConfirmedSession, isCreator]);

  const leaveSelectionToLobby = useCallback(() => {
    const sid = sessionId ?? session?.id;
    if (
      sid &&
      activeParticipant &&
      !String(sid).startsWith("session_") &&
      !String(sid).startsWith("dev_session_")
    ) {
      const selectionsArray = Array.from(selections.values());
      // Save selections but keep status "selecting" — lobby shows Cancel+Edit for draft.
      // R12: live picks are already on the server; only the status is written.
      expectRows(
        "selection: save draft (selecting)",
        supabase
          .from("session_participants")
          .update(live ? { status: "selecting" } : { selections: selectionsArray, status: "selecting" })
          .eq("session_id", sid)
          .eq("user_id", activeParticipant.userId)
          .select("id")
      ).catch((err) => showWriteError(err, t));
      if (!live) updateSelections(activeParticipant.userId, selectionsArray);
    }
    router.back();
  }, [activeParticipant, live, session?.id, sessionId, selections, updateSelections, t]);

  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
        if (returnTo === "lobby") {
          leaveSelectionToLobby();
          return true;
        }
        confirmExitSession();
        return true;
      });
      return () => subscription.remove();
    }, [confirmExitSession, leaveSelectionToLobby, returnTo])
  );

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

  // ── Per-item selector map: who has selected each item (all participants) ──────
  const itemSelectors = useMemo(() => {
    const map = new Map<string, SelectorInfo[]>();
    if (!session) return map;
    for (const p of session.participants) {
      const color = p.profile.color;
      const isMe = p.userId === userId;
      // For current user use local selections; for others use store
      const itemIds: string[] = isMe
        ? Array.from(selections.keys())
        : p.selections.map((s) => s.itemId);
      for (const itemId of itemIds) {
        if (!map.has(itemId)) map.set(itemId, []);
        const list = map.get(itemId)!;
        if (!list.find((e) => e.userId === p.userId)) {
          list.push({
            userId: p.userId,
            name: p.profile.name,
            avatarIcon: p.profile.avatarIcon,
            avatarUrl: p.profile.avatarUrl,
            color,
            color2: p.profile.color2,
            isMe,
          });
        }
      }
    }
    return map;
  }, [session, userId, selections]);

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
      // R12 — each unit's price over the people holding it (as the split does).
      if (Array.isArray(sel.unitSplits) && sel.unitSplits.length > 0) {
        total += selectionAmount(item, sel);
        continue;
      }
      if (
        item.type === "individual" ||
        item.type === "combo" ||
        item.type === "group"
      ) {
        total += item.totalPrice;
        if (item.addOns) for (const addon of item.addOns) total += addon.totalPrice;
      } else if (item.type === "quantity" || item.quantity > 1) {
        // Proportional: my share = my quantity / total quantity selected by everyone
        const myQty = sel.quantity ?? 1;
        const othersTotal =
          session?.participants
            .filter((p) => p.userId !== userId)
            .reduce((sum, p) => {
              const otherSel = p.selections.find((s) => s.itemId === itemId);
              return sum + (otherSel?.quantity ?? 0);
            }, 0) ?? 0;
        const totalSelected = Math.max(myQty + othersTotal, 1);
        const ratio = myQty / totalSelected;
        total += item.totalPrice * ratio;
        if (item.addOns)
          for (const addon of item.addOns) total += addon.totalPrice * ratio;
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
      // R2 — a charge with no line of its own follows what each person
      // picked (utils/splitter.ts); the others are split equally.
      const billItems = allItems.reduce((s, i) => s + i.totalPrice, 0);
      if (n > 0) {
        for (const cost of receipt.globalCosts) {
          total += cost.split === "proportional"
            ? (billItems > 0 ? (cost.amount * personalItemsSubtotal) / billItems : cost.amount / n)
            : cost.amount / n;
        }
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
  }, [personalItemsSubtotal, allItems, receipt, session, isIndividualTip, tipContribution]);

  // ── Save selections to store (without Supabase) ──────────────────────────────
  const saveToStore = useCallback(() => {
    if (!session || !activeParticipant) return;
    const selectionArray = Array.from(selections.values());
    const tipContrib = isIndividualTip ? tipContribution : undefined;
    updateSelections(activeParticipant.userId, selectionArray, tipContrib);
  }, [session, activeParticipant, selections, isIndividualTip, tipContribution, updateSelections]);

  useEffect(() => {
    const sid = sessionId ?? session?.id;
    if (
      returnTo !== "lobby" ||
      !sid ||
      !activeParticipant ||
      String(sid).startsWith("session_") ||
      String(sid).startsWith("dev_session_")
    ) {
      return;
    }

    const sendDraft = () => {
      if (doneRef.current) return;
      channelRef.current?.send({
        type: "broadcast",
        event: "going_to_selection",
        payload: { userId: activeParticipant.userId },
      });
      channelRef.current?.send({
        type: "broadcast",
        event: "selection_draft",
        payload: {
          userId: activeParticipant.userId,
          selections: Array.from(selections.values()),
        },
      });
    };

    sendDraft();
    const interval = setInterval(sendDraft, 1000);
    return () => clearInterval(interval);
  }, [activeParticipant, returnTo, selections, session?.id, sessionId]);

  // ── Quantity change — max is item.quantity (sharing model: no exclusivity cap) ─
  const handleQuantityChange = useCallback((itemId: string, delta: number) => {
    setSelections((prev) => {
      const next = new Map(prev);
      const current = next.get(itemId);
      if (!current) return next;
      const item = allItems.find((i) => i.id === itemId);
      if (!item) return next;
      const newQty = Math.max(1, Math.min(item.quantity, (current.quantity ?? 1) + delta));
      next.set(itemId, { ...current, quantity: newQty });
      return next;
    });
  }, [allItems]);

  // ── Done: save + broadcast finalization ─────────────────────────────────────
  const handleDone = async () => {
    doneRef.current = true; // stop draft interval broadcasts immediately
    if (!session || !activeParticipant) {
      console.warn("[selection] handleDone: missing session or activeParticipant", {
        session: session?.id,
        activeParticipant: activeParticipant?.userId,
        userId,
        profileId: profile?.id,
      });
      return;
    }
    setSaving(true);
    try {
      const selectionArray = Array.from(selections.values());
      const tipContrib = isIndividualTip ? tipContribution : undefined;
      updateSelections(activeParticipant.userId, selectionArray, tipContrib);

      const isTestUser = activeParticipant.userId.startsWith("test_") || activeParticipant.userId.startsWith("dev_");
      const isOfflineSession = session.id.startsWith("session_") || session.id.startsWith("dev_session_");
      if (!isOfflineSession && !isTestUser) {
        const { data: savedParticipant, error: saveError } = await withTimeout("selection: save Done", supabase
          .from("session_participants")
          // total_owed is not client-writable (B.3); every device computes the
          // split from the selections, and the server fills total_owed in C.
          // R12: live picks are already on the server; Done writes the status only.
          .update(live ? { status: "items_picked" } : { selections: selectionArray, status: "items_picked" })
          .eq("session_id", session.id)
          .eq("user_id", activeParticipant.userId)
          .select("user_id")
          .single());
        if (saveError || !savedParticipant) {
          console.error("[selection] Failed to save participant selections:", {
            error: saveError,
            sessionId: session.id,
            userId: activeParticipant.userId,
            selectionCount: selectionArray.length,
            totalOwed: runningTotal,
          });
          if (saveError?.code === "PGRST204") {
            throw new Error(
              "Database schema is missing session_participants.selections. Run migration 006_repair_session_participants_columns.sql and reload the Supabase API schema cache."
            );
          }
          throw saveError ?? new Error("Selection was not saved.");
        }
      }

      if (returnTo === "lobby") {
        // Lobby flow: broadcast selection_complete then pop back to the already-mounted lobby.
        // router.back() is used instead of router.replace() to avoid creating a new lobby instance,
        // which breaks state (selectionDone, channels) and silently fails for dev_session_ IDs.
        if (!isOfflineSession && channelRef.current) {
          channelRef.current.send({
            type: "broadcast",
            event: "selection_complete",
            payload: { userId: activeParticipant.userId, selections: selectionArray },
          });
        }
        router.back();
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

      // Fake/takeover users always go back; real user stays so allReady overlay can appear
      const isDevUser = activeParticipant.userId.startsWith("test_") || activeParticipant.userId.startsWith("dev_");
      const isTakeover = isDevUser || (userId && userId !== profile?.id);
      if (isTakeover) {
        router.back();
      }
    } catch (err) {
      if (err instanceof WriteError) {
        showWriteError(err, t);
      } else {
        const message = err instanceof Error ? err.message : t("error_generic");
        showDialog(t("error"), message);
      }
    } finally {
      setSaving(false);
    }
  };

  // ── Back press: after receipt confirmation, always closes/leaves session ──────
  const handleBack = useCallback(() => {
    if (returnTo === "lobby") {
      leaveSelectionToLobby();
      return;
    }
    confirmExitSession();
  }, [confirmExitSession, leaveSelectionToLobby, returnTo]);

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
          const rec = sess?.receipt;
          const allRec: ReceiptItem[] = rec
            ? [...rec.categories.starters, ...rec.categories.mains, ...rec.categories.drinks, ...rec.categories.desserts, ...rec.categories.others]
            : [];
          const origItem = allRec.find((i) => i.id === firstUnclaimed);
          next.set(firstUnclaimed, { itemId: firstUnclaimed, quantity: origItem?.quantity ?? 1, isShared: false, sharedWith: [] });
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

  // ── R12: live picks (units decided by the server) ────────────────────────────
  const liveGroups = useMemo(() => {
    if (!receipt) return {} as Record<string, ItemGroup[]>;
    return Object.fromEntries(
      ORDERED_CATEGORIES.map((cat) => [cat, groupItems(receipt.categories[cat])])
    ) as Record<string, ItemGroup[]>;
  }, [receipt]);

  const initials = useMemo(
    () => sessionInitials((session?.participants ?? []).map((p) => ({ userId: p.userId, name: p.profile.name }))),
    [session?.participants]
  );

  // everyone's picks, mine as this screen has them
  const liveHolders = useMemo(
    () =>
      (session?.participants ?? []).map((p) => ({
        userId: p.userId,
        selections: p.userId === myId ? Array.from(selections.values()) : p.selections,
      })),
    [session?.participants, myId, selections]
  );

  const applyMine = useCallback(
    (sels: ItemSelection[]) => {
      if (!myId) return;
      setSelections(new Map(sels.map((s) => [s.itemId, s])));
      updateSelections(myId, sels);
    },
    [myId, updateSelections]
  );

  const joinNames = useCallback(
    (names: string[]) =>
      names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} ${t("units_and")} ${names[names.length - 1]}`,
    [t]
  );

  const liveShare = useCallback(
    async (g: ItemGroup, holderId: string) => {
      if (!session) return;
      setBusyGroup(g.lineIds[0]);
      try {
        const res = await shareUnit(session.id, g.lineIds[0], holderId);
        if (res.selections) applyMine(res.selections);
      } catch (err) {
        showUnitsError(err, t);
      } finally {
        setBusyGroup(null);
      }
    },
    [applyMine, session, t]
  );

  // No free unit: "Os 2 Moskow Mule já foram escolhidos, por A e B. Partilhaste algum? Com quem?"
  const askWhoseUnit = useCallback(
    (g: ItemGroup, holders: UnitHolder[], total: number) => {
      console.log(`[selection] ${g.item.name}: no free unit, held by ${holders.map((h) => h.name).join(", ")}`);
      showDialog(
        t("units_full_title"),
        t("units_full_msg")
          .replace("{total}", String(total))
          .replace("{item}", g.item.name)
          .replace("{names}", joinNames(holders.map((h) => h.name))),
        [
          ...holders.map((h) => ({ text: h.name, onPress: () => void liveShare(g, h.user_id) })),
          { text: t("cancel"), style: "cancel" as const },
        ]
      );
    },
    [joinNames, liveShare, t]
  );

  /** Asks the server for `want` units of the item; true when it gave them. */
  const livePick = useCallback(
    async (g: ItemGroup, want: number): Promise<boolean> => {
      if (!session || busyGroup) return false;
      setBusyGroup(g.lineIds[0]);
      try {
        const res = await pickUnits(session.id, g.lineIds[0], want);
        applyMine(res.selections ?? []);
        if (res.status === "full" && res.holders.length > 0) {
          askWhoseUnit(g, res.holders, res.item_units);
          return false;
        }
        return true;
      } catch (err) {
        showUnitsError(err, t);
        return false;
      } finally {
        setBusyGroup(null);
      }
    },
    [applyMine, askWhoseUnit, busyGroup, session, t]
  );

  // "Partilhar": I hold the item first (the request is for my unit).
  const openShare = useCallback(
    async (g: ItemGroup, mine: number) => {
      if (mine === 0 && !(await livePick(g, 1))) return;
      setShareGroup(g);
    },
    [livePick]
  );

  const sendShare = useCallback(
    async (ids: string[]) => {
      if (!session || !shareGroup) return;
      setShareBusy(true);
      try {
        const res = await requestShare(session.id, shareGroup.lineIds[0], ids);
        const nameOf = (uid: string) => session.participants.find((p) => p.userId === uid)?.profile.name ?? "?";
        const notes = res.results.flatMap((r) =>
          r.result === "limit"
            ? [t("share_limit_msg").replace("{name}", nameOf(r.user_id)).replace("{item}", shareGroup.item.name)]
            : r.result === "not_present"
              ? [t("share_not_present_msg").replace("{name}", nameOf(r.user_id))]
              : []
        );
        setShareGroup(null);
        if (notes.length > 0) showDialog(t("share_with_title").replace("{item}", shareGroup.item.name), notes.join("\n"));
      } catch (err) {
        showUnitsError(err, t);
      } finally {
        setShareBusy(false);
      }
    },
    [session, shareGroup, t]
  );

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
    // FIX 46 — "Session not found" collapsed three distinct causes into one
    // message with no way to tell them apart from the logs: no session at
    // all in the local store, a session with no receipt yet (FIX 44's own
    // documented gap — a participant who joined before the host scanned),
    // or a session whose participants list doesn't include this device's
    // own id. Logged once per distinct state, not on every re-render, since
    // this branch stays mounted while the condition holds (FIX 49: the
    // "once" was only claimed before; it printed on every render).
    const blockedLine =
      `[selection] blocked: session=${!!session} receipt=${!!receipt} activeParticipant=${!!activeParticipant} ` +
      `userId=${userId ?? "none"} sessionParticipants=${session?.participants.length ?? "n/a"}`;
    if (lastBlockedLogRef.current !== blockedLine) {
      lastBlockedLogRef.current = blockedLine;
      console.log(blockedLine);
    }
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

  // ── R12: who is on an item — confirmed (holds a unit), pending (asked),
  //    rejected (refused my request; the X until I tap it or touch the item).
  const dotPerson = (userId: string, state: DotPerson["state"]): DotPerson | null => {
    const p = session.participants.find((pp) => pp.userId === userId);
    if (!p) return null;
    return {
      userId,
      name: p.profile.name,
      initials: initials.get(userId) ?? "?",
      color: p.profile.color,
      color2: p.profile.color2,
      isMe: userId === myId,
      state,
    };
  };

  const dotsFor = (g: ItemGroup, holderIds: string[]): DotPerson[] => {
    const lineSet = new Set(g.lineIds);
    const out: DotPerson[] = [];
    const add = (uid: string, state: DotPerson["state"]) => {
      if (out.some((d) => d.userId === uid)) return;
      const d = dotPerson(uid, state);
      if (d) out.push(d);
    };
    [...holderIds].sort((a, b) => (a === myId ? -1 : b === myId ? 1 : 0)).forEach((uid) => add(uid, "confirmed"));
    for (const r of shareRequests) {
      if (lineSet.has(r.item_id) && r.status === "pending") add(r.to_user, "pending");
    }
    for (const r of shareRequests) {
      if (lineSet.has(r.item_id) && r.status === "rejected" && r.from_user === myId && !r.dismissed_at) add(r.to_user, "rejected");
    }
    return out;
  };

  // Tapping the circles: the names; my rejected requests there are seen (the X goes).
  const showNames = (g: ItemGroup, people: DotPerson[]) => {
    const lineSet = new Set(g.lineIds);
    for (const r of shareRequests) {
      if (lineSet.has(r.item_id) && r.status === "rejected" && r.from_user === myId && !r.dismissed_at) {
        useShareRequestsStore.getState().upsert({ ...r, dismissed_at: new Date().toISOString() });
        manageShareRequest(r.id, "dismiss").catch((err) => showUnitsError(err, t));
      }
    }
    showDialog(
      g.item.name,
      people
        .map((p) =>
          `${p.isMe ? `${p.name} (${t("you_short")})` : p.name}` +
          (p.state === "pending" ? ` — ${t("units_state_pending")}` : p.state === "rejected" ? ` — ${t("units_state_rejected")}` : "")
        )
        .join("\n")
    );
  };

  const renderLive = (g: ItemGroup) => {
    const st = groupState(g.lineIds, g.units, liveHolders, myId);
    const people = dotsFor(g, st.holders.map((h) => h.userId));
    const lineSet = new Set(g.lineIds);
    const askedMe = shareRequests.some((r) => r.status === "pending" && r.to_user === myId && lineSet.has(r.item_id));
    return (
      <SelectableItem
        key={`live_${g.lineIds[0]}`}
        item={g.item}
        currency={receipt.currency}
        selected={st.myUnits > 0}
        selectionColor={accentColor}
        hasPriceVariant={g.priceVariant}
        quantitySelected={Math.max(st.myUnits, 1)}
        claimableQty={st.myUnits + st.freeUnits}
        hidePrices
        live
        busy={busyGroup === g.lineIds[0]}
        onToggle={() => void livePick(g, st.myUnits > 0 ? 0 : 1)}
        onQuantityChange={g.units > 1 ? (delta) => void livePick(g, st.myUnits + delta) : undefined}
        freeLabel={g.units > 1 ? t("units_free").replace("{free}", String(st.freeUnits)).replace("{total}", String(g.units)) : undefined}
        dots={<PersonDots people={people} youLabel={t("you_short")} onPress={() => showNames(g, people)} />}
        requestLabel={askedMe ? t("share_row_request") : undefined}
        onRequestPress={() => useShareRequestsStore.getState().setSheetOpen(true)}
        shareLabel={t("share_button")}
        onSharePress={() => void openShare(g, st.myUnits)}
      />
    );
  };

  // The share window: everyone but me; on the item = on my unit (one-unit
  // items: holding it), or already asked.
  const sharePeople: DotPerson[] = (() => {
    if (!shareGroup) return [];
    const lineSet = new Set(shareGroup.lineIds);
    const st = groupState(shareGroup.lineIds, shareGroup.units, liveHolders, myId);
    const onMyUnit = new Set(
      Array.from(selections.values())
        .filter((s) => lineSet.has(s.itemId))
        .flatMap((s) => s.sharedWith ?? [])
    );
    return session.participants
      .filter((p) => p.userId !== myId)
      .map((p) => {
        const holds = shareGroup.units === 1 ? st.holders.some((h) => h.userId === p.userId) : onMyUnit.has(p.userId);
        const asked = shareRequests.some((r) => r.status === "pending" && r.to_user === p.userId && lineSet.has(r.item_id));
        return dotPerson(p.userId, holds ? "confirmed" : asked ? "pending" : "none");
      })
      .filter((d): d is DotPerson => !!d);
  })();

  const SEL_BG = "#0B0D10";
  const SEL_CARD = "#15181D";
  const SEL_BORDER = "#252A32";
  const SEL_TEXT = "#F9FAFB";
  const SEL_MUTED = "#9CA3AF";

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: SEL_BG }]}>
      <Stack.Screen options={{ gestureEnabled: false }} />

      {/* ── Header ── */}
      <View style={styles.selHeader}>
        <TouchableOpacity
          onPress={handleBack}
          style={styles.selHeaderBtn}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="chevron-back" size={26} color={SEL_TEXT} />
        </TouchableOpacity>
        <View style={styles.selHeaderCenter}>
          <Text style={styles.selHeaderTitle}>Select your items</Text>
          <Text style={styles.selHeaderSub} numberOfLines={1}>
            {receipt.restaurant}
          </Text>
        </View>
        <View style={styles.selHeaderBtn} />
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
            ? 210 + Math.max(insets.bottom, 16)
            : (receipt.selectedTip ?? 0) > 0
            ? 180 + Math.max(insets.bottom, 16)
            : 110 + Math.max(insets.bottom, 16),
        }}
      >
        <View style={[styles.receiptCard, { backgroundColor: SEL_CARD, borderColor: SEL_BORDER }]}>
          {ORDERED_CATEGORIES.map((cat) => {
            if (live) {
              const lg = liveGroups[cat] ?? [];
              if (lg.length === 0) return null;
              return (
                <View key={cat}>
                  <View style={[styles.catHeader, { borderColor: SEL_BORDER }]}>
                    <Text style={[styles.catLabel, { color: SEL_MUTED }]}>
                      {cat.charAt(0).toUpperCase() + cat.slice(1)}
                    </Text>
                    <Ionicons name="chevron-down" size={14} color={SEL_MUTED} />
                  </View>
                  {lg.map(renderLive)}
                </View>
              );
            }
            const groups = groupedCategories[cat] ?? [];
            if (groups.length === 0) return null;
            return (
              <View key={cat}>
                <View style={[styles.catHeader, { borderColor: SEL_BORDER }]}>
                  <Text style={[styles.catLabel, { color: SEL_MUTED }]}>
                    {cat.charAt(0).toUpperCase() + cat.slice(1)}
                  </Text>
                  <Ionicons name="chevron-down" size={14} color={SEL_MUTED} />
                </View>
                {groups.map((entry) => {
                  if (entry.kind === "merged") {
                    const { item, originalIds } = entry;
                    const myClaimedFromGroup = originalIds.filter((id) => selectedIds.has(id));
                    // Unit-based counts: each originalId may represent multiple units (e.g. a 2x receipt line)
                    const unitsClaimedByOthers = originalIds.reduce((sum, id) => {
                      if (otherDoneSelectionIds.has(id)) {
                        const orig = allItems.find((i) => i.id === id);
                        return sum + (orig?.quantity ?? 1);
                      }
                      return sum;
                    }, 0);
                    const unitsSelectedByMe = myClaimedFromGroup.reduce((sum, id) => {
                      const orig = allItems.find((i) => i.id === id);
                      return sum + (orig?.quantity ?? 1);
                    }, 0);
                    const availableQty = item.quantity - unitsClaimedByOthers;
                    return (
                      <SelectableItem
                        key={`merged_${item.id}`}
                        item={item}
                        currency={receipt.currency}
                        selected={myClaimedFromGroup.length > 0}
                        selectionColor={accentColor}
                        sharedWith={[]}
                        availableQty={availableQty}
                        totalQty={item.quantity}
                        quantitySelected={unitsSelectedByMe || 1}
                        claimableQty={availableQty}
                        selectors={undefined}
                        hidePrices
                        onToggle={() => handleToggleMerged(originalIds)}
                        onShareTap={() => {}}
                        onQuantityChange={(delta) => {
                          setSelections((prev) => {
                            const next = new Map(prev);
                            const myClaimed = originalIds.filter((id) => next.has(id));
                            if (delta > 0) {
                              const claimedByOthersSet = new Set(
                                (useSessionStore.getState().currentSession?.participants ?? [])
                                  .filter((p) => p.userId !== userId)
                                  .flatMap((p) => p.selections.map((s) => s.itemId))
                              );
                              const nextId = originalIds.find((id) => !next.has(id) && !claimedByOthersSet.has(id));
                              if (nextId) {
                                const orig = allItems.find((i) => i.id === nextId);
                                next.set(nextId, { itemId: nextId, quantity: orig?.quantity ?? 1, isShared: false, sharedWith: [] });
                              }
                            } else if (myClaimed.length > 1) {
                              next.delete(myClaimed[myClaimed.length - 1]);
                            }
                            return next;
                          });
                        }}
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
                          selectors={undefined}
                          hidePrices
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
                      selectors={undefined}
                      hidePrices
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
        </View>
      </ScrollView>

      {/* ── Equal tip breakdown info card ── */}
      {!isIndividualTip && (receipt.selectedTip ?? 0) > 0 && session.participants.length > 0 && (
        <View
          style={[
            styles.tipInfoCard,
            {
              backgroundColor: cardColor,
              borderColor,
              bottom: 78 + Math.max(insets.bottom, 16),
            },
          ]}
        >
          {receipt.tipPercentage && receipt.tipPercentage > 0 ? (
            // Percentage tip: each person pays their own % of their items
            <View style={styles.tipInfoRow}>
              <Text style={[styles.tipInfoLabel, { color: mutedColor }]}>Tip rate</Text>
              <Text style={[styles.tipInfoValue, { color: textColor }]}>
                {receipt.tipPercentage}% of your items
              </Text>
            </View>
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
            </>
          )}
        </View>
      )}

      {/* ── Issue 3: Individual tip selector panel ── */}
      {isIndividualTip && (
        <View
          style={[
            styles.tipPanel,
            {
              backgroundColor: bgColor,
              borderColor,
              bottom: 78 + Math.max(insets.bottom, 16),
            },
          ]}
        >
          <View style={styles.tipPanelHeader}>
            <Text style={[styles.tipPanelTitle, { color: mutedColor }]}>Your tip</Text>
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
                      {pct === 0 ? t("selection_no_tip") : `${pct}%`}
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
      <View
        style={[
          styles.totalBar,
          {
            backgroundColor: "#15181D",
            borderColor: "#252A32",
            paddingBottom: 12 + Math.max(insets.bottom, 16),
          },
        ]}
      >
        <View style={styles.totalInfo}>
          <Text style={[styles.totalLabel, { color: "#9CA3AF" }]}>
            {selections.size} item{selections.size !== 1 ? "s" : ""} selected
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
          <Text style={styles.doneBarBtnText}>{saving ? "..." : t("selection_done")}</Text>
          {!saving && <Ionicons name="arrow-forward" size={16} color="#fff" />}
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

      {live && (
        <>
          <ShareWithModal
            visible={!!shareGroup}
            itemName={shareGroup?.item.name ?? ""}
            people={sharePeople}
            busy={shareBusy}
            t={t}
            onClose={() => setShareGroup(null)}
            onSend={(ids) => void sendShare(ids)}
          />
          <ShareRequestsModals sessionId={session.id} myId={myId} hostId={session.creatorId} t={t} />
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },

  // ── New selection header ──────────────────────────────────────────────────────
  selHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 58,
  },
  selHeaderBtn: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  selHeaderCenter: {
    flex: 1,
    alignItems: "center",
    gap: 2,
  },
  selHeaderTitle: {
    fontSize: 17,
    fontWeight: "700",
    color: "#F9FAFB",
  },
  selHeaderSub: {
    fontSize: 12,
    color: "#9CA3AF",
    fontWeight: "400",
  },

  // ── Legend row ────────────────────────────────────────────────────────────────
  selLegend: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 8,
    paddingHorizontal: 16,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#252A32",
  },
  selLegendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  selLegendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  selLegendText: {
    fontSize: 12,
    color: "#9CA3AF",
    fontWeight: "500",
  },
  selLegendDivider: {
    width: 1,
    height: 14,
    backgroundColor: "#252A32",
  },

  // ── (kept for compat but unused in new header) ────────────────────────────────
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
  receiptCard: {
    marginHorizontal: 16,
    marginVertical: 8,
    overflow: "hidden",
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  catHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
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
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderRadius: 12,
    minHeight: 48,
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
