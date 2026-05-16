import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  useColorScheme,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "@/constants/colors";
import { useSessionStore } from "@/store/sessionStore";
import { useAuthStore } from "@/store/authStore";
import { Avatar } from "@/components/ui/Avatar";
import { CountdownModal } from "@/components/CountdownModal";
import { useSessionMonitor } from "@/hooks/useSessionMonitor";
import { formatCurrency } from "@/utils/formatter";
import { supabase } from "@/lib/supabase";
import { ReceiptItem, ItemSelection } from "@/types";
import { isDeveloperUser } from "@/constants/dev";

const ORDERED_CATEGORIES = ["starters", "mains", "drinks", "desserts", "others"] as const;

type GroupedEntry =
  | { kind: "single"; item: ReceiptItem }
  | { kind: "merged"; item: ReceiptItem; originalIds: string[] };

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
    } else {
      const totalQty = group.reduce((s, g) => s + g.quantity, 0);
      const totalPrice = Math.round(group.reduce((s, g) => s + g.totalPrice, 0) * 100) / 100;
      const merged: ReceiptItem = { ...group[0], quantity: totalQty, totalPrice };
      result.push({ kind: "merged", item: merged, originalIds: group.map((g) => g.id) });
    }
  }
  return result;
}

const CATEGORY_LABELS: Record<string, string> = {
  starters: "Starters",
  mains: "Mains",
  drinks: "Drinks",
  desserts: "Desserts",
  others: "Others",
};
const RECONNECT_SECONDS = 300; // 5 min
const FINAL_COUNTDOWN = 10;

