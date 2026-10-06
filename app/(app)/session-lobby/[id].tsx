import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useFocusEffect } from "@react-navigation/native";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Alert,
  BackHandler,
  ActivityIndicator,
  Share,
  Modal,
  AppState,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { router, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSessionStore } from "@/store/sessionStore";
import { useAuthStore } from "@/store/authStore";
import { Avatar } from "@/components/ui/Avatar";
import { CountdownModal } from "@/components/CountdownModal";
import { useSessionMonitor } from "@/hooks/useSessionMonitor";
import { formatCurrency } from "@/utils/formatter";
import { supabase } from "@/lib/supabase";
import { ReceiptItem, ItemSelection, SessionParticipant, ParsedReceipt } from "@/types";
import { isDeveloperUser } from "@/constants/dev";
import { useI18nStore } from "@/store/i18nStore";
import { TranslationKey } from "@/constants/translations";
import { QRGenerator } from "@/components/session/QRGenerator";
import { buildSessionLink } from "@/lib/deeplink";

const HOME_THEME = {
  background: "#0B0D10",
  card: "#15181D",
  cardPrimary: "#2A2D5F",
  border: "#252A32",
  primary: "#6366F1",
  success: "#22C55E",
  warning: "#F59E0B",
  error: "#EF4444",
  text: "#F9FAFB",
  secondary: "#9CA3AF",
  muted: "#6B7280",
};

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
      const allSamePrice = group.every((g) => g.unitPrice === group[0].unitPrice);
      if (allSamePrice) {
        const totalQty = group.reduce((s, g) => s + g.quantity, 0);
        const totalPrice = Math.round(group.reduce((s, g) => s + g.totalPrice, 0) * 100) / 100;
        const merged: ReceiptItem = { ...group[0], quantity: totalQty, totalPrice };
        result.push({ kind: "merged", item: merged, originalIds: group.map((g) => g.id) });
      } else {
        group.forEach((g) => result.push({ kind: "single", item: g }));
      }
    }
  }
  return result;
}

const CATEGORY_LABEL_KEYS: Record<string, TranslationKey> = {
  starters: "lobby_cat_starters",
  mains: "lobby_cat_mains",
  drinks: "lobby_cat_drinks",
  desserts: "lobby_cat_desserts",
  others: "lobby_cat_others",
};
const RECONNECT_SECONDS = 300; // 5 min
// FIX 49 — host takeover is switched OFF pending a server-side RPC
// (`update sessions set host_id = me where host_id = <old>`, first caller
// wins). As written it lied: RLS ("Host can update their session") makes a
// non-host's host_id update match 0 rows WITHOUT an error, so the catch
// never fired and the DB host never changed — yet the taker became host
// locally and broadcast host_transfer. Two takers ended up each believing
// the other was host (broadcasts don't echo to the sender) while the DB
// kept the original, who also still believed it was host on return. It
// never ran before FIX 48 (presence never detected a host leaving), so
// switching it off removes nothing anyone used. Covers: the button, the
// handler, and applying a received host_transfer. The "host
// disconnected" banner itself stays (it's real information) along with
// its Leave button.
const HOST_TAKEOVER_ENABLED = false;
const FINAL_COUNTDOWN = 5;