export default function SessionLobbyScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const isDark = useColorScheme() === "dark";
  const { currentSession, setCountdownActive } = useSessionStore();
  const { profile, isGuest } = useAuthStore();

  const textColor = isDark ? Colors.textPrimaryDark : Colors.textPrimaryLight;
  const mutedColor = isDark ? Colors.textMutedDark : Colors.textMutedLight;
  const bgColor = isDark ? Colors.bgDark : Colors.bgLight;
  const borderColor = isDark ? Colors.cardBorderDark : Colors.cardBorderLight;
  const cardColor = isDark ? Colors.cardDark : Colors.cardLight;

  const session = currentSession;
  const receipt = session?.receipt;
  const myId = profile?.id ?? "";
  const isCreator = session?.creatorId === myId;
  const isDev = isGuest || isDeveloperUser(profile?.email);
  const participants = session?.participants ?? [];

  const [accordionExpanded, setAccordionExpanded] = useState(false);
  // userId → done selecting — initialized from store so it survives lobby remounts
  const [selectionDone, setSelectionDone] = useState<Set<string>>(() => {
    const done = new Set<string>();
    const sess = useSessionStore.getState().currentSession;
    if (sess) {
      for (const p of sess.participants) {
        if (p.selections.length > 0) done.add(p.userId);
      }
    }
    return done;
  });
  // userId → timestamp when disconnected
  const [disconnectedAt, setDisconnectedAt] = useState<Map<string, number>>(new Map());
  // userId → seconds left on reconnect timer
  const [reconnectLeft, setReconnectLeft] = useState<Map<string, number>>(new Map());
  // userId → true when timer expired or host skipped
  const [timerExpired, setTimerExpired] = useState<Set<string>>(new Set());
  // disconnectedUserId → takerId
  const [takenOver, setTakenOver] = useState<Map<string, string>>(new Map());
  // users currently in the selection screen (suppress presence leave)
  const [goingToSelection, setGoingToSelection] = useState<Set<string>>(new Set());
  // 5-second final countdown (null = not active)
  const [finalCountdown, setFinalCountdown] = useState<number | null>(null);
  // true when host presence drops and grace timer expires
  const [hostDisconnected, setHostDisconnected] = useState(false);
  const hostGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Force-navigate home if host closes the session while we're in the lobby
  useSessionMonitor();

  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const graceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const reconnectIntervals = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());
  const finalIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownStarted = useRef(false);

  // Deduzir crédito no último segundo do countdown
  useEffect(() => {
    if (finalCountdown === 1) {
      useAuthStore.getState().deductCredit();
    }
  }, [finalCountdown]);

  // ── Derived: all participant slots filled ────────────────────────────────────
  const allDone = useMemo(() => {
    if (participants.length === 0) return false;
    return participants.every((p) => {
      if (selectionDone.has(p.userId)) return true;
      const takerId = takenOver.get(p.userId);
      if (takerId && selectionDone.has(takerId)) return true;
      return false;
    });
  }, [participants, selectionDone, takenOver]);

  // ── Start 5-second final countdown ──────────────────────────────────────────
  const startFinalCountdown = useCallback(() => {
    setCountdownActive(true);
    setFinalCountdown(FINAL_COUNTDOWN);
    let secs = FINAL_COUNTDOWN;
    finalIntervalRef.current = setInterval(() => {
      secs -= 1;
      setFinalCountdown(secs);
      if (secs <= 0) {
        clearInterval(finalIntervalRef.current!);
        finalIntervalRef.current = null;
        setCountdownActive(false);
        router.replace(`/(app)/dashboard/${id}?source=lobby`);
      }
    }, 1000);
  }, [id, setCountdownActive]);

  const cancelFinalCountdown = useCallback(() => {
    if (finalIntervalRef.current) {
      clearInterval(finalIntervalRef.current);
      finalIntervalRef.current = null;
    }
    setFinalCountdown(null);
    setCountdownActive(false);
    countdownStarted.current = false;
    channelRef.current?.send({
      type: "broadcast",
      event: "countdown_cancel",
      payload: {},
    });
  }, [setCountdownActive]);

  // Countdown is host-triggered (see handleFinalize below)

  // ── Start reconnect timer for a disconnected user ────────────────────────────
  const startReconnectTimer = useCallback((userId: string, startAt: number) => {
    const existing = reconnectIntervals.current.get(userId);
    if (existing) clearInterval(existing);

    const tick = () => {
      const elapsed = Math.floor((Date.now() - startAt) / 1000);
      const left = Math.max(RECONNECT_SECONDS - elapsed, 0);
      setReconnectLeft((prev) => new Map([...prev, [userId, left]]));
      if (left <= 0) {
        clearInterval(reconnectIntervals.current.get(userId)!);
        reconnectIntervals.current.delete(userId);
        setTimerExpired((prev) => new Set([...prev, userId]));
      }
    };

    tick(); // immediate first update
    reconnectIntervals.current.set(userId, setInterval(tick, 1000));
  }, []);

  const markDisconnected = useCallback(
    (uid: string) => {
      const now = Date.now();
      setDisconnectedAt((prev) => new Map([...prev, [uid, now]]));
      startReconnectTimer(uid, now);
    },
    [startReconnectTimer]
  );

  const clearDisconnected = useCallback((uid: string) => {
    setDisconnectedAt((prev) => {
      const next = new Map(prev);
      next.delete(uid);
      return next;
    });
    const interval = reconnectIntervals.current.get(uid);
    if (interval) {
      clearInterval(interval);
      reconnectIntervals.current.delete(uid);
    }
    setReconnectLeft((prev) => {
      const next = new Map(prev);
      next.delete(uid);
      return next;
    });
    setTimerExpired((prev) => {
      const next = new Set(prev);
      next.delete(uid);
      return next;
    });
    setTakenOver((prev) => {
      const next = new Map(prev);
      next.delete(uid);
      return next;
    });
  }, []);

  // ── Supabase presence + broadcast channel ────────────────────────────────────
  useEffect(() => {
    if (!id || !myId || (String(id).startsWith("session_") || String(id).startsWith("dev_session_"))) return;

    const channelName = `lobby:${id}`;
    (supabase.realtime as any).channels
      ?.filter((c: any) => c.topic === `realtime:${channelName}`)
      .forEach((c: any) => supabase.removeChannel(c));

    const ch = supabase.channel(channelName, {
      config: { presence: { key: myId } },
    });

    ch
      .on("presence", { event: "leave" }, ({ leftPresences }) => {
        for (const p of leftPresences as any[]) {
          const uid = p.key as string;
          if (uid === myId) continue;

          // If they navigated to selection intentionally, suppress
          if (goingToSelection.has(uid)) continue;

          const hostId = useSessionStore.getState().currentSession?.creatorId;

          if (uid === hostId && !isCreator) {
            // Host disconnected — 30s grace before showing takeover prompt
            if (hostGraceTimerRef.current) clearTimeout(hostGraceTimerRef.current);
            hostGraceTimerRef.current = setTimeout(() => {
              hostGraceTimerRef.current = null;
              setHostDisconnected(true);
            }, 30_000);
          } else {
            // Regular participant — 30s grace period before marking disconnected
            const timer = setTimeout(() => {
              graceTimers.current.delete(uid);
              markDisconnected(uid);
            }, 30_000);
            graceTimers.current.set(uid, timer);
          }
        }
      })
      .on("presence", { event: "join" }, ({ newPresences }) => {
        for (const p of newPresences as any[]) {
          const uid = p.key as string;
          const hostId = useSessionStore.getState().currentSession?.creatorId;

          if (uid === hostId) {
            // Host reconnected — cancel grace timer and clear disconnected state
            if (hostGraceTimerRef.current) {
              clearTimeout(hostGraceTimerRef.current);
              hostGraceTimerRef.current = null;
            }
            setHostDisconnected(false);
          }

          // Cancel regular grace timer
          const grace = graceTimers.current.get(uid);
          if (grace) {
            clearTimeout(grace);
            graceTimers.current.delete(uid);
          }
          // Clear any disconnection state
          clearDisconnected(uid);
          // Clear "going to selection" flag
          setGoingToSelection((prev) => {
            const next = new Set(prev);
            next.delete(uid);
            return next;
          });
        }
      })
      .on("broadcast", { event: "going_to_selection" }, ({ payload }) => {
        const uid = payload.userId as string;
        setGoingToSelection((prev) => new Set([...prev, uid]));
        // Cancel any pending grace timer (they just announced intent)
        const grace = graceTimers.current.get(uid);
        if (grace) {
          clearTimeout(grace);
          graceTimers.current.delete(uid);
        }
      })
      .on("broadcast", { event: "selection_complete" }, ({ payload }) => {
        const uid = payload.userId as string;
        const sels = (payload.selections ?? []) as ItemSelection[];
        setSelectionDone((prev) => new Set([...prev, uid]));
        if (uid && sels.length > 0) {
          useSessionStore.getState().updateSelections(uid, sels);
        }
        setGoingToSelection((prev) => {
          const next = new Set(prev);
          next.delete(uid);
          return next;
        });
      })
      .on("broadcast", { event: "selection_uncomplete" }, ({ payload }) => {
        const uid = payload.userId as string;
        setSelectionDone((prev) => { const next = new Set(prev); next.delete(uid); return next; });
        // preserveSelections=true when editing (not cancelling) — don't wipe store selections
        if (!payload.preserveSelections) {
          useSessionStore.getState().updateSelections(uid, []);
        }
      })
      .on("broadcast", { event: "countdown_start" }, () => {
        if (!countdownStarted.current) {
          countdownStarted.current = true;
          startFinalCountdown();
        }
      })
      .on("broadcast", { event: "countdown_cancel" }, () => {
        if (finalIntervalRef.current) {
          clearInterval(finalIntervalRef.current);
          finalIntervalRef.current = null;
        }
        setFinalCountdown(null);
        setCountdownActive(false);
        countdownStarted.current = false;
      })
      .on("broadcast", { event: "host_transfer" }, ({ payload }) => {
        const newHostId = payload.newHostId as string | undefined;
        if (!newHostId) return;
        const sess = useSessionStore.getState().currentSession;
        if (sess) useSessionStore.getState().setSession({ ...sess, creatorId: newHostId });
        setHostDisconnected(false);
      })
      .on("broadcast", { event: "timer_cancelled" }, ({ payload }) => {
        const uid = payload.userId as string;
        const interval = reconnectIntervals.current.get(uid);
        if (interval) {
          clearInterval(interval);
          reconnectIntervals.current.delete(uid);
        }
        setTimerExpired((prev) => new Set([...prev, uid]));
      })
      .on("broadcast", { event: "takeover" }, ({ payload }) => {
        const { targetId, takerId } = payload as { targetId: string; takerId: string };
        setTakenOver((prev) => new Map([...prev, [targetId, takerId]]));
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await ch.track({ userId: myId, joinedAt: Date.now() });
        }
      });

    channelRef.current = ch;
    return () => {
      graceTimers.current.forEach(clearTimeout);
      graceTimers.current.clear();
      reconnectIntervals.current.forEach(clearInterval);
      reconnectIntervals.current.clear();
      if (finalIntervalRef.current) clearInterval(finalIntervalRef.current);
      if (hostGraceTimerRef.current) clearTimeout(hostGraceTimerRef.current);
      supabase.removeChannel(ch);
    };
  }, [id, myId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── pg_changes: sync selectionDone from DB (covers missed broadcasts + host edit remounts) ──
  useEffect(() => {
    if (!id || !myId || (String(id).startsWith("session_") || String(id).startsWith("dev_session_"))) return;

    // On mount: fetch current selection status from DB so all devices stay in sync
    const fetchDoneStatus = async () => {
      const { data } = await supabase
        .from("session_participants")
        .select("user_id, selections")
        .eq("session_id", id);
      if (!data) return;
      const done: string[] = [];
      for (const row of data) {
        if (Array.isArray(row.selections) && row.selections.length > 0) {
          done.push(row.user_id as string);
          useSessionStore.getState().updateSelections(
            row.user_id as string,
            row.selections as ItemSelection[]
          );
        }
      }
      if (done.length > 0) {
        setSelectionDone((prev) => new Set([...prev, ...done]));
      }
    };
    fetchDoneStatus();

    const pgName = `lobby-pg:${id}:${Date.now()}`;
    const pgCh = supabase
      .channel(pgName)
      .on("postgres_changes", {
        event: "UPDATE",
        schema: "public",
        table: "session_participants",
        filter: `session_id=eq.${id}`,
      }, (payload) => {
        const uid = payload.new?.user_id as string | undefined;
        const sels = payload.new?.selections;
        if (!uid) return;
        // null means a different column (e.g. paid) was updated — don't touch selections
        if (sels == null) return;
        if (Array.isArray(sels) && sels.length > 0) {
          setSelectionDone((prev) => new Set([...prev, uid]));
          useSessionStore.getState().updateSelections(uid, sels as ItemSelection[]);
        } else {
          setSelectionDone((prev) => { const n = new Set(prev); n.delete(uid); return n; });
          useSessionStore.getState().updateSelections(uid, []);
        }
      })
      .subscribe();

    return () => { supabase.removeChannel(pgCh); };
  }, [id, myId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Actions ──────────────────────────────────────────────────────────────────

  const handleSelectMyItems = () => {
    if (!myId) return;
    channelRef.current?.send({
      type: "broadcast",
      event: "going_to_selection",
      payload: { userId: myId },
    });
    setGoingToSelection((prev) => new Set([...prev, myId]));
    router.push(`/(app)/selection/${id}?userId=${myId}&returnTo=lobby`);
  };

  // Edit: mark as "not ready" for all users, preserve selections in store
  const handleEditMyItems = () => {
    if (!myId) return;
    // Remove from done, add to selecting — all users see "still picking"
    setSelectionDone((prev) => { const n = new Set(prev); n.delete(myId); return n; });
    setGoingToSelection((prev) => new Set([...prev, myId]));
    channelRef.current?.send({
      type: "broadcast",
      event: "going_to_selection",
      payload: { userId: myId },
    });
    channelRef.current?.send({
      type: "broadcast",
      event: "selection_uncomplete",
      payload: { userId: myId, preserveSelections: true },
    });
    router.push(`/(app)/selection/${id}?userId=${myId}&returnTo=lobby`);
  };

  const handleTakeover = (targetId: string) => {
    const target = participants.find((p) => p.userId === targetId);
    Alert.alert(
      `Take Over for ${target?.profile.name ?? "User"}?`,
      "You'll select their items on their behalf. They can still rejoin later.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Take Over 🤝",
          onPress: () => {
            setTakenOver((prev) => new Map([...prev, [targetId, myId]]));
            channelRef.current?.send({
              type: "broadcast",
              event: "takeover",
              payload: { targetId, takerId: myId },
            });
            channelRef.current?.send({
              type: "broadcast",
              event: "going_to_selection",
              payload: { userId: myId },
            });
            setGoingToSelection((prev) => new Set([...prev, myId]));
            router.push(
              `/(app)/selection/${id}?userId=${targetId}&takenBy=${myId}&returnTo=lobby`
            );
          },
        },
      ]
    );
  };

  const handleHostSkipTimer = (targetId: string) => {
    const target = participants.find((p) => p.userId === targetId);
    Alert.alert(
      `Stop Waiting for ${target?.profile.name ?? "User"}?`,
      "Anyone will be able to take over their selection.",
      [
        { text: "Keep Waiting", style: "cancel" },
        {
          text: "Stop Timer",
          style: "destructive",
          onPress: () => {
            const interval = reconnectIntervals.current.get(targetId);
            if (interval) {
              clearInterval(interval);
              reconnectIntervals.current.delete(targetId);
            }
            setTimerExpired((prev) => new Set([...prev, targetId]));
            channelRef.current?.send({
              type: "broadcast",
              event: "timer_cancelled",
              payload: { userId: targetId },
            });
          },
        },
      ]
    );
  };

  const handleFinalize = useCallback(() => {
    if (countdownStarted.current) return;
    countdownStarted.current = true;
    channelRef.current?.send({ type: "broadcast", event: "countdown_start", payload: {} });
    startFinalCountdown();
  }, [startFinalCountdown]);

  const handleTakeOverAsHost = useCallback(async () => {
    if (!id || !myId || !session) return;
    try {
      await supabase
        .from("sessions")
        .update({ host_id: myId })
        .eq("id", id);
      useSessionStore.getState().setSession({ ...session, creatorId: myId });
      setHostDisconnected(false);
      channelRef.current?.send({
        type: "broadcast",
        event: "host_transfer",
        payload: { newHostId: myId },
      });
    } catch {
      Alert.alert("Error", "Could not take over as host. Please try again.");
    }
  }, [id, myId, session]);

  const handleSelectForFake = useCallback((fakeUserId: string) => {
    router.push(`/(app)/selection/${id}?userId=${fakeUserId}&returnTo=lobby`);
  }, [id]);

  const handleCancelReady = useCallback(async () => {
    if (!myId) return;
    setSelectionDone((prev) => {
      const next = new Set(prev);
      next.delete(myId);
      return next;
    });
    channelRef.current?.send({
      type: "broadcast",
      event: "selection_uncomplete",
      payload: { userId: myId },
    });
    useSessionStore.getState().updateSelections(myId, []);
    if (id && !(String(id).startsWith("session_") || String(id).startsWith("dev_session_"))) {
      await supabase
        .from("session_participants")
        .update({ selections: [], total_owed: 0 })
        .eq("session_id", id)
        .eq("user_id", myId);
    }
  }, [myId, id]);

  // ── Helpers ──────────────────────────────────────────────────────────────────

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

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

  const receiptTotal =
    allItems.reduce((s, i) => s + i.totalPrice, 0) +
    (receipt?.globalCosts.reduce((s, c) => s + c.amount, 0) ?? 0) +
    (receipt?.selectedTip ?? 0);

  // Items assigned to at least one participant (updates as Done is pressed)
  const assignedItemIds = useMemo(() => {
    const ids = new Set<string>();
    for (const p of participants) {
      for (const s of p.selections) ids.add(s.itemId);
    }
    return ids;
  }, [participants]);

  const unassignedCount = useMemo(
    () => allItems.filter((item) => !assignedItemIds.has(item.id)).length,
    [allItems, assignedItemIds]
  );

  const doneCount = participants.filter((p) => {
    if (selectionDone.has(p.userId)) return true;
    const takerId = takenOver.get(p.userId);
    return takerId && selectionDone.has(takerId);
  }).length;

  if (!session) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: bgColor }]}>
        <View style={styles.centered}>
          <Text style={[styles.emptyText, { color: mutedColor }]}>Session not found.</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: bgColor }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="arrow-back" size={24} color={textColor} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: textColor }]} numberOfLines={1}>
          Pick Your Items
        </Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Host disconnected banner ─────────────────────────────────────── */}
        {hostDisconnected && !isCreator && (
          <View style={[styles.hostDisconnectedBanner, { backgroundColor: "#EF444415", borderColor: "#EF444455" }]}>
            <Ionicons name="wifi-outline" size={18} color="#EF4444" />
            <View style={{ flex: 1, gap: 6 }}>
              <Text style={[styles.hostDisconnectedTitle, { color: "#EF4444" }]}>
                Host disconnected
              </Text>
              <Text style={[styles.hostDisconnectedBody, { color: mutedColor }]}>
                The host appears to have lost connection. You can take over as host or wait for them to reconnect.
              </Text>
              <View style={styles.hostDisconnectedActions}>
                <TouchableOpacity
                  style={styles.takeOverHostBtn}
                  onPress={handleTakeOverAsHost}
                  activeOpacity={0.8}
                >
                  <Text style={styles.takeOverHostBtnText}>Take Over as Host</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.leaveSessionBtn, { borderColor: mutedColor + "55" }]}
                  onPress={() => {
                    Alert.alert("Leave Session?", "You'll be removed from this session.", [
                      { text: "Cancel", style: "cancel" },
                      {
                        text: "Leave",
                        style: "destructive",
                        onPress: async () => {
                          if (id && myId) {
                            await supabase
                              .from("session_participants")
                              .update({ status: "left" })
                              .eq("session_id", id)
                              .eq("user_id", myId);
                          }
                          useSessionStore.getState().clearSession();
                          router.replace("/(app)");
                        },
                      },
                    ]);
                  }}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.leaveSessionBtnText, { color: mutedColor }]}>Leave Session</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        )}

        {/* ── Unassigned items count — tapping expands the receipt accordion ─── */}
        {receipt && unassignedCount > 0 && (
          <TouchableOpacity
            style={[styles.unassignedNote, { backgroundColor: "#FF950015", borderColor: "#FF950040" }]}
            onPress={() => setAccordionExpanded(true)}
            activeOpacity={0.75}
          >
            <Ionicons name="warning-outline" size={15} color="#FF9500" />
            <Text style={[styles.unassignedNoteText, { color: "#FF9500" }]}>
              {unassignedCount} item{unassignedCount !== 1 ? "s" : ""} not selected — tap to view
            </Text>
            <Ionicons name="chevron-down" size={14} color="#FF9500" />
          </TouchableOpacity>
        )}

        {/* ── Receipt accordion ─────────────────────────────────────────────── */}
        {receipt && (
          <View style={[styles.accordionCard, { borderColor, backgroundColor: cardColor }]}>
            <TouchableOpacity
              style={styles.accordionHeader}
              onPress={() => setAccordionExpanded((v) => !v)}
              activeOpacity={0.7}
            >
              <Ionicons name="document-text-outline" size={18} color={mutedColor} />
              <Text style={[styles.accordionTitle, { color: textColor }]} numberOfLines={1}>
                {receipt.restaurant}
              </Text>
              <Text style={[styles.accordionTotal, { color: Colors.primary }]}>
                {formatCurrency(receiptTotal, receipt.currency)}
              </Text>
              <Ionicons
                name={accordionExpanded ? "chevron-up" : "chevron-down"}
                size={18}
                color={mutedColor}
              />
            </TouchableOpacity>

            {accordionExpanded && (
              <View style={[styles.accordionBody, { borderColor }]}>
                {ORDERED_CATEGORIES.map((cat) => {
                  const rawItems = receipt.categories[cat];
                  if (rawItems.length === 0) return null;
                  const groups = groupItemsByName(rawItems);
                  return (
                    <View key={cat}>
                      <Text style={[styles.catLabel, { color: mutedColor }]}>
                        {CATEGORY_LABELS[cat].toUpperCase()}
                      </Text>
                      {groups.map((entry) => {
                        const item = entry.item;
                        const ids = entry.kind === "merged" ? entry.originalIds : [item.id];
                        const isUnassigned = ids.every((id) => !assignedItemIds.has(id));
                        const claimedCount = ids.filter((id) => assignedItemIds.has(id)).length;
                        const isMergedMulti = entry.kind === "merged" && entry.originalIds.length > 1;
                        const availableCount = ids.length - claimedCount;
                        return (
                          <View
                            key={entry.kind === "merged" ? `m_${item.id}` : item.id}
                            style={[
                              styles.itemRow,
                              { borderColor },
                              isUnassigned && styles.itemRowUnassigned,
                            ]}
                          >
                            {isUnassigned && (
                              <Ionicons name="alert-circle-outline" size={13} color="#FF9500" style={{ marginRight: 2 }} />
                            )}
                            <View style={{ flex: 1 }}>
                              <Text style={[styles.itemName, { color: isUnassigned ? "#FF9500" : textColor }]} numberOfLines={1}>
                                {item.quantity > 1 ? `${item.quantity}× ` : ""}
                                {item.name}
                              </Text>
                              {isMergedMulti && (
                                <Text style={[styles.itemAvail, { color: mutedColor }]}>
                                  {availableCount} of {ids.length} available
                                </Text>
                              )}
                            </View>
                            <Text style={[styles.itemPrice, { color: mutedColor }]}>
                              {formatCurrency(item.unitPrice, receipt.currency)}
                            </Text>
                          </View>
                        );
                      })}
                    </View>
                  );
                })}
                {receipt.globalCosts.map((cost) => (
                  <View key={cost.id ?? cost.name} style={[styles.itemRow, { borderColor }]}>
                    <Text style={[styles.itemName, { color: mutedColor }]}>{cost.name}</Text>
                    <Text style={[styles.itemPrice, { color: mutedColor }]}>
                      {formatCurrency(cost.amount, receipt.currency)}
                    </Text>
                  </View>
                ))}
                {(receipt.selectedTip ?? 0) > 0 && (
                  <View style={[styles.itemRow, { borderColor }]}>
                    <Text style={[styles.itemName, { color: mutedColor }]}>Tip</Text>
                    <Text style={[styles.itemPrice, { color: mutedColor }]}>
                      {formatCurrency(receipt.selectedTip!, receipt.currency)}
                    </Text>
                  </View>
                )}
              </View>
            )}
          </View>
        )}

        {/* ── Section label ─────────────────────────────────────────────────── */}
        <Text style={[styles.sectionLabel, { color: mutedColor }]}>
          PARTICIPANTS
        </Text>

        {/* ── Participant cards ─────────────────────────────────────────────── */}
        {participants.map((p) => {
          const isDone = selectionDone.has(p.userId);
          const isDisconnected = disconnectedAt.has(p.userId);
          const isTakenOver = takenOver.has(p.userId);
          const takerId = takenOver.get(p.userId);
          const takerName =
            participants.find((pp) => pp.userId === takerId)?.profile.name ?? "Someone";
          const secsLeft = reconnectLeft.get(p.userId) ?? RECONNECT_SECONDS;
          const expired = timerExpired.has(p.userId);
          const isMe = p.userId === myId;

          // Slot fully covered
          const slotDone =
            isDone || (isTakenOver && takerId && selectionDone.has(takerId));

          return (
            <View
              key={p.userId}
              style={[
                styles.participantCard,
                { borderColor, backgroundColor: cardColor },
                isDisconnected && !isTakenOver && styles.participantFaded,
              ]}
            >
              <View
                style={[
                  styles.participantAccent,
                  {
                    backgroundColor:
                      isDisconnected && !isTakenOver ? mutedColor : p.profile.color,
                  },
                ]}
              />

              <Avatar
                name={p.profile.name}
                avatarIcon={p.profile.avatarIcon}
                avatarUrl={p.profile.avatarUrl}
                color={p.profile.color}
                size={40}
              />

              <View style={styles.participantInfo}>
                <View style={styles.nameRow}>
                  <Text
                    style={[styles.participantName, { color: textColor }]}
                    numberOfLines={1}
                  >
                    {p.profile.name}
                    {isMe ? " (You)" : ""}
                  </Text>
                  {p.userId === session.creatorId && (
                    <View style={styles.hostBadge}>
                      <Text style={styles.hostBadgeText}>Host</Text>
                    </View>
                  )}
                </View>

                {/* Status text — goingToSelection overrides slotDone (editing = not ready) */}
                {isDisconnected && !isTakenOver ? (
                  expired ? (
                    <Text style={[styles.statusText, { color: Colors.error }]}>
                      Disconnected
                    </Text>
                  ) : (
                    <Text style={[styles.statusText, { color: Colors.warning }]}>
                      Disconnected · {formatTime(secsLeft)} to reconnect
                    </Text>
                  )
                ) : isTakenOver ? (
                  <Text style={[styles.statusText, { color: Colors.primary }]}>
                    🤝 {takerName} selecting for them
                  </Text>
                ) : goingToSelection.has(p.userId) ? (
                  <Text style={[styles.statusText, { color: isMe ? mutedColor : Colors.primary }]}>
                    {isMe ? "Selecting my items..." : "Selecting their items..."}
                  </Text>
                ) : slotDone ? (
                  <View style={styles.doneRow}>
                    <Ionicons name="checkmark-circle" size={14} color={Colors.success} />
                    <Text style={[styles.statusText, { color: Colors.success }]}>
                      Items picked
                    </Text>
                  </View>
                ) : (
                  <Text style={[styles.statusText, { color: mutedColor }]}>
                    {isMe ? "Selecting my items" : "Selecting their items"}
                  </Text>
                )}
              </View>

              {/* Right-side actions */}
              {isDisconnected && !isTakenOver ? (
                <View style={styles.actionCol}>
                  {isCreator && !expired && (
                    <TouchableOpacity
                      style={[styles.skipBtn, { borderColor: Colors.warning }]}
                      onPress={() => handleHostSkipTimer(p.userId)}
                      activeOpacity={0.7}
                    >
                      <Text style={[styles.skipBtnText, { color: Colors.warning }]}>
                        Skip
                      </Text>
                    </TouchableOpacity>
                  )}
                  {expired && (
                    <TouchableOpacity
                      style={[styles.takeoverBtn, { borderColor: Colors.primary }]}
                      onPress={() => handleTakeover(p.userId)}
                      activeOpacity={0.7}
                    >
                      <Text style={styles.takeoverBtnText}>🤝 Take Over</Text>
                    </TouchableOpacity>
                  )}
                </View>
              ) : isMe && !slotDone ? (
                <TouchableOpacity
                  style={styles.selectBtn}
                  onPress={handleSelectMyItems}
                  activeOpacity={0.8}
                >
                  <Text style={styles.selectBtnText}>Select →</Text>
                </TouchableOpacity>
              ) : isMe && slotDone ? (
                <View style={styles.doneActions}>
                  <TouchableOpacity
                    style={[styles.cancelReadyBtn, { borderColor: "#EF444466" }]}
                    onPress={handleCancelReady}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.cancelReadyText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.editBtn, { borderColor }]}
                    onPress={handleEditMyItems}
                    activeOpacity={0.8}
                  >
                    <Text style={[styles.editBtnText, { color: mutedColor }]}>Edit</Text>
                  </TouchableOpacity>
                </View>
              ) : isDev && (p.userId.startsWith("test_") || p.userId.startsWith("dev_")) && receipt ? (
                <TouchableOpacity
                  style={styles.selectBtn}
                  onPress={() => handleSelectForFake(p.userId)}
                  activeOpacity={0.8}
                >
                  <Text style={styles.selectBtnText}>Select →</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          );
        })}

        {/* ── Progress bar ─────────────────────────────────────────────────── */}
        <View style={[styles.progressCard, { borderColor, backgroundColor: cardColor }]}>
          <View style={styles.progressHeader}>
            <Ionicons
              name={allDone ? "checkmark-circle" : "time-outline"}
              size={17}
              color={allDone ? Colors.success : mutedColor}
            />
            <Text
              style={[
                styles.progressText,
                { color: allDone ? Colors.success : mutedColor },
              ]}
            >
              {allDone
                ? "Everyone's ready!"
                : `${doneCount} of ${participants.length} picked`}
            </Text>
          </View>
          <View style={[styles.progressBarBg, { backgroundColor: borderColor }]}>
            <View
              style={[
                styles.progressBarFill,
                {
                  backgroundColor: allDone ? Colors.success : Colors.primary,
                  width: `${participants.length > 0 ? (doneCount / participants.length) * 100 : 0}%`,
                },
              ]}
            />
          </View>
        </View>
        {/* ── Finalize button — host only ───────────────────────────────────── */}
        {isCreator && (
          <TouchableOpacity
            style={[styles.finalizeBtn, finalCountdown !== null && { opacity: 0.5 }]}
            onPress={handleFinalize}
            disabled={finalCountdown !== null}
            activeOpacity={0.85}
          >
            <Ionicons name="checkmark-done-outline" size={20} color="#fff" />
            <Text style={styles.finalizeBtnText}>Finalize Split</Text>
            <Ionicons name="arrow-forward" size={18} color="#fff" />
          </TouchableOpacity>
        )}
      </ScrollView>

      <CountdownModal
        visible={finalCountdown !== null}
        countdown={finalCountdown}
        participants={participants}
        currency={receipt?.currency}
        onCancel={cancelFinalCountdown}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  emptyText: { fontSize: 16 },

  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: "700",
    flex: 1,
    textAlign: "center",
  },
  scroll: {
    paddingHorizontal: 20,
    paddingBottom: 32,
    gap: 12,
  },

  // ── Accordion ──────────────────────────────────────────────────────────────────
  accordionCard: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    overflow: "hidden",
  },
  accordionHeader: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    gap: 10,
  },
  accordionTitle: { flex: 1, fontSize: 15, fontWeight: "600" },
  accordionTotal: { fontSize: 15, fontWeight: "700" },
  accordionBody: { borderTopWidth: StyleSheet.hairlineWidth },
  catLabel: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 4,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  itemName: { fontSize: 13, fontWeight: "500" },
  itemAvail: { fontSize: 11, fontStyle: "italic", marginTop: 1 },
  itemPrice: { fontSize: 13, fontWeight: "600" },

  // ── Section label ──────────────────────────────────────────────────────────────
  sectionLabel: {
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.5,
    marginTop: 4,
  },

  // ── Participant cards ──────────────────────────────────────────────────────────
  participantCard: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    minHeight: 68,
    paddingRight: 12,
    gap: 10,
    overflow: "hidden",
  },
  participantFaded: { opacity: 0.6 },
  participantAccent: { width: 3, alignSelf: "stretch" },
  participantInfo: { flex: 1, gap: 3 },
  nameRow: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  participantName: { fontSize: 15, fontWeight: "600", flexShrink: 1 },
  hostBadge: {
    backgroundColor: Colors.primary + "33",
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 5,
  },
  hostBadgeText: { color: Colors.primary, fontSize: 10, fontWeight: "600" },
  statusText: { fontSize: 12, fontWeight: "500" },
  doneRow: { flexDirection: "row", alignItems: "center", gap: 4 },

  // ── Action buttons ─────────────────────────────────────────────────────────────
  actionCol: { gap: 6, alignItems: "flex-end" },
  selectBtn: {
    backgroundColor: Colors.primary,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    minWidth: 80,
    alignItems: "center",
  },
  selectBtnText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  doneActions: {
    flexDirection: "row",
    gap: 6,
    alignItems: "center",
  },
  cancelReadyBtn: {
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: "center",
  },
  cancelReadyText: { color: "#EF4444", fontWeight: "600", fontSize: 12 },
  editBtn: {
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    minWidth: 50,
    alignItems: "center",
  },
  editBtnText: { fontWeight: "600", fontSize: 13 },
  skipBtn: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  skipBtnText: { fontSize: 11, fontWeight: "600" },
  takeoverBtn: {
    borderWidth: 1.5,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  takeoverBtnText: { color: Colors.primary, fontSize: 12, fontWeight: "700" },

  // ── Progress card ──────────────────────────────────────────────────────────────
  progressCard: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 14,
    gap: 10,
  },
  progressHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  progressText: { fontSize: 13, fontWeight: "600", flex: 1 },
  progressBarBg: {
    height: 4,
    borderRadius: 2,
    overflow: "hidden",
  },
  progressBarFill: {
    height: 4,
    borderRadius: 2,
  },

  // ── Finalize button ────────────────────────────────────────────────────────────
  finalizeBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.primary,
    paddingVertical: 16,
    borderRadius: 16,
    gap: 10,
  },
  finalizeBtnText: { color: "#fff", fontSize: 16, fontWeight: "700" },

  // ── Host disconnected banner ───────────────────────────────────────────────────
  hostDisconnectedBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
  },
  hostDisconnectedTitle: {
    fontSize: 14,
    fontWeight: "700",
  },
  hostDisconnectedBody: {
    fontSize: 13,
    lineHeight: 18,
  },
  hostDisconnectedActions: {
    flexDirection: "row",
    gap: 8,
    marginTop: 2,
  },
  takeOverHostBtn: {
    backgroundColor: Colors.primary,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  takeOverHostBtnText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "700",
  },
  leaveSessionBtn: {
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  leaveSessionBtnText: {
    fontSize: 13,
    fontWeight: "600",
  },

  // ── Unassigned note ────────────────────────────────────────────────────────────
  unassignedNote: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  unassignedNoteText: { fontSize: 13, fontWeight: "600", flex: 1 },
  itemRowUnassigned: {
    backgroundColor: "#FF950012",
  },

});