export default function SessionLobbyScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const { currentSession, setCountdownActive, clearSession } = useSessionStore();
  const { profile } = useAuthStore();
  const { t, language } = useI18nStore();
  void language;

  const textColor = HOME_THEME.text;
  const mutedColor = HOME_THEME.secondary;
  const borderColor = HOME_THEME.border;
  const cardColor = HOME_THEME.card;

  const session = currentSession;
  const receipt = session?.receipt;
  const myId = profile?.id ?? "";
  const isCreator = session?.creatorId === myId;
  const isDev = isDeveloperUser(profile?.email);
  const participants = session?.participants ?? [];
  const visibleParticipants = useMemo(() => {
    if (!myId) return participants;
    return [...participants].sort((a, b) => {
      if (a.userId === myId) return -1;
      if (b.userId === myId) return 1;
      if (a.userId === session?.creatorId) return -1;
      if (b.userId === session?.creatorId) return 1;
      return 0;
    });
  }, [myId, participants, session?.creatorId]);

  // Fresh profiles — pre-populated from store so avatars show immediately, then refreshed from DB
  const [freshProfiles, setFreshProfiles] = useState<Map<string, { avatarUrl?: string; avatarIcon?: string }>>(() => {
    const sess = useSessionStore.getState().currentSession;
    if (!sess) return new Map();
    const map = new Map<string, { avatarUrl?: string; avatarIcon?: string }>();
    for (const p of sess.participants) {
      const url = p.profile.avatarUrl;
      map.set(p.userId, {
        avatarUrl: (url && url.startsWith("http")) ? url : undefined,
        avatarIcon: p.profile.avatarIcon,
      });
    }
    return map;
  });

  // Fetch latest profiles from DB (filter out local file:// URIs that only work on the owner's device)
  const fetchFreshProfiles = useCallback(async () => {
    const sess = useSessionStore.getState().currentSession;
    if (!sess || !id || String(id).startsWith("session_") || String(id).startsWith("dev_session_")) return;
    const userIds = sess.participants.map((p) => p.userId);
    if (userIds.length === 0) return;
    const { data } = await supabase.from("profiles").select("id, avatar_url, avatar_icon").in("id", userIds);
    if (!data) return;
    const map = new Map<string, { avatarUrl?: string; avatarIcon?: string }>();
    for (const row of data) {
      const url = row.avatar_url as string | null;
      map.set(row.id as string, {
        avatarUrl: (url && url.startsWith("http")) ? url : undefined,
        avatarIcon: row.avatar_icon ?? undefined,
      });
    }
    setFreshProfiles(map);
  }, [id]);

  const [accordionExpanded, setAccordionExpanded] = useState(false);
  const [qrExpanded, setQrExpanded] = useState(false);
  // userId → basic info for participants who scanned QR but haven't confirmed yet
  const [pendingParticipants, setPendingParticipants] = useState<Map<string, { name: string; color: string; avatarIcon?: string; avatarUrl?: string }>>(new Map());
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
  // users who explicitly left the session (status="left") — kept for display
  const [leftParticipantIds, setLeftParticipantIds] = useState<Set<string>>(new Set());
  // users currently in the selection screen (suppress presence leave)
  const [goingToSelection, setGoingToSelection] = useState<Set<string>>(new Set());
  const [draftSelections, setDraftSelections] = useState<Map<string, ItemSelection[]>>(new Map());
  // myId has saved draft (Back from selection — not yet confirmed)
  const [savedDraftIds, setSavedDraftIds] = useState<Set<string>>(new Set());
  // View modal: show what a confirmed participant selected
  const [viewSelectionUserId, setViewSelectionUserId] = useState<string | null>(null);
  // 5-second final countdown (null = not active)
  const [finalCountdown, setFinalCountdown] = useState<number | null>(null);
  // true when host presence drops and grace timer expires
  const [hostDisconnected, setHostDisconnected] = useState(false);
  const hostGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // FIX 48 — the status this device last put into presence, so it can be
  // re-tracked as-is after an untrack (background) or a channel rejoin,
  // instead of falling back to "waiting".
  const presenceStatusRef = useRef<"waiting" | "selecting" | "done">("waiting");
  const trackPresence = (status: "waiting" | "selecting" | "done") => {
    presenceStatusRef.current = status;
    const uid = useAuthStore.getState().profile?.id;
    if (!uid) return;
    return channelRef.current?.track({ userId: uid, status, joinedAt: Date.now() });
  };
  // true while host is on the review screen editing the receipt
  const [hostReviewing, setHostReviewing] = useState(false);
  const reviewingRef = useRef(false);

  // Force-navigate home if host closes the session while we're in the lobby
  useSessionMonitor();

  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const graceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const reconnectIntervals = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());
  const finalIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownStarted = useRef(false);
  const goingToSelectionRef = useRef<Set<string>>(new Set());
  const savedDraftRef = useRef<Set<string>>(new Set());
  // FIX 49 — read by the presence/broadcast handlers and a focus callback
  // whose effects only re-run on [id, myId]; reading `isCreator` directly
  // there froze it at the first render.
  const isCreatorRef = useRef(isCreator);

  // Keep refs in sync with state (used in callbacks)
  useEffect(() => { goingToSelectionRef.current = goingToSelection; }, [goingToSelection]);
  useEffect(() => { savedDraftRef.current = savedDraftIds; }, [savedDraftIds]);
  useEffect(() => { isCreatorRef.current = isCreator; }, [isCreator]);

  // Fetch profiles immediately on mount so avatars show without waiting for focus
  useEffect(() => { fetchFreshProfiles(); }, [fetchFreshProfiles]);

  // Deduzir crédito no último segundo do countdown
  useEffect(() => {
    if (finalCountdown === 1) {
      useAuthStore.getState().deductCredit();
    }
  }, [finalCountdown]);

  // ── DB fetch: sync all participant selections (fallback for missed broadcasts) ──
  // Returns the raw DB selections map so callers can make decisions without re-reading state
  const syncSelectionsFromDB = useCallback(async (): Promise<Map<string, { selections: ItemSelection[]; status: string }>> => {
    const dbMap = new Map<string, { selections: ItemSelection[]; status: string }>();
    if (!id || String(id).startsWith("session_") || String(id).startsWith("dev_session_")) return dbMap;
    const { data } = await supabase
      .from("session_participants")
      .select("user_id, selections, status")
      .eq("session_id", id);
    if (!data) return dbMap;
    const nowDone: string[] = [];
    for (const row of data) {
      const uid = row.user_id as string;
      const sels = Array.isArray(row.selections) ? (row.selections as ItemSelection[]) : [];
      const status = (row.status ?? "joined") as string;
      dbMap.set(uid, { selections: sels, status });
      // "items_picked" = confirmed Done; "joined" + sels = legacy confirmed; "selecting" + sels = draft
      const isConfirmed = sels.length > 0 && (status === "items_picked" || (status === "joined"));
      const isDraft = status === "selecting";
      if (isConfirmed) {
        nowDone.push(uid);
        useSessionStore.getState().updateSelections(uid, sels);
        setGoingToSelection((prev) => {
          if (!prev.has(uid)) return prev;
          const next = new Set(prev);
          next.delete(uid);
          return next;
        });
        // Confirmed user is no longer a draft
        setSavedDraftIds((prev) => {
          if (!prev.has(uid)) return prev;
          const next = new Set(prev);
          next.delete(uid);
          return next;
        });
      } else if (isDraft) {
        // Drafts update local state for pre-population/availability, but never count as Done.
        useSessionStore.getState().updateSelections(uid, sels);
        setDraftSelections((prev) => {
          const next = new Map(prev);
          next.set(uid, sels);
          return next;
        });
        if (uid === myId && !goingToSelectionRef.current.has(uid)) {
          setSavedDraftIds((prev) => { const next = new Set(prev); next.add(uid); return next; });
          setGoingToSelection((prev) => {
            if (!prev.has(uid)) return prev;
            const next = new Set(prev);
            next.delete(uid);
            return next;
          });
        }
      } else if (sels.length === 0 && !goingToSelectionRef.current.has(uid)) {
        useSessionStore.getState().updateSelections(uid, []);
      }
    }
    if (nowDone.length > 0) {
      setSelectionDone((prev) => new Set([...prev, ...nowDone]));
    }
    return dbMap;
  }, [id, myId]);

  // Poll DB every 2 seconds as a reliable fallback when broadcasts are missed
  useEffect(() => {
    if (!id || !myId || String(id).startsWith("session_") || String(id).startsWith("dev_session_")) return;
    const interval = setInterval(syncSelectionsFromDB, 2000);
    return () => clearInterval(interval);
  }, [id, myId, syncSelectionsFromDB]);

  // ── Derived: all participant slots filled ────────────────────────────────────
  const allDone = useMemo(() => {
    if (participants.length === 0) return false;
    return participants.every((p) => {
      // Users who left the session don't block finalization
      if (leftParticipantIds.has(p.userId)) return true;
      if (selectionDone.has(p.userId)) return true;
      const takerId = takenOver.get(p.userId);
      if (takerId && selectionDone.has(takerId)) return true;
      return false;
    });
  }, [participants, selectionDone, takenOver, leftParticipantIds]);

  // ── Start 5-second final countdown ──────────────────────────────────────────
  const startFinalCountdown = useCallback(() => {
    if (finalIntervalRef.current) return;
    void syncSelectionsFromDB();
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
  }, [id, setCountdownActive, syncSelectionsFromDB]);

  const cancelFinalCountdown = useCallback(async () => {
    if (finalIntervalRef.current) {
      clearInterval(finalIntervalRef.current);
      finalIntervalRef.current = null;
    }
    setFinalCountdown(null);
    setCountdownActive(false);
    countdownStarted.current = false;
    if (isCreator && id && !String(id).startsWith("session_") && !String(id).startsWith("dev_session_")) {
      await supabase
        .from("sessions")
        .update({ status: "selecting" })
        .eq("id", id);
    }
    channelRef.current?.send({
      type: "broadcast",
      event: "countdown_cancel",
      payload: {},
    });
  }, [id, isCreator, setCountdownActive]);

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
      .on("presence", { event: "leave" }, ({ key, currentPresences }) => {
        // FIX 48 — currentPresences is what's still tracked under this key
        // after the leave. Non-empty means the same user still has another
        // live connection (second tab/device, or a rejoin that landed before
        // the old socket's leave) — they haven't actually gone.
        if (currentPresences.length > 0) {
          console.log(`[session-lobby] presence leave ignored — ${currentPresences.length} connection(s) still open`);
          return;
        }
        // FIX 48 — the presence key (user id) is on the event itself; each
        // presence entry only carries the tracked payload + presence_ref, so
        // reading the key per entry gave `undefined` since the initial commit.
        {
          const uid = key;
          console.log(`[session-lobby] presence leave: ${uid}${uid === myId ? " (me, ignored)" : ""}`);
          if (uid === myId) return;

          // If they navigated to selection intentionally, suppress
          if (goingToSelectionRef.current.has(uid)) {
            console.log(`[session-lobby] presence leave for ${uid} suppressed — they went to selection`);
            return;
          }

          const hostId = useSessionStore.getState().currentSession?.creatorId;

          if (uid === hostId && !isCreatorRef.current) {
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
              console.log(`[session-lobby] marking ${uid} disconnected (30s grace elapsed)`);
              markDisconnected(uid);
            }, 30_000);
            graceTimers.current.set(uid, timer);
          }
        }
      })
      .on("presence", { event: "join" }, ({ key, newPresences }) => {
        // FIX 48 — see leave: key from the event, status from the tracked payload.
        {
          const uid = key;
          const presenceStatus = (newPresences[0] as { status?: string } | undefined)?.status;
          console.log(`[session-lobby] presence join: ${uid} status=${presenceStatus ?? "none"}`);
          const hostId = useSessionStore.getState().currentSession?.creatorId;

          if (uid === hostId) {
            if (hostGraceTimerRef.current) {
              clearTimeout(hostGraceTimerRef.current);
              hostGraceTimerRef.current = null;
            }
            setHostDisconnected(false);
          }

          const grace = graceTimers.current.get(uid);
          if (grace) {
            clearTimeout(grace);
            graceTimers.current.delete(uid);
          }
          clearDisconnected(uid);

          // Add participant if not yet in store (covers late joiners)
          const existingSess = useSessionStore.getState().currentSession;
          if (existingSess && uid !== myId && !existingSess.participants.find((pr) => pr.userId === uid)) {
            supabase
              .from("profiles")
              .select("id, name, color, avatar_icon, avatar_url, bill_credits, referral_count, is_pro")
              .eq("id", uid)
              .single()
              .then(({ data }) => {
                if (!data) return;
                const s = useSessionStore.getState().currentSession;
                if (!s || s.participants.find((pr) => pr.userId === uid)) return;
                const newP: SessionParticipant = {
                  userId: uid,
                  profile: {
                    id: uid,
                    name: (data.name as string | null) ?? "User",
                    color: (data.color as string | null) ?? HOME_THEME.primary,
                    avatarIcon: (data.avatar_icon as string | null) ?? undefined,
                    avatarUrl: (data.avatar_url as string | null) ?? undefined,
                    billCredits: (data.bill_credits as number | null) ?? 0,
                    referralCount: (data.referral_count as number | null) ?? 0,
                    isPro: (data.is_pro as boolean | null) ?? false,
                  },
                  selections: [],
                  totalOwed: 0,
                  paid: false,
                  confirmedByCreator: false,
                };
                useSessionStore.getState().setSession({
                  ...s,
                  participants: [...s.participants, newP],
                });
              });
          }

          // If rejoining user was in "selecting" state, restore that status
          if (presenceStatus === "selecting") {
            setGoingToSelection((prev) => new Set([...prev, uid]));
          } else {
            // Only clear goingToSelection if they're back (not selecting)
            setGoingToSelection((prev) => {
              const next = new Set(prev);
              next.delete(uid);
              return next;
            });
          }
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
        // Update Zustand BEFORE removing draft to avoid a blink where items appear unassigned
        if (uid && sels.length > 0) {
          useSessionStore.getState().updateSelections(uid, sels);
        }
        setDraftSelections((prev) => {
          const next = new Map(prev);
          next.delete(uid);
          return next;
        });
        setSavedDraftIds((prev) => {
          if (!prev.has(uid)) return prev;
          const next = new Set(prev);
          next.delete(uid);
          return next;
        });
        setGoingToSelection((prev) => {
          const next = new Set(prev);
          next.delete(uid);
          return next;
        });
        // Update own presence so late joiners see the correct "done" state
        const currentMyId = useAuthStore.getState().profile?.id;
        if (uid === currentMyId) {
          trackPresence("done");
        }
      })
      .on("broadcast", { event: "selection_uncomplete" }, ({ payload }) => {
        const uid = payload.userId as string;
        setSelectionDone((prev) => { const next = new Set(prev); next.delete(uid); return next; });
        setDraftSelections((prev) => {
          const next = new Map(prev);
          next.delete(uid);
          return next;
        });
        // preserveSelections=true when editing (not cancelling) — don't wipe store selections
        if (!payload.preserveSelections) {
          useSessionStore.getState().updateSelections(uid, []);
        }
      })
      .on("broadcast", { event: "selection_draft" }, ({ payload }) => {
        const uid = payload.userId as string | undefined;
        if (!uid) return;
        const sels = Array.isArray(payload.selections)
          ? (payload.selections as ItemSelection[])
          : [];
        setDraftSelections((prev) => {
          const next = new Map(prev);
          next.set(uid, sels);
          return next;
        });
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
        // Non-host users navigate back to their selection screen
        const myId = useAuthStore.getState().profile?.id;
        const creatorId = useSessionStore.getState().currentSession?.creatorId;
        if (myId && myId !== creatorId) {
          router.push(`/(app)/selection/${id}?userId=${myId}&returnTo=lobby`);
        }
      })
      .on("broadcast", { event: "host_reviewing" }, () => {
        if (!isCreatorRef.current) setHostReviewing(true);
      })
      .on("broadcast", { event: "host_review_done" }, () => {
        setHostReviewing(false);
      })
      .on("broadcast", { event: "host_transfer" }, ({ payload }) => {
        // FIX 49 — see HOST_TAKEOVER_ENABLED. Also ignores one sent by an
        // older build that still has the button.
        if (!HOST_TAKEOVER_ENABLED) {
          console.log(`[session-lobby] host_transfer ignored (takeover disabled): ${payload?.newHostId}`);
          return;
        }
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
        // Fires again on every rejoin after a dropped socket — re-track the
        // last known status rather than resetting to "waiting".
        if (status === "SUBSCRIBED") {
          await trackPresence(presenceStatusRef.current);
        }
      });

    channelRef.current = ch;

    // FIX 46 — Symptom 2 (a disconnected participant keeps showing as present
    // for the host). The presence "leave" handler above is correct, but it
    // only fires once Realtime notices the socket is gone — a clean in-app
    // navigation triggers it via this effect's own cleanup (removeChannel),
    // but killing the app or backgrounding it does not: no React unmount
    // happens, so nothing here runs, and the leave is left entirely to a
    // server-side socket timeout, which can take far longer than the 30s
    // grace this screen already shows. Untracking on background/inactive
    // makes the leave prompt instead of waited-for. No AppState listener
    // existed anywhere in this file before this round (confirmed by search).
    const appStateSub = AppState.addEventListener("change", (next) => {
      console.log(`[session-lobby] AppState -> ${next}`);
      if (next === "background" || next === "inactive") {
        ch.untrack().catch((err) => console.log("[session-lobby] untrack on background failed:", err));
      } else if (next === "active") {
        // FIX 48 — FIX 46 only ever untracked; nothing put the presence back,
        // so a participant who switched to their banking app to pay stayed
        // gone for everyone else. If the socket itself dropped meanwhile, the
        // SUBSCRIBED callback above re-tracks on rejoin instead.
        Promise.resolve(trackPresence(presenceStatusRef.current))
          .then((res) => console.log(`[session-lobby] re-track on active (${presenceStatusRef.current}): ${res ?? "no channel"}`))
          .catch((err) => console.log("[session-lobby] re-track on active failed:", err));
      }
    });

    return () => {
      graceTimers.current.forEach(clearTimeout);
      graceTimers.current.clear();
      reconnectIntervals.current.forEach(clearInterval);
      reconnectIntervals.current.clear();
      if (finalIntervalRef.current) clearInterval(finalIntervalRef.current);
      if (hostGraceTimerRef.current) clearTimeout(hostGraceTimerRef.current);
      appStateSub.remove();
      supabase.removeChannel(ch);
    };
  }, [id, myId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persistent fallback for finalization. Broadcasts can be missed on mobile networks,
  // so the host also marks the session as awaiting payment and participants poll/listen.
  useEffect(() => {
    if (!id || !myId || (String(id).startsWith("session_") || String(id).startsWith("dev_session_"))) return;

    const handleSessionStatus = (status?: string) => {
      if (status !== "awaiting_payment" || countdownStarted.current) return;
      countdownStarted.current = true;
      startFinalCountdown();
    };

    // A participant who joined before the host finished scanning has
    // receipt: null baked into their local store forever (join.tsx only
    // reads receipt_data once, at join time). Nothing else in the lobby
    // ever re-checks it, so "Select" renders an empty list even after the
    // host finishes. This channel/poll is already here for `status` — reuse
    // it to also carry the receipt across once it lands in the DB.
    //
    // FIX 47 — this used to ignore the DB whenever the store held *any*
    // receipt. Right for the host (memory is the source; the DB write may
    // still be in flight), wrong for a participant whose store holds an
    // older receipt (host re-scanned or edited it from the lobby). Now the
    // DB wins when it has changed since this screen last read it, or —
    // for non-hosts — when it differs on first read (join.tsx loaded it
    // earlier, so a difference means the DB moved on). Compared by a
    // key-sorted fingerprint because jsonb doesn't preserve key order.
    // Logged once per state change, not once per poll/event.
    const fingerprint = (v: unknown): string =>
      JSON.stringify(v, (_k, val) =>
        val && typeof val === "object" && !Array.isArray(val)
          ? Object.keys(val).sort().reduce<Record<string, unknown>>((acc, k) => {
              acc[k] = (val as Record<string, unknown>)[k];
              return acc;
            }, {})
          : val
      );
    let lastDbFingerprint: string | null = null;
    let lastReceiptLog: string | null = null;
    const logReceiptState = (state: string, msg: string) => {
      if (state === lastReceiptLog) return;
      lastReceiptLog = state;
      console.log(`[session-lobby] ${msg}`);
    };
    const handleReceiptData = (receiptData?: unknown) => {
      if (!receiptData) return;
      const sess = useSessionStore.getState().currentSession;
      if (!sess) return;
      const dbFp = fingerprint(receiptData);
      const firstRead = lastDbFingerprint === null;
      const dbChanged = !firstRead && dbFp !== lastDbFingerprint;
      lastDbFingerprint = dbFp;
      const apply = () =>
        useSessionStore.getState().setSession({ ...sess, receipt: receiptData as ParsedReceipt });

      if (!sess.receipt) {
        logReceiptState("applied-empty", "receipt_data arrived, store was empty — applying it");
        apply();
        return;
      }
      if (fingerprint(sess.receipt) === dbFp) {
        logReceiptState("in-sync", "receipt_data matches store");
        return;
      }
      const isHost = sess.creatorId === myId;
      if (dbChanged || (firstRead && !isHost)) {
        logReceiptState("applied-newer", "receipt_data in DB is newer than store — applying it");
        apply();
        return;
      }
      logReceiptState(
        "kept-local",
        "receipt_data differs from store but hasn't changed since last read — keeping local (host write pending)"
      );
    };

    // FIX 46 — this used to discard `error` entirely (`const { data } = ...`),
    // so a blocked/failed read and a genuinely-still-empty session_data both
    // looked identical: `data` undefined, nothing logged, "Select" eventually
    // shows "Session not found" with zero trail back to why. Logged once per
    // distinct failure reason (not every 2s) so a real two-device run doesn't
    // drown in repeats.
    let lastLoggedFailure: string | null = null;
    const fetchSessionStatus = async () => {
      const { data, error } = await supabase
        .from("sessions")
        .select("status, receipt_data")
        .eq("id", id)
        .single();
      if (error) {
        const reason = `${error.code ?? "?"}: ${error.message}`;
        if (reason !== lastLoggedFailure) {
          console.log(`[session-lobby] sessions read failed (id=${id}): ${reason}`);
          lastLoggedFailure = reason;
        }
        return;
      }
      lastLoggedFailure = null;
      handleSessionStatus(data?.status as string | undefined);
      handleReceiptData(data?.receipt_data);
    };

    fetchSessionStatus();
    const poll = setInterval(fetchSessionStatus, 2000);

    const statusCh = supabase
      .channel(`lobby-session-status:${id}:${Date.now()}`)
      .on("postgres_changes", {
        event: "UPDATE",
        schema: "public",
        table: "sessions",
        filter: `id=eq.${id}`,
      }, (payload) => {
        handleSessionStatus(payload.new?.status as string | undefined);
        handleReceiptData(payload.new?.receipt_data);
      })
      .subscribe((status, err) => {
        // FIX 46 — a participant this table's RLS doesn't recognise as a
        // member wouldn't necessarily see a loud error here: Realtime can
        // subscribe successfully and just never deliver a row. Logged so a
        // real two-device run shows whether the channel itself is unhappy.
        if (status !== "SUBSCRIBED") {
          console.log(`[session-lobby] sessions realtime channel status: ${status}${err ? ` (${err.message})` : ""}`);
        }
      });

    return () => {
      clearInterval(poll);
      supabase.removeChannel(statusCh);
    };
  }, [id, myId, startFinalCountdown]);

  // ── pg_changes: sync selectionDone from DB (covers missed broadcasts + host edit remounts) ──
  useEffect(() => {
    if (!id || !myId || (String(id).startsWith("session_") || String(id).startsWith("dev_session_"))) return;

    // On mount: fetch current selection status from DB so all devices stay in sync
    const fetchDoneStatus = async () => {
      const { data } = await supabase
        .from("session_participants")
        .select("user_id, selections, status")
        .eq("session_id", id);
      if (!data) return;
      const done: string[] = [];
      const selecting: string[] = [];
      const left: string[] = [];
      for (const row of data) {
        const sels = Array.isArray(row.selections) ? (row.selections as ItemSelection[]) : [];
        const status = row.status as string | undefined;
        const uid = row.user_id as string;
        const confirmed = sels.length > 0 && (status === "items_picked" || status === "joined");
        const draft = status === "selecting";
        if (status === "left") {
          left.push(uid);
          useSessionStore.getState().updateSelections(uid, sels);
          continue;
        }
        if (status === "selecting" && !(uid === myId && draft && !goingToSelectionRef.current.has(uid))) {
          selecting.push(uid);
        }
        if (confirmed) {
          done.push(row.user_id as string);
        } else if (draft) {
          setDraftSelections((prev) => {
            const next = new Map(prev);
            next.set(uid, sels);
            return next;
          });
          if (uid === myId && !goingToSelectionRef.current.has(uid)) {
            setSavedDraftIds((prev) => { const next = new Set(prev); next.add(uid); return next; });
          }
        }
        useSessionStore.getState().updateSelections(uid, sels);
      }
      setSelectionDone(new Set(done));
      setGoingToSelection(new Set(selecting));
      if (left.length > 0) {
        setLeftParticipantIds((prev) => new Set([...prev, ...left]));
      }
    };
    fetchDoneStatus();

    const pgName = `lobby-pg:${id}:${Date.now()}`;
    const pgCh = supabase
      .channel(pgName)
      .on("postgres_changes", {
        event: "INSERT",
        schema: "public",
        table: "session_participants",
        filter: `session_id=eq.${id}`,
      }, (payload) => {
        const uid = payload.new?.user_id as string | undefined;
        const status = payload.new?.status as string | undefined;
        if (!uid || uid === myId) return;
        if (status === "pending") {
          supabase
            .from("profiles")
            .select("id, name, color, avatar_icon, avatar_url")
            .eq("id", uid)
            .single()
            .then(({ data }) => {
              if (!data) return;
              setPendingParticipants((prev) => {
                const next = new Map(prev);
                next.set(uid, {
                  name: (data.name as string | null) ?? "User",
                  color: (data.color as string | null) ?? HOME_THEME.primary,
                  avatarIcon: (data.avatar_icon as string | null) ?? undefined,
                  avatarUrl: (data.avatar_url as string | null) ?? undefined,
                });
                return next;
              });
            });
        }
      })
      .on("postgres_changes", {
        event: "UPDATE",
        schema: "public",
        table: "session_participants",
        filter: `session_id=eq.${id}`,
      }, (payload) => {
        const uid = payload.new?.user_id as string | undefined;
        const sels = payload.new?.selections;
        const status = payload.new?.status as string | undefined;
        if (!uid) return;
        if (status === "selecting") {
          setSelectionDone((prev) => {
            if (!prev.has(uid)) return prev;
            const next = new Set(prev);
            next.delete(uid);
            return next;
          });
          setGoingToSelection((prev) => new Set([...prev, uid]));
        } else if (status === "joined" || status === "left") {
          setGoingToSelection((prev) => {
            const next = new Set(prev);
            next.delete(uid);
            return next;
          });
          setDraftSelections((prev) => {
            const next = new Map(prev);
            next.delete(uid);
            return next;
          });
          if (status === "left") {
            const hostId = useSessionStore.getState().currentSession?.creatorId;
            if (uid !== hostId) {
              setLeftParticipantIds((prev) => new Set([...prev, uid]));
              clearDisconnected(uid);
              setSelectionDone((prev) => {
                const next = new Set(prev);
                next.delete(uid);
                return next;
              });
            }
          }
          if (status === "joined") {
            // Remove from pending list (they've confirmed join)
            setPendingParticipants((prev) => {
              if (!prev.has(uid)) return prev;
              const next = new Map(prev);
              next.delete(uid);
              return next;
            });
            // If they were marked as "left", they've rejoined — restore them
            setLeftParticipantIds((prev) => {
              if (!prev.has(uid)) return prev;
              const next = new Set(prev);
              next.delete(uid);
              return next;
            });
            // Clear any takeover that was done on their behalf
            setTakenOver((prev) => {
              if (!prev.has(uid)) return prev;
              const next = new Map(prev);
              next.delete(uid);
              return next;
            });
            const sess = useSessionStore.getState().currentSession;
            if (sess && !sess.participants.find((pr) => pr.userId === uid)) {
              supabase
                .from("profiles")
                .select("id, name, color, avatar_icon, avatar_url, bill_credits, referral_count, is_pro")
                .eq("id", uid)
                .single()
                .then(({ data }) => {
                  if (!data) return;
                  const s = useSessionStore.getState().currentSession;
                  if (!s || s.participants.find((pr) => pr.userId === uid)) return;
                  const newP: SessionParticipant = {
                    userId: uid,
                    profile: {
                      id: uid,
                      name: (data.name as string | null) ?? "User",
                      color: (data.color as string | null) ?? HOME_THEME.primary,
                      avatarIcon: (data.avatar_icon as string | null) ?? undefined,
                      avatarUrl: (data.avatar_url as string | null) ?? undefined,
                      billCredits: (data.bill_credits as number | null) ?? 0,
                      referralCount: (data.referral_count as number | null) ?? 0,
                      isPro: (data.is_pro as boolean | null) ?? false,
                    },
                    selections: [],
                    totalOwed: 0,
                    paid: false,
                    confirmedByCreator: false,
                  };
                  useSessionStore.getState().setSession({
                    ...s,
                    participants: [...s.participants, newP],
                  });
                });
            }
          }
        }
        // null means a different column (e.g. paid) was updated — don't touch selections
        if (sels == null) return;
        if (Array.isArray(sels) && sels.length > 0) {
          const selArray = sels as ItemSelection[];
          // Update Zustand (committed) — also keep draftSelections in sync so assignedItemIds is immediate
          useSessionStore.getState().updateSelections(uid, selArray);
          if (status === "selecting") {
            // Still selecting: treat as draft so the lobby count updates before Done is pressed
            setDraftSelections((prev) => {
              const next = new Map(prev);
              next.set(uid, selArray);
              return next;
            });
          } else {
            // Done: clear draft (Zustand now has the committed selections)
            setSelectionDone((prev) => new Set([...prev, uid]));
            setGoingToSelection((prev) => {
              if (!prev.has(uid)) return prev;
              const next = new Set(prev);
              next.delete(uid);
              return next;
            });
            setDraftSelections((prev) => {
              if (!prev.has(uid)) return prev;
              const next = new Map(prev);
              next.delete(uid);
              return next;
            });
          }
        } else {
          setSelectionDone((prev) => { const n = new Set(prev); n.delete(uid); return n; });
          setDraftSelections((prev) => {
            if (!prev.has(uid)) return prev;
            const next = new Map(prev);
            next.delete(uid);
            return next;
          });
          useSessionStore.getState().updateSelections(uid, []);
        }
      })
      .subscribe();

    return () => { supabase.removeChannel(pgCh); };
  }, [id, myId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-sync selectionDone from Zustand whenever the lobby regains focus.
  // Needed for router.back() from selection screen — the mounted lobby preserves
  // its original state but Zustand was already updated by handleDone in selection.
  useFocusEffect(
    useCallback(() => {
      const sess = useSessionStore.getState().currentSession;
      if (!sess) return;

      // Immediately clear own "selecting" state — handles pressing back from selection
      // without Done. leaveSelectionToLobby updates DB; this fixes the UI race.
      const currentMyId = useAuthStore.getState().profile?.id;
      if (currentMyId) {
        setGoingToSelection((prev) => {
          if (!prev.has(currentMyId)) return prev;
          const next = new Set(prev);
          next.delete(currentMyId);
          return next;
        });
      }

      // Host returned from review screen — notify participants
      if (reviewingRef.current && isCreatorRef.current) {
        reviewingRef.current = false;
        setHostReviewing(false);
        channelRef.current?.send({ type: "broadcast", event: "host_review_done", payload: {} });
      }

      // Sync selectionDone from store for others (not myId — DB check handles my state accurately)
      const doneFromStore = new Set<string>();
      for (const p of sess.participants) {
        if (p.selections.length > 0 && p.userId !== currentMyId) doneFromStore.add(p.userId);
      }
      if (doneFromStore.size > 0) {
        setSelectionDone((prev) => new Set([...prev, ...doneFromStore]));
      }
      // IMPORTANT: do NOT clear goingToSelection here based on doneFromStore.
      // Doing so would wipe currentMyId from the ref before the async DB check below,
      // making the re-broadcast check always fail.

      // Capture the "was going to selection" flag NOW, before the async call clears the ref.
      const wasGoingToSelection = currentMyId ? goingToSelectionRef.current.has(currentMyId) : false;

      // Re-fetch from DB and use status to determine if Done or Back-draft
      syncSelectionsFromDB().then((dbSelections) => {
        const currentMyId = useAuthStore.getState().profile?.id;
        if (!currentMyId) return;

        const myDbData = dbSelections.get(currentMyId);
        const myDbSels = myDbData?.selections ?? [];
        const myStatus = myDbData?.status ?? "joined";
        // "items_picked" = Done was pressed; "joined" + sels = legacy Done; "selecting" + sels = draft Back
        const isConfirmed = myStatus === "items_picked" || (myStatus === "joined" && myDbSels.length > 0);

        if (wasGoingToSelection) {
          if (myDbSels.length > 0 && isConfirmed) {
            // Done — re-broadcast as safeguard for dropped broadcast
            useSessionStore.getState().updateSelections(currentMyId, myDbSels);
            channelRef.current?.send({
              type: "broadcast",
              event: "selection_complete",
              payload: { userId: currentMyId, selections: myDbSels },
            });
            trackPresence("done");
            setSelectionDone((prev) => new Set([...prev, currentMyId]));
            setSavedDraftIds((prev) => { const n = new Set(prev); n.delete(currentMyId); return n; });
          } else if (myStatus === "selecting") {
            // Back was pressed — set as draft, don't broadcast
            useSessionStore.getState().updateSelections(currentMyId, myDbSels);
            setSavedDraftIds((prev) => { const n = new Set(prev); n.add(currentMyId); return n; });
          }
          // Always clear goingToSelection after returning
          setGoingToSelection((prev) => { const n = new Set(prev); n.delete(currentMyId); return n; });
        }
      });

      // Re-fetch latest profiles so avatars are always current
      fetchFreshProfiles();
    }, [id, syncSelectionsFromDB, fetchFreshProfiles])
  );

  const closeConfirmedSession = useCallback(async () => {
    if (!session) return;
    const isOfflineSession = session.id.startsWith("session_") || session.id.startsWith("dev_session_");
    try {
      if (isCreator && !isOfflineSession) {
        await supabase
          .from("sessions")
          .update({ status: "closed" })
          .eq("id", session.id);
      } else if (!isCreator && !isOfflineSession && myId) {
        await supabase
          .from("session_participants")
          .update({ status: "left" })
          .eq("session_id", session.id)
          .eq("user_id", myId);
      }
    } finally {
      clearSession();
      router.replace("/(app)");
    }
  }, [clearSession, isCreator, myId, session]);

  const confirmExitSession = useCallback(() => {
    Alert.alert(
      isCreator ? t("lobby_confirm_end_title") : t("lobby_confirm_leave_title"),
      isCreator
        ? t("lobby_confirm_end_msg")
        : t("lobby_confirm_leave_msg"),
      [
        { text: t("lobby_stay"), style: "cancel" },
        {
          text: isCreator ? t("lobby_end_session") : t("lobby_leave_btn"),
          style: "destructive",
          onPress: closeConfirmedSession,
        },
      ]
    );
  }, [closeConfirmedSession, isCreator, t]);

  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
        confirmExitSession();
        return true;
      });
      return () => subscription.remove();
    }, [confirmExitSession])
  );

  // ── Share session link ────────────────────────────────────────────────────────
  const handleShare = useCallback(async () => {
    if (!id) return;
    try {
      await Share.share({
        message: `${t("lobby_share_msg")}\n${buildSessionLink(String(id))}`,
        title: t("lobby_share_title"),
      });
    } catch { /* user dismissed */ }
  }, [id]);

  // ── Actions ──────────────────────────────────────────────────────────────────

  const handleSelectMyItems = () => {
    if (!myId) return;
    trackPresence("selecting");
    channelRef.current?.send({
      type: "broadcast",
      event: "going_to_selection",
      payload: { userId: myId },
    });
    if (id && !String(id).startsWith("session_") && !String(id).startsWith("dev_session_")) {
      supabase
        .from("session_participants")
        .update({ status: "selecting" })
        .eq("session_id", id)
        .eq("user_id", myId)
        .then(() => {});
    }
    setGoingToSelection((prev) => new Set([...prev, myId]));
    router.push(`/(app)/selection/${id}?userId=${myId}&returnTo=lobby`);
  };

  // Edit: mark as "not ready" for all users, preserve selections in store but clear DB
  // Clearing DB ensures the 4s polling on other devices stops marking this user as done
  const handleEditMyItems = () => {
    if (!myId) return;
    setSelectionDone((prev) => { const n = new Set(prev); n.delete(myId); return n; });
    setGoingToSelection((prev) => new Set([...prev, myId]));
    trackPresence("selecting");
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
    if (id && !String(id).startsWith("session_") && !String(id).startsWith("dev_session_")) {
      supabase
        .from("session_participants")
        .update({ selections: [], status: "selecting" })
        .eq("session_id", id)
        .eq("user_id", myId)
        .then(() => {});
    }
    router.push(`/(app)/selection/${id}?userId=${myId}&returnTo=lobby`);
  };

  // Cancel a saved draft (Back was pressed in selection) — no broadcast needed (no one knows about draft)
  const handleCancelDraft = useCallback(async () => {
    if (!myId) return;
    setSavedDraftIds((prev) => { const n = new Set(prev); n.delete(myId); return n; });
    useSessionStore.getState().updateSelections(myId, []);
    if (id && !(String(id).startsWith("session_") || String(id).startsWith("dev_session_"))) {
      await supabase
        .from("session_participants")
        .update({ selections: [], status: "joined" })
        .eq("session_id", id)
        .eq("user_id", myId);
    }
  }, [myId, id]);

  // Edit a saved draft — keep DB selections so selection screen can pre-populate
  const handleEditDraft = () => {
    if (!myId) return;
    setSavedDraftIds((prev) => { const n = new Set(prev); n.delete(myId); return n; });
    setGoingToSelection((prev) => new Set([...prev, myId]));
    trackPresence("selecting");
    channelRef.current?.send({ type: "broadcast", event: "going_to_selection", payload: { userId: myId } });
    router.push(`/(app)/selection/${id}?userId=${myId}&returnTo=lobby`);
  };

  const handleTakeover = useCallback((targetId: string) => {
    const target = participants.find((p) => p.userId === targetId);
    Alert.alert(
      `${t("lobby_takeover_for")} ${target?.profile.name ?? "User"}?`,
      t("lobby_takeover_body"),
      [
        { text: t("cancel"), style: "cancel" },
        {
          text: t("lobby_takeover_btn"),
          onPress: () => {
            setTakenOver((prev) => new Map([...prev, [targetId, myId]]));
            setLeftParticipantIds((prev) => { const n = new Set(prev); n.delete(targetId); return n; });
            channelRef.current?.send({
              type: "broadcast",
              event: "takeover",
              payload: { targetId, takerId: myId },
            });
            channelRef.current?.send({
              type: "broadcast",
              event: "going_to_selection",
              payload: { userId: targetId },
            });
            if (id && !String(id).startsWith("session_") && !String(id).startsWith("dev_session_")) {
              supabase
                .from("session_participants")
                .update({ status: "selecting" })
                .eq("session_id", id)
                .eq("user_id", targetId)
                .then(() => {});
            }
            setGoingToSelection((prev) => new Set([...prev, targetId]));
            router.push(`/(app)/selection/${id}?userId=${targetId}&takenBy=${myId}&returnTo=lobby`);
          },
        },
      ]
    );
  }, [id, myId, participants, t]);

  const handleHostSkipTimer = (targetId: string) => {
    const target = participants.find((p) => p.userId === targetId);
    Alert.alert(
      `${t("lobby_stop_waiting_for")} ${target?.profile.name ?? "User"}?`,
      t("lobby_stop_waiting_body"),
      [
        { text: t("lobby_keep_waiting"), style: "cancel" },
        {
          text: t("lobby_stop_timer"),
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

  const handleReviewReceipt = useCallback(() => {
    reviewingRef.current = true;
    channelRef.current?.send({ type: "broadcast", event: "host_reviewing", payload: {} });
    router.push("/(app)/review?fromLobby=true");
  }, []);

  const handleFinalize = useCallback(async () => {
    if (countdownStarted.current) return;
    countdownStarted.current = true;
    await syncSelectionsFromDB();
    if (id && !String(id).startsWith("session_") && !String(id).startsWith("dev_session_")) {
      const { error } = await supabase
        .from("sessions")
        .update({ status: "awaiting_payment" })
        .eq("id", id);
      if (error) {
        console.warn("[lobby] Failed to mark session awaiting_payment:", error);
      }
    }
    channelRef.current?.send({ type: "broadcast", event: "countdown_start", payload: {} });
    startFinalCountdown();
  }, [id, startFinalCountdown, syncSelectionsFromDB]);

  const handleTakeOverAsHost = useCallback(async () => {
    if (!HOST_TAKEOVER_ENABLED) return; // FIX 49 — see the flag's comment
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
      Alert.alert(t("error"), t("lobby_take_over_error"));
    }
  }, [id, myId, session]);

  const handleSelectForFake = useCallback((fakeUserId: string) => {
    setGoingToSelection((prev) => new Set([...prev, fakeUserId]));
    channelRef.current?.send({
      type: "broadcast",
      event: "going_to_selection",
      payload: { userId: fakeUserId },
    });
    if (id && !String(id).startsWith("session_") && !String(id).startsWith("dev_session_")) {
      supabase
        .from("session_participants")
        .update({ status: "selecting" })
        .eq("session_id", id)
        .eq("user_id", fakeUserId)
        .then(() => {});
    }
    router.push(`/(app)/selection/${id}?userId=${fakeUserId}&returnTo=lobby`);
  }, [id]);

  const handleCancelReady = useCallback(async () => {
    if (!myId) return;
    setSelectionDone((prev) => {
      const next = new Set(prev);
      next.delete(myId);
      return next;
    });
    setSavedDraftIds((prev) => {
      if (!prev.has(myId)) return prev;
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
        .update({ selections: [], total_owed: 0, status: "joined" })
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
    for (const sels of draftSelections.values()) {
      for (const s of sels) ids.add(s.itemId);
    }
    return ids;
  }, [participants, draftSelections]);

  const unassignedCount = useMemo(
    () => allItems.filter((item) => !assignedItemIds.has(item.id)).length,
    [allItems, assignedItemIds]
  );

  const doneCount = participants.filter((p) => {
    if (selectionDone.has(p.userId)) return true;
    const takerId = takenOver.get(p.userId);
    return !!(takerId && selectionDone.has(takerId));
  }).length;

  // Derived: is the current user done selecting?
  const mySlotDone = useMemo(() => {
    const isDone = selectionDone.has(myId);
    const takerId = takenOver.get(myId);
    return isDone || (!!takerId && selectionDone.has(takerId));
  }, [myId, selectionDone, takenOver]);

  if (!session) {
    return (
      <SafeAreaView style={styles.safe}>
        <StatusBar style="light" backgroundColor={HOME_THEME.background} translucent={false} />
        <View style={styles.centered}>
          <Text style={styles.emptyText}>{t("session_not_found")}</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" backgroundColor={HOME_THEME.background} translucent={false} />

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={confirmExitSession}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={styles.headerBtn}
        >
          <Ionicons name="chevron-back" size={26} color={HOME_THEME.text} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {t("session_title")}
          </Text>
          <Text style={styles.headerSub}>
            {receipt?.restaurant ? `${receipt.restaurant} · ` : ""}{participants.length} {participants.length === 1 ? t("lobby_person") : t("lobby_people")}
          </Text>
        </View>
        <TouchableOpacity
          onPress={handleShare}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={styles.headerBtn}
        >
          <Ionicons name="ellipsis-horizontal" size={24} color={HOME_THEME.secondary} />
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingBottom: 148 + Math.max(insets.bottom, 16) },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Host disconnected banner ─────────────────────────────────────── */}
        {hostDisconnected && !isCreator && (
          <View style={styles.hostDisconnectedBanner}>
            <Ionicons name="wifi-outline" size={18} color={HOME_THEME.error} />
            <View style={{ flex: 1, gap: 6 }}>
              <Text style={styles.hostDisconnectedTitle}>
                {t("lobby_host_disconnected_title")}
              </Text>
              <Text style={styles.hostDisconnectedBody}>
                {t(HOST_TAKEOVER_ENABLED ? "lobby_host_disconnected_body" : "lobby_host_disconnected_body_wait")}
              </Text>
              <View style={styles.hostDisconnectedActions}>
                {HOST_TAKEOVER_ENABLED && (
                  <TouchableOpacity
                    style={styles.takeOverHostBtn}
                    onPress={handleTakeOverAsHost}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.takeOverHostBtnText}>{t("lobby_take_over_host")}</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  style={styles.leaveSessionBtn}
                  onPress={() => {
                    Alert.alert(t("session_leave"), t("lobby_leave_body"), [
                      { text: t("cancel"), style: "cancel" },
                      {
                        text: t("lobby_leave_btn"),
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
                  <Text style={styles.leaveSessionBtnText}>{t("session_leave")}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        )}

        {/* ── Receipt accordion (collapsible) ─────────────────────────────── */}
        {receipt && (
          <View style={styles.accordionCard}>
            <TouchableOpacity
              style={styles.accordionHeader}
              onPress={() => setAccordionExpanded((v) => !v)}
              activeOpacity={0.7}
            >
              <Ionicons name="document-text-outline" size={18} color={HOME_THEME.secondary} />
              <View style={styles.accordionTitleBlock}>
                <Text style={styles.accordionTitle} numberOfLines={1}>
                  {receipt.restaurant}
                </Text>
                {unassignedCount > 0 && (
                  <View style={styles.unassignedInline}>
                    <Ionicons name="warning-outline" size={13} color="#FF9500" />
                    <Text style={styles.unassignedInlineText}>
                      {unassignedCount} {unassignedCount !== 1 ? t("session_items") : t("session_item")} {t("lobby_not_selected_inline")}
                    </Text>
                  </View>
                )}
              </View>
              <Text style={styles.accordionTotal}>
                {formatCurrency(receiptTotal, receipt.currency)}
              </Text>
              <Ionicons
                name={accordionExpanded ? "chevron-up" : "chevron-down"}
                size={18}
                color={HOME_THEME.secondary}
              />
            </TouchableOpacity>

            {accordionExpanded && (
              <View style={styles.accordionBody}>
                {ORDERED_CATEGORIES.map((cat) => {
                  const rawItems = receipt.categories[cat];
                  if (rawItems.length === 0) return null;
                  const groups = groupItemsByName(rawItems);
                  return (
                    <View key={cat}>
                      <Text style={styles.catLabel}>
                        {t(CATEGORY_LABEL_KEYS[cat]).toUpperCase()}
                      </Text>
                      {groups.map((entry) => {
                        const item = entry.item;
                        const ids = entry.kind === "merged" ? entry.originalIds : [item.id];
                        const isUnassigned = ids.every((iid) => !assignedItemIds.has(iid));
                        const claimedCount = ids.filter((iid) => assignedItemIds.has(iid)).length;
                        const isMergedMulti = entry.kind === "merged" && entry.originalIds.length > 1;
                        const availableCount = ids.length - claimedCount;
                        return (
                          <View
                            key={entry.kind === "merged" ? `m_${item.id}` : item.id}
                            style={[styles.itemRow, isUnassigned && styles.itemRowUnassigned]}
                          >
                            {isUnassigned && (
                              <Ionicons name="alert-circle-outline" size={13} color="#FF9500" style={{ marginRight: 2 }} />
                            )}
                            <View style={{ flex: 1 }}>
                              <Text style={[styles.itemName, isUnassigned && { color: "#FF9500" }]} numberOfLines={1}>
                                {item.quantity > 1 ? `${item.quantity}× ` : ""}
                                {item.name}
                              </Text>
                              {isMergedMulti && (
                                <Text style={styles.itemAvail}>
                                  {availableCount} {t("lobby_of")} {ids.length} {t("lobby_available")}
                                </Text>
                              )}
                            </View>
                            <Text style={styles.itemPrice}>
                              {formatCurrency(item.unitPrice, receipt.currency)}
                            </Text>
                          </View>
                        );
                      })}
                    </View>
                  );
                })}
                {receipt.globalCosts.map((cost) => (
                  <View key={cost.id ?? cost.name} style={styles.itemRow}>
                    <Text style={styles.itemName}>{cost.name}</Text>
                    <Text style={styles.itemPrice}>
                      {formatCurrency(cost.amount, receipt.currency)}
                    </Text>
                  </View>
                ))}
                {(receipt.selectedTip ?? 0) > 0 && (
                  <View style={styles.itemRow}>
                    <Text style={styles.itemName}>{t("review_tip")}</Text>
                    <Text style={styles.itemPrice}>
                      {formatCurrency(receipt.selectedTip!, receipt.currency)}
                    </Text>
                  </View>
                )}
              </View>
            )}
          </View>
        )}

        {/* ── Invite card ──────────────────────────────────────────────────── */}
        <View style={styles.inviteCard}>
          <TouchableOpacity style={styles.qrWrapper} onPress={() => setQrExpanded(true)} activeOpacity={0.8}>
            <QRGenerator value={buildSessionLink(String(id))} size={80} />
          </TouchableOpacity>
          <View style={styles.inviteCopy}>
            <Text style={styles.inviteTitle}>{t("lobby_invite_title")}</Text>
            <Text style={styles.inviteSub}>{t("lobby_invite_sub")}</Text>
            <TouchableOpacity style={styles.shareLink} onPress={handleShare} activeOpacity={0.7}>
              <Ionicons name="share-outline" size={14} color={HOME_THEME.primary} />
              <Text style={styles.shareLinkText}>{t("lobby_share_link")}</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* ── Participants section ─────────────────────────────────────────── */}
        <Text style={styles.sectionLabel}>
          {t("lobby_participants_label")} ({participants.length})
        </Text>

        {visibleParticipants.map((p) => {
          const participantColor = p.profile.color;
          const isDone = selectionDone.has(p.userId);
          const isDisconnected = disconnectedAt.has(p.userId);
          const isLeft = leftParticipantIds.has(p.userId);
          const isTakenOver = takenOver.has(p.userId);
          const takerId = takenOver.get(p.userId);
          const takerName =
            participants.find((pp) => pp.userId === takerId)?.profile.name ?? t("lobby_someone");
          const secsLeft = reconnectLeft.get(p.userId) ?? RECONNECT_SECONDS;
          const expired = timerExpired.has(p.userId);
          const isMe = p.userId === myId;
          const slotDone = isDone || (isTakenOver && !!takerId && selectionDone.has(takerId));
          const hasDraft = isMe && savedDraftIds.has(p.userId) && !slotDone;
          const isSelecting = goingToSelection.has(p.userId) && !slotDone && !hasDraft;
          const hasSelectionsAfterLeaving = isLeft && p.selections.length > 0;

          return (
            <View
              key={p.userId}
              style={[
                styles.participantCard,
                {
                  borderColor: (isDisconnected && !isTakenOver) || isLeft
                    ? HOME_THEME.border
                    : participantColor + "66",
                },
                ((isDisconnected && !isTakenOver) || isLeft) && styles.participantFaded,
              ]}
            >
              {/* Left accent bar */}
              <View
                style={[
                  styles.participantAccent,
                  {
                    backgroundColor: (isDisconnected && !isTakenOver) || isLeft
                      ? HOME_THEME.secondary
                      : participantColor,
                  },
                ]}
              />

              {/* Avatar with colored ring */}
              <View style={[styles.avatarColorRing, { borderColor: isLeft ? HOME_THEME.secondary : participantColor }]}>
                <Avatar
                  key={`${p.userId}-${participantColor}`}
                  name={p.profile.name}
                  avatarIcon={
                    isMe
                      ? (profile?.avatarIcon ?? freshProfiles.get(p.userId)?.avatarIcon ?? p.profile.avatarIcon)
                      : (freshProfiles.get(p.userId)?.avatarIcon ?? p.profile.avatarIcon)
                  }
                  avatarUrl={(() => {
                    const http = (u?: string) => (u && u.startsWith("http") ? u : undefined);
                    return isMe
                      ? (http(profile?.avatarUrl) ?? freshProfiles.get(p.userId)?.avatarUrl ?? http(p.profile.avatarUrl))
                      : (freshProfiles.get(p.userId)?.avatarUrl ?? http(p.profile.avatarUrl));
                  })()}
                  color={isLeft ? HOME_THEME.secondary : participantColor}
                  size={36}
                />
              </View>

              {/* Name + status */}
              <View style={styles.participantInfo}>
                <View style={styles.nameRow}>
                  <Text style={styles.participantName} numberOfLines={1}>
                    {p.profile.name}{isMe ? t("lobby_you") : ""}
                  </Text>
                  {p.userId === session.creatorId && (
                    <View style={styles.hostBadge}>
                      <Text style={styles.hostBadgeText}>{t("session_host_badge")}</Text>
                    </View>
                  )}
                </View>

                {isLeft ? (
                  <View style={styles.doneRow}>
                    <Ionicons name="exit-outline" size={14} color={HOME_THEME.error} />
                    <Text style={[styles.statusText, { color: HOME_THEME.error }]}>
                      {t("lobby_left_rejoin")}
                    </Text>
                  </View>
                ) : isDisconnected && !isTakenOver ? (
                  expired ? (
                    <Text style={[styles.statusText, { color: HOME_THEME.error }]}>
                      {t("lobby_disconnected")}
                    </Text>
                  ) : (
                    <Text style={[styles.statusText, { color: HOME_THEME.warning }]}>
                      {t("lobby_disconnected")} · {formatTime(secsLeft)} {t("lobby_reconnect_suffix")}
                    </Text>
                  )
                ) : isTakenOver ? (
                  <Text style={[styles.statusText, { color: HOME_THEME.primary }]}>
                    🤝 {takerName} {t("lobby_selecting_for")}
                  </Text>
                ) : isSelecting ? (
                  isMe ? (
                    <Text style={[styles.statusText, { color: HOME_THEME.primary }]}>
                      {t("lobby_selecting_mine_dots")}
                    </Text>
                  ) : (
                    <View style={styles.doneRow}>
                      <ActivityIndicator size="small" color={HOME_THEME.primary} style={{ marginRight: 2 }} />
                      <Text style={[styles.statusText, { color: HOME_THEME.primary }]}>
                        {t("lobby_selecting_theirs_dots")}
                      </Text>
                    </View>
                  )
                ) : hasDraft ? (
                  <View style={styles.doneRow}>
                    <Ionicons name="create-outline" size={14} color={HOME_THEME.primary} />
                    <Text style={[styles.statusText, { color: HOME_THEME.primary }]}>
                      {t("lobby_selecting_mine")}
                    </Text>
                  </View>
                ) : slotDone ? (
                  <View style={styles.doneRow}>
                    <Ionicons name="checkmark-circle" size={14} color={HOME_THEME.success} />
                    <Text style={[styles.statusText, { color: HOME_THEME.success }]}>
                      {t("lobby_items_picked")}
                    </Text>
                  </View>
                ) : (
                  <Text style={styles.statusText}>
                    {isMe ? t("lobby_selecting_mine") : t("lobby_selecting_theirs")}
                  </Text>
                )}
              </View>

              {/* Right-side actions */}
              {isLeft ? (
                hasSelectionsAfterLeaving ? (
                  <TouchableOpacity
                    style={[styles.takeoverBtn, { borderColor: HOME_THEME.primary }]}
                    onPress={() => handleTakeover(p.userId)}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.takeoverBtnText}>🤝 {t("lobby_take_over_short")}</Text>
                  </TouchableOpacity>
                ) : null
              ) : isDisconnected && !isTakenOver ? (
                <View style={styles.actionCol}>
                  {isCreator && !expired && (
                    <TouchableOpacity
                      style={[styles.skipBtn, { borderColor: HOME_THEME.warning }]}
                      onPress={() => handleHostSkipTimer(p.userId)}
                      activeOpacity={0.7}
                    >
                      <Text style={[styles.skipBtnText, { color: HOME_THEME.warning }]}>
                        {t("lobby_skip")}
                      </Text>
                    </TouchableOpacity>
                  )}
                  {expired && (
                    <TouchableOpacity
                      style={[styles.takeoverBtn, { borderColor: HOME_THEME.primary }]}
                      onPress={() => handleTakeover(p.userId)}
                      activeOpacity={0.7}
                    >
                      <Text style={styles.takeoverBtnText}>🤝 {t("lobby_take_over_short")}</Text>
                    </TouchableOpacity>
                  )}
                </View>
              ) : isSelecting ? (
                isMe ? <ActivityIndicator size="small" color={HOME_THEME.primary} /> : null
              ) : hasDraft ? (
                <View style={styles.doneActions}>
                  <TouchableOpacity
                    style={styles.cancelReadyBtn}
                    onPress={handleCancelDraft}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.cancelReadyText}>{t("cancel")}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.editBtn}
                    onPress={handleEditDraft}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.editBtnText}>{t("session_edit")}</Text>
                  </TouchableOpacity>
                </View>
              ) : isMe && !slotDone ? (
                <TouchableOpacity
                  style={styles.selectBtn}
                  onPress={handleSelectMyItems}
                  activeOpacity={0.8}
                >
                  <Text style={styles.selectBtnText}>{t("session_select")}</Text>
                </TouchableOpacity>
              ) : isMe && slotDone ? (
                <View style={styles.doneActions}>
                  <TouchableOpacity
                    style={styles.cancelReadyBtn}
                    onPress={handleCancelReady}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.cancelReadyText}>{t("cancel")}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.editBtn}
                    onPress={handleEditMyItems}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.editBtnText}>{t("session_edit")}</Text>
                  </TouchableOpacity>
                </View>
              ) : slotDone ? (
                <TouchableOpacity
                  style={styles.viewSelBtn}
                  onPress={() => setViewSelectionUserId(p.userId)}
                  activeOpacity={0.8}
                >
                  <Text style={styles.viewSelBtnText}>{t("lobby_view")}</Text>
                </TouchableOpacity>
              ) : isDev && (p.userId.startsWith("test_") || p.userId.startsWith("dev_")) && receipt ? (
                <TouchableOpacity
                  style={styles.selectBtn}
                  onPress={() => handleSelectForFake(p.userId)}
                  activeOpacity={0.8}
                >
                  <Text style={styles.selectBtnText}>{t("session_select")}</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          );
        })}

        {/* ── Pending (scanned QR, not yet confirmed) ─────────────────────── */}
        {Array.from(pendingParticipants.entries()).map(([uid, p]) => (
          <View
            key={`pending-${uid}`}
            style={[styles.participantCard, { borderColor: HOME_THEME.border, opacity: 0.65 }]}
          >
            <View style={[styles.participantAccent, { backgroundColor: HOME_THEME.secondary }]} />
            <View style={[styles.avatarColorRing, { borderColor: HOME_THEME.secondary }]}>
              <Avatar name={p.name} avatarIcon={p.avatarIcon} avatarUrl={p.avatarUrl} color={p.color} size={36} />
            </View>
            <View style={styles.participantInfo}>
              <Text style={styles.participantName}>{p.name}</Text>
              <View style={styles.doneRow}>
                <ActivityIndicator size="small" color={HOME_THEME.secondary} style={{ marginRight: 2 }} />
                <Text style={[styles.statusText, { color: HOME_THEME.secondary }]}>{t("lobby_joining")}</Text>
              </View>
            </View>
          </View>
        ))}

        {/* ── Progress card ─────────────────────────────────────────────────── */}
        <View style={styles.progressCard}>
          <View style={styles.progressHeader}>
            <Ionicons
              name={allDone ? "checkmark-circle" : "time-outline"}
              size={17}
              color={allDone ? HOME_THEME.success : HOME_THEME.secondary}
            />
            <Text style={[styles.progressText, { color: allDone ? HOME_THEME.success : HOME_THEME.secondary }]}>
              {allDone
                ? t("lobby_everyones_ready")
                : `${doneCount} ${t("lobby_of")} ${participants.length} ${t("lobby_picked")}`}
            </Text>
          </View>
          <View style={styles.progressBarBg}>
            <View
              style={[
                styles.progressBarFill,
                {
                  backgroundColor: allDone ? HOME_THEME.success : HOME_THEME.primary,
                  width: `${participants.length > 0 ? (doneCount / participants.length) * 100 : 0}%` as any,
                },
              ]}
            />
          </View>
        </View>

      </ScrollView>

      {/* ── Fixed bottom CTA ─────────────────────────────────────────────── */}
      <View style={[styles.bottomCta, { paddingBottom: Math.max(insets.bottom, 16) }]}>
        <View style={styles.bottomHint}>
          <Ionicons name="receipt-outline" size={22} color={HOME_THEME.secondary} />
          <View style={{ flex: 1 }}>
            <Text style={styles.hintTitle}>
              {allDone ? t("lobby_everyones_ready") : t("lobby_finalize_split")}
            </Text>
            <Text style={styles.hintSub}>
              {allDone ? t("lobby_picked") : t("lobby_of") + " " + participants.length + " " + t("lobby_picked")}
            </Text>
          </View>
          <Text style={[styles.hintCount, { color: allDone ? HOME_THEME.success : HOME_THEME.secondary }]}>
            {doneCount}/{participants.length}
          </Text>
        </View>
        {isCreator ? (
          <View style={{ gap: 8 }}>
            <TouchableOpacity
              style={[
                styles.ctaBtn,
                (!allDone || finalCountdown !== null) && { opacity: 0.4 },
              ]}
              onPress={handleFinalize}
              disabled={!allDone || finalCountdown !== null}
              activeOpacity={0.85}
            >
              <Text style={styles.ctaBtnText}>{t("lobby_finalize_split")}</Text>
              <Ionicons name="arrow-forward" size={18} color="#fff" />
            </TouchableOpacity>
            {!allDone && (
              <Text style={{ color: HOME_THEME.secondary, fontSize: 12, textAlign: "center" }}>
                {t("lobby_waiting_items")}
              </Text>
            )}
            <TouchableOpacity
              style={styles.reviewReceiptBtn}
              onPress={handleReviewReceipt}
              activeOpacity={0.8}
            >
              <Ionicons name="receipt-outline" size={16} color={HOME_THEME.secondary} />
              <Text style={styles.reviewReceiptBtnText}>{t("lobby_review_receipt")}</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.ctaWaiting}>
            <ActivityIndicator size="small" color={HOME_THEME.secondary} />
            <Text style={styles.ctaWaitingText}>{t("lobby_waiting_host")}</Text>
          </View>
        )}
      </View>

      {/* ── Ver seleção de participante confirmado ─────────────────────────── */}
      {(() => {
        const viewP = viewSelectionUserId ? participants.find((p) => p.userId === viewSelectionUserId) : null;
        if (!viewP) return null;
        const viewItems = viewP.selections.map((sel) => {
          const item = allItems.find((i) => i.id === sel.itemId);
          return item ? { item, qty: sel.quantity } : null;
        }).filter(Boolean) as { item: (typeof allItems)[0]; qty: number }[];
        return (
          <Modal visible={!!viewSelectionUserId} transparent animationType="slide" onRequestClose={() => setViewSelectionUserId(null)}>
            <TouchableOpacity style={styles.viewSelOverlay} activeOpacity={1} onPress={() => setViewSelectionUserId(null)} />
            <View style={[styles.viewSelSheet, { paddingBottom: insets.bottom + 16 }]}>
              <View style={styles.sheetHandle} />
              <View style={styles.viewSelHeader}>
                <Avatar name={viewP.profile.name} avatarIcon={viewP.profile.avatarIcon} avatarUrl={viewP.profile.avatarUrl} color={viewP.profile.color} size={36} />
                <Text style={styles.viewSelName}>{viewP.profile.name}</Text>
                <TouchableOpacity onPress={() => setViewSelectionUserId(null)}>
                  <Ionicons name="close" size={22} color={HOME_THEME.secondary} />
                </TouchableOpacity>
              </View>
              <ScrollView style={{ maxHeight: 380 }} contentContainerStyle={{ gap: 4 }}>
                {viewItems.length === 0 ? (
                  <Text style={[styles.statusText, { textAlign: "center", padding: 20 }]}>{t("lobby_no_items")}</Text>
                ) : viewItems.map(({ item, qty }) => (
                  <View key={item.id} style={styles.viewSelItem}>
                    <Text style={styles.viewSelItemName} numberOfLines={1}>
                      {qty > 1 ? `${qty}× ` : ""}{item.name}
                    </Text>
                    <Text style={[styles.viewSelItemPrice, { color: viewP.profile.color ?? HOME_THEME.primary }]}>
                      {formatCurrency(item.unitPrice * qty, receipt?.currency as "EUR")}
                    </Text>
                  </View>
                ))}
              </ScrollView>
            </View>
          </Modal>
        );
      })()}

      {/* ── Host reviewing overlay (non-host participants) ─────────────────── */}
      <Modal visible={hostReviewing && !isCreator} transparent animationType="fade">
        <View style={styles.reviewingOverlay}>
          <View style={styles.reviewingCard}>
            <ActivityIndicator size="large" color={HOME_THEME.primary} />
            <Text style={styles.reviewingTitle}>{t("lobby_host_reviewing_title")}</Text>
            <Text style={styles.reviewingBody}>{t("lobby_host_reviewing_body")}</Text>
          </View>
        </View>
      </Modal>

      <Modal visible={qrExpanded} transparent animationType="fade" onRequestClose={() => setQrExpanded(false)}>
        <TouchableOpacity style={styles.qrModalOverlay} onPress={() => setQrExpanded(false)} activeOpacity={1}>
          <View style={styles.qrModalCard}>
            <QRGenerator value={buildSessionLink(String(id))} size={260} />
            <Text style={styles.qrModalHint}>{t("lobby_tap_to_close")}</Text>
          </View>
        </TouchableOpacity>
      </Modal>

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
  safe: { flex: 1, backgroundColor: HOME_THEME.background },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  emptyText: { fontSize: 16, color: HOME_THEME.secondary },

  // ── Header ────────────────────────────────────────────────────────────────────
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  headerBtn: { width: 38, alignItems: "center", justifyContent: "center" },
  headerCenter: { flex: 1, alignItems: "center", gap: 2 },
  headerTitle: { fontSize: 17, fontWeight: "700", color: HOME_THEME.text, textAlign: "center" },
  headerSub: { fontSize: 12, color: HOME_THEME.secondary, textAlign: "center" },
  scroll: { paddingHorizontal: 20, paddingTop: 8, gap: 12 },

  // ── QR invite card ────────────────────────────────────────────────────────────
  inviteCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: HOME_THEME.card,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: HOME_THEME.border,
    padding: 16,
    gap: 16,
  },
  inviteCopy: { flex: 1, gap: 4 },
  inviteTitle: { fontSize: 15, fontWeight: "700", color: HOME_THEME.text },
  inviteSub: { fontSize: 12, color: HOME_THEME.secondary },
  shareLink: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 6 },
  shareLinkText: { fontSize: 12, fontWeight: "600", color: HOME_THEME.primary },
  qrWrapper: { borderRadius: 10, overflow: "hidden" },

  // ── Accordion ─────────────────────────────────────────────────────────────────
  accordionCard: {
    backgroundColor: HOME_THEME.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: HOME_THEME.border,
    borderRadius: 16,
    overflow: "hidden",
  },
  accordionHeader: { flexDirection: "row", alignItems: "center", padding: 16, gap: 10 },
  accordionTitleBlock: { flex: 1, gap: 5 },
  accordionTitle: { fontSize: 15, fontWeight: "600", color: HOME_THEME.text },
  unassignedInline: { flexDirection: "row", alignItems: "center", gap: 5 },
  unassignedInlineText: { color: "#FF9500", fontSize: 11, fontWeight: "600", flex: 1 },
  accordionTotal: { fontSize: 15, fontWeight: "700", color: HOME_THEME.text },
  accordionBody: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: HOME_THEME.border },
  catLabel: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 4,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.5,
    color: HOME_THEME.secondary,
  },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: HOME_THEME.border,
    gap: 8,
  },
  itemRowUnassigned: { backgroundColor: "#FF950012" },
  itemName: { fontSize: 13, fontWeight: "500", color: HOME_THEME.text, flex: 1 },
  itemAvail: { fontSize: 11, fontStyle: "italic", marginTop: 1, color: HOME_THEME.secondary },
  itemPrice: { fontSize: 13, fontWeight: "600", color: HOME_THEME.text },

  // ── Section label ─────────────────────────────────────────────────────────────
  sectionLabel: {
    fontSize: 15,
    fontWeight: "700",
    color: HOME_THEME.text,
    marginBottom: 4,
  },

  // ── Participant cards (PickandPay style) ──────────────────────────────────────
  participantCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: HOME_THEME.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    minHeight: 68,
    paddingRight: 12,
    gap: 10,
    overflow: "hidden",
  },
  participantFaded: { opacity: 0.6 },
  participantAccent: { width: 3, alignSelf: "stretch" },
  avatarColorRing: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 2,
  },
  participantInfo: { flex: 1, gap: 3 },
  nameRow: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  participantName: { fontSize: 15, fontWeight: "600", color: HOME_THEME.text, flexShrink: 1 },
  hostBadge: {
    backgroundColor: HOME_THEME.primary + "33",
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 5,
  },
  hostBadgeText: { color: HOME_THEME.primary, fontSize: 10, fontWeight: "600" },
  statusText: { fontSize: 12, fontWeight: "500", color: HOME_THEME.secondary },
  doneRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  actionCol: { gap: 6, alignItems: "flex-end" },

  // ── In-card action buttons ────────────────────────────────────────────────────
  selectBtn: {
    backgroundColor: HOME_THEME.primary,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    minWidth: 80,
    alignItems: "center",
  },
  selectBtnText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  doneActions: { flexDirection: "row", gap: 6, alignItems: "center" },
  cancelReadyBtn: {
    borderWidth: 1,
    borderColor: "#EF444466",
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: "center",
  },
  cancelReadyText: { color: "#EF4444", fontWeight: "600", fontSize: 12 },
  editBtn: {
    borderWidth: 1,
    borderColor: HOME_THEME.border,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    minWidth: 50,
    alignItems: "center",
  },
  editBtnText: { fontWeight: "600", fontSize: 13, color: HOME_THEME.secondary },

  // ── View selection button (others' confirmed selections) ──────────────────────
  viewSelBtn: {
    backgroundColor: HOME_THEME.primary + "22",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: HOME_THEME.primary + "55",
  },
  viewSelBtnText: { fontWeight: "700", fontSize: 12, color: HOME_THEME.primary },
  // View selection modal
  viewSelOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.5)" },
  viewSelSheet: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: HOME_THEME.card,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 12,
    paddingHorizontal: 16,
  },
  sheetHandle: { width: 36, height: 4, borderRadius: 2, backgroundColor: HOME_THEME.border, alignSelf: "center", marginBottom: 14 },
  viewSelHeader: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 12 },
  viewSelName: { flex: 1, fontSize: 16, fontWeight: "700", color: HOME_THEME.text },
  viewSelItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: HOME_THEME.border,
  },
  viewSelItemName: { flex: 1, fontSize: 14, color: HOME_THEME.text, marginRight: 8 },
  viewSelItemPrice: { fontSize: 14, fontWeight: "600" },

  // ── Skip / takeover buttons ───────────────────────────────────────────────────
  skipBtn: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  skipBtnText: { fontSize: 11, fontWeight: "600" },
  takeoverBtn: { borderWidth: 1.5, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  takeoverBtnText: { color: HOME_THEME.primary, fontSize: 12, fontWeight: "700" },

  // ── Progress card ─────────────────────────────────────────────────────────────
  progressCard: {
    backgroundColor: HOME_THEME.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: HOME_THEME.border,
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
    backgroundColor: HOME_THEME.border,
  },
  progressBarFill: { height: 4, borderRadius: 2 },

  reviewReceiptBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
  },
  reviewReceiptBtnText: {
    color: HOME_THEME.secondary,
    fontSize: 13,
    fontWeight: "600",
  },
  reviewingOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.75)",
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
  },
  reviewingCard: {
    backgroundColor: HOME_THEME.card,
    borderRadius: 20,
    padding: 32,
    alignItems: "center",
    gap: 16,
    width: "100%",
    maxWidth: 340,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: HOME_THEME.border,
  },
  reviewingTitle: {
    color: HOME_THEME.text,
    fontSize: 17,
    fontWeight: "700",
    textAlign: "center",
  },
  reviewingBody: {
    color: HOME_THEME.secondary,
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
  },

  // ── QR expanded modal ─────────────────────────────────────────────────────────
  qrModalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.85)",
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
  },
  qrModalCard: {
    backgroundColor: "#fff",
    borderRadius: 20,
    padding: 24,
    alignItems: "center",
    gap: 16,
  },
  qrModalHint: {
    fontSize: 13,
    color: HOME_THEME.secondary,
    fontWeight: "500",
  },

  // ── Finalize button ───────────────────────────────────────────────────────────
  finalizeBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: HOME_THEME.primary,
    paddingVertical: 16,
    borderRadius: 16,
    gap: 10,
  },
  finalizeBtnText: { color: "#fff", fontSize: 16, fontWeight: "700" },

  // ── Fixed bottom CTA ─────────────────────────────────────────────────────────
  bottomCta: {
    backgroundColor: HOME_THEME.background,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: HOME_THEME.border,
    paddingHorizontal: 20,
    paddingTop: 14,
    gap: 10,
  },
  bottomHint: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  hintTitle: {
    fontSize: 14,
    fontWeight: "600",
    color: HOME_THEME.text,
  },
  hintSub: {
    fontSize: 12,
    color: HOME_THEME.secondary,
    marginTop: 1,
  },
  hintCount: {
    fontSize: 15,
    fontWeight: "700",
  },
  ctaBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: HOME_THEME.primary,
    paddingVertical: 16,
    borderRadius: 16,
    gap: 10,
  },
  ctaBtnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
  ctaWaiting: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingVertical: 14,
  },
  ctaWaitingText: {
    color: HOME_THEME.secondary,
    fontSize: 14,
    fontWeight: "500",
  },

  // ── Host disconnected banner ──────────────────────────────────────────────────
  hostDisconnectedBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: HOME_THEME.error + "66",
    backgroundColor: HOME_THEME.error + "18",
  },
  hostDisconnectedTitle: { fontSize: 14, fontWeight: "700", color: HOME_THEME.text },
  hostDisconnectedBody: { fontSize: 13, lineHeight: 18, color: HOME_THEME.secondary },
  hostDisconnectedActions: { flexDirection: "row", gap: 8, marginTop: 2 },
  takeOverHostBtn: {
    backgroundColor: HOME_THEME.primary,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  takeOverHostBtnText: { color: "#fff", fontSize: 13, fontWeight: "700" },
  leaveSessionBtn: {
    borderWidth: 1,
    borderColor: HOME_THEME.border,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  leaveSessionBtnText: { fontSize: 13, fontWeight: "600", color: HOME_THEME.secondary },
});
