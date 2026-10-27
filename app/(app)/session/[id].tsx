import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  useColorScheme,
  Alert,
  Share,
  Modal,
  useWindowDimensions,
  Animated,
  BackHandler,
  ActivityIndicator,
  PanResponder,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useLocalSearchParams, Stack } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "@/constants/colors";
import { useSessionStore } from "@/store/sessionStore";
import { useAuthStore } from "@/store/authStore";
import { QRGenerator } from "@/components/session/QRGenerator";
import { Card } from "@/components/ui/Card";
import { Avatar } from "@/components/ui/Avatar";
import { TestModeBar } from "@/components/dev/TestModeBar";
import { UserProfile, ReceiptItem, SessionParticipant } from "@/types";
import { getColorForUser } from "@/constants/colors";
import { formatCurrency, formatDate } from "@/utils/formatter";
import { buildSessionLink, buildSessionShareText } from "@/lib/deeplink";
import { supabase } from "@/lib/supabase";
import { isDeveloperUser } from "@/constants/dev";
import { useI18nStore } from "@/store/i18nStore";

const ORDERED_CATEGORIES = [
  "starters",
  "mains",
  "drinks",
  "desserts",
  "others",
] as const;

const CATEGORY_LABELS: Record<string, string> = {
  starters: "Starters",
  mains: "Mains",
  drinks: "Drinks",
  desserts: "Desserts",
  others: "Others",
};

const FUN_FACTS = [
  "On average, splitting a bill manually takes 4× longer than using an app. You're already ahead!",
  "In Japan, it's common for everyone to pay exactly their share — down to the cent.",
  "Groups of 4+ people leave 18% larger tips on average when splitting evenly.",
  "The most argued-about item at group dinners? Drinks. Every single time.",
  "In France, asking for separate bills is considered a bit rude. Thank goodness for Pick&Pay.",
  "People are 3× more likely to order dessert when they know the bill is being split.",
  "The average group dinner has at least one person who 'forgot their wallet.' Be the hero.",
  "Fun fact: Dutch courage has nothing to do with splitting bills, but 'going Dutch' does.",
];

export default function SessionScreen() {
  const { id, redirectToSelection } = useLocalSearchParams<{ id: string; redirectToSelection?: string }>();
  const isDark = useColorScheme() === "dark";
  const { width } = useWindowDimensions();
  const {
    currentSession,
    updateSelections,
    recalculateSplit,
    addParticipant,
    removeParticipant,
    clearSession,
    setSession,
  } = useSessionStore();
  const { profile } = useAuthStore();
  const { t, language } = useI18nStore();
  void language;
  const insets = useSafeAreaInsets();

  const [testActiveProfile, setTestActiveProfile] = useState<UserProfile | null>(null);
  const [unassignedModalVisible, setUnassignedModalVisible] = useState(false);
  const [itemAssignments, setItemAssignments] = useState<Map<string, string>>(new Map());
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const [sessionLocked, setSessionLocked] = useState(false);
  const [takeoverTarget, setTakeoverTarget] = useState<string | null>(null);
  // Tracks participants who scanned QR but haven't pressed "Join Split" yet
  const [pendingUserIds, setPendingUserIds] = useState<Set<string>>(new Set());
  // Tracks participants who have left the session
  const [leftUserIds, setLeftUserIds] = useState<Set<string>>(new Set());
  // Fun-facts cycling index shown to participants while waiting for host to scan
  const [factIndex, setFactIndex] = useState(0);
  const [qrExpanded, setQrExpanded] = useState(false);

  const rotateAnim = useRef(new Animated.Value(0)).current;

  const factPanRef = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gs) => Math.abs(gs.dx) > 8,
      onPanResponderRelease: (_, gs) => {
        if (gs.dx < -50) setFactIndex((i) => (i + 1) % FUN_FACTS.length);
        else if (gs.dx > 50) setFactIndex((i) => (i - 1 + FUN_FACTS.length) % FUN_FACTS.length);
      },
    })
  ).current;
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  // Kept in sync every render so stale broadcast closures can read latest value
  const isCreatorRef = useRef(false);
  // Holds a receipt that needs to be broadcast as soon as bcChannel subscribes
  const pendingReceiptBroadcastRef = useRef<any>(null);
  // True once the current bcChannel has reached SUBSCRIBED state
  const bcSubscribedRef = useRef(false);
  // Prevents double-navigation when both pg_changes and receipt_ready fire
  const navigatingToLobbyRef = useRef(false);

  useEffect(() => {
    if (!sessionLocked) {
      const anim = Animated.loop(
        Animated.timing(rotateAnim, {
          toValue: 1,
          duration: 2000,
          useNativeDriver: true,
        })
      );
      anim.start();
      return () => anim.stop();
    }
  }, [sessionLocked]);

  const hourglassRotate = rotateAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"],
  });

  const effectiveProfile = testActiveProfile ?? profile;
  // Permissions always use the real profile — TestModeBar only changes view perspective
  const realProfile = profile;
  const session = currentSession;
  const receipt = session?.receipt;
  const isCreator = session?.creatorId === realProfile?.id;
  isCreatorRef.current = isCreator; // keep ref in sync every render

  // Cycle fun facts every 5s while participant waits for host to scan
  useEffect(() => {
    if (!sessionLocked || receipt || isCreator) return;
    const interval = setInterval(() => {
      setFactIndex((i) => (i + 1) % FUN_FACTS.length);
    }, 5000);
    return () => clearInterval(interval);
  }, [sessionLocked, receipt, isCreator]);

  const textColor = isDark ? Colors.textPrimaryDark : Colors.textPrimaryLight;
  const mutedColor = isDark ? Colors.textMutedDark : Colors.textMutedLight;
  const bgColor = isDark ? Colors.bgDark : Colors.bgLight;
  const borderColor = isDark ? Colors.cardBorderDark : Colors.cardBorderLight;
  const cardColor = isDark ? Colors.cardDark : Colors.cardLight;

  // Recalculate split each time the screen comes into focus (handles back-navigation)
  useFocusEffect(
    useCallback(() => {
      recalculateSplit();
      // When host returns with a receipt, notify all participants and persist to Supabase
      if (isCreator && receipt && id && !String(id).startsWith("session_")) {
        supabase.from("sessions").update({ receipt_data: receipt }).eq("id", id).then(() => {});
        if (bcSubscribedRef.current && channelRef.current) {
          // Channel is already subscribed — send immediately
          channelRef.current.send({
            type: "broadcast",
            event: "receipt_ready",
            payload: { receipt },
          });
        } else {
          // Channel is still subscribing — queue and send from subscribe callback
          pendingReceiptBroadcastRef.current = receipt;
        }
      }
    }, [recalculateSplit, isCreator, receipt, id])
  );

  // Intercept Android hardware back button (pre-receipt: shows End Session? alert)
  useEffect(() => {
    if (receipt) return; // post-receipt case handled by confirmExitConfirmedSession useFocusEffect
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      handleHostBack();
      return true;
    });
    return () => sub.remove();
  }, [receipt, isCreator]); // eslint-disable-line react-hooks/exhaustive-deps

  // Real-time subscription: watch for new participants joining via QR
  useEffect(() => {
    if (!id || id.startsWith("session_")) return;

    // --- postgres_changes channel (unique per mount to avoid "after subscribed" error) ---
    // A pending row arrives as an INSERT, or as an UPDATE → pending when a
    // cancelled row is reused by a second scan.
    const onPendingRow = async (newUserId: string) => {
      console.log("[session] New participant joining:", newUserId);

      const already = useSessionStore.getState().currentSession?.participants.find(
        (p) => p.userId === newUserId
      );
      if (already) return;

      // Mark as pending (scanned but not yet confirmed)
      setPendingUserIds((prev) => new Set([...prev, newUserId]));

      const { data: p } = await supabase
        .from("profiles")
        .select("id, name, color, avatar_icon, avatar_url, bill_credits, referral_count, is_pro")
        .eq("id", newUserId)
        .single();

      const newParticipant: SessionParticipant = {
        userId: newUserId,
        profile: p
          ? {
              id: p.id,
              name: p.name ?? "User",
              color: p.color ?? getColorForUser(newUserId),
              avatarIcon: p.avatar_icon ?? undefined,
              avatarUrl: p.avatar_url ?? undefined,
              billCredits: p.bill_credits ?? 0,
              referralCount: p.referral_count ?? 0,
              isPro: p.is_pro ?? false,
            }
          : {
              id: newUserId,
              name: "User",
              color: getColorForUser(newUserId),
              billCredits: 0,
              referralCount: 0,
              isPro: false,
            },
        selections: [],
        totalOwed: 0,
        paid: false,
        confirmedByCreator: false,
      };

      addParticipant(newParticipant);
    };

    const pgChannelName = `sp-pg:${id}:${Date.now()}`;
    const pgChannel = supabase
      .channel(pgChannelName)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "session_participants",
          filter: `session_id=eq.${id}`,
        },
        async (payload) => {
          const newUserId = payload.new?.user_id as string | undefined;
          if (!newUserId) return;
          await onPendingRow(newUserId);
        }
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "session_participants",
          filter: `session_id=eq.${id}`,
        },
        async (payload) => {
          const updatedUserId = payload.new?.user_id as string | undefined;
          const newStatus = payload.new?.status as string | undefined;
          if (!updatedUserId) return;
          if (newStatus === "pending") {
            await onPendingRow(updatedUserId);
          } else if (newStatus === "cancelled") {
            // Scanned, then cancelled on the join screen: never a participant.
            console.log("[session] Participant cancelled joining:", updatedUserId);
            setPendingUserIds((prev) => {
              const next = new Set(prev);
              next.delete(updatedUserId);
              return next;
            });
            removeParticipant(updatedUserId);
          } else if (newStatus === "joined") {
            console.log("[session] Participant confirmed join:", updatedUserId);
            setPendingUserIds((prev) => {
              const next = new Set(prev);
              next.delete(updatedUserId);
              return next;
            });
            setLeftUserIds((prev) => {
              const next = new Set(prev);
              next.delete(updatedUserId);
              return next;
            });

            const already = useSessionStore.getState().currentSession?.participants.find(
              (p) => p.userId === updatedUserId
            );
            if (!already) {
              const { data: p } = await supabase
                .from("profiles")
                .select("id, name, color, avatar_icon, avatar_url, bill_credits, referral_count, is_pro")
                .eq("id", updatedUserId)
                .single();

              addParticipant({
                userId: updatedUserId,
                profile: p
                  ? {
                      id: p.id,
                      name: p.name ?? "User",
                      color: p.color ?? getColorForUser(updatedUserId),
                      avatarIcon: p.avatar_icon ?? undefined,
                      avatarUrl: p.avatar_url ?? undefined,
                      billCredits: p.bill_credits ?? 0,
                      referralCount: p.referral_count ?? 0,
                      isPro: p.is_pro ?? false,
                    }
                  : {
                      id: updatedUserId,
                      name: "User",
                      color: getColorForUser(updatedUserId),
                      billCredits: 0,
                      referralCount: 0,
                      isPro: false,
                    },
                selections: [],
                totalOwed: 0,
                paid: false,
                confirmedByCreator: true,
              });
            }
          } else if (newStatus === "left") {
            console.log("[session] Participant left:", updatedUserId);
            setPendingUserIds((prev) => {
              const next = new Set(prev);
              next.delete(updatedUserId);
              return next;
            });
            setLeftUserIds((prev) => {
              const next = new Set(prev);
              next.delete(updatedUserId);
              return next;
            });
            const hostId = useSessionStore.getState().currentSession?.creatorId;
            if (updatedUserId !== hostId) {
              removeParticipant(updatedUserId);
            }
          }
        }
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "sessions",
          filter: `id=eq.${id}`,
        },
        (payload) => {
          const newStatus = payload.new?.status as string | undefined;
          if (newStatus === "closed") {
            clearSession();
            router.replace("/(app)");
            Alert.alert(t("session_ended_title"), t("session_host_closed_msg"));
            return;
          }
          // Reliable fallback: detect when host writes receipt_data to DB
          const receiptData = payload.new?.receipt_data;
          if (receiptData && !isCreatorRef.current && !navigatingToLobbyRef.current) {
            const sess = useSessionStore.getState().currentSession;
            if (sess && !sess.receipt) {
              navigatingToLobbyRef.current = true;
              // Show curiosities screen for 2s before navigating to lobby
              setSessionLocked(true);
              setTimeout(() => {
                useSessionStore.getState().setSession({ ...sess, receipt: receiptData });
                router.replace(`/(app)/session-lobby/${id}`);
              }, 2000);
            }
          }
        }
      )
      .subscribe();

    // --- broadcast channel (stable name so host broadcasts reach all participants) ---
    // Pre-cleanup removes any stale subscribed channel with the same topic that
    // could cause the "cannot add postgres_changes callbacks after subscribed" error
    // if this channel were re-used for postgres_changes elsewhere.
    const bcChannelName = `session-participants:${id}`;
    (supabase.realtime as any).channels
      ?.filter((c: any) => c.topic === `realtime:${bcChannelName}`)
      .forEach((c: any) => supabase.removeChannel(c));

    const bcChannel = supabase
      .channel(bcChannelName)
      .on("broadcast", { event: "session_locked" }, () => {
        setSessionLocked(true);
      })
      .on("broadcast", { event: "receipt_ready" }, ({ payload }) => {
        const sess = useSessionStore.getState().currentSession;
        if (sess && payload?.receipt) {
          if (!isCreatorRef.current) {
            if (navigatingToLobbyRef.current) return;
            navigatingToLobbyRef.current = true;
            // Show curiosities screen for 2s before navigating to lobby
            setSessionLocked(true);
            setTimeout(() => {
              useSessionStore.getState().setSession({ ...sess, receipt: payload.receipt });
              router.replace(`/(app)/session-lobby/${id}`);
            }, 2000);
          } else {
            useSessionStore.getState().setSession({ ...sess, receipt: payload.receipt });
          }
        }
      })
      .on("broadcast", { event: "host_left" }, () => {
        Alert.alert(
          t("session_ended_title"),
          t("session_host_ended_msg"),
          [{ text: "OK", onPress: () => { clearSession(); router.replace("/(app)"); } }]
        );
      })
      .on("broadcast", { event: "scan_cancelled" }, () => {
        clearSession();
        router.replace("/(app)");
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          channelRef.current = bcChannel;
          bcSubscribedRef.current = true;
          // Flush any receipt broadcast that was queued before subscription completed
          if (pendingReceiptBroadcastRef.current) {
            bcChannel.send({
              type: "broadcast",
              event: "receipt_ready",
              payload: { receipt: pendingReceiptBroadcastRef.current },
            });
            pendingReceiptBroadcastRef.current = null;
          }
        }
      });

    return () => {
      bcSubscribedRef.current = false;
      supabase.removeChannel(pgChannel);
      supabase.removeChannel(bcChannel);
    };
  }, [id]);

  // Post-receipt selection now lives in session-lobby. If this legacy session
  // route is reached with a confirmed receipt, leave before rendering old UI.
  // Non-creators navigate via the delayed handlers; this covers the creator and edge cases.
  useEffect(() => {
    if (!receipt || !id) return;
    if (!isCreator && navigatingToLobbyRef.current) return;
    router.replace(`/(app)/session-lobby/${id}`);
  }, [receipt, id, isCreator]);
  const participantCount = session?.participants.length ?? 0;
  const scanBlockedParticipantCount = session?.participants.filter((p) =>
    p.userId !== session.creatorId &&
    (pendingUserIds.has(p.userId) || leftUserIds.has(p.userId))
  ).length ?? 0;
  const canScanReceipt = scanBlockedParticipantCount === 0;
  const qrValue = buildSessionLink(id ?? "");
  const qrSize = Math.min(Math.floor(width * 0.7), 280);

  // ── Per-item selection count across all participants ─────────────────────────
  const itemSelectionCounts = useMemo<Map<string, number>>(() => {
    if (!session) return new Map();
    const counts = new Map<string, number>();
    for (const p of session.participants) {
      for (const s of p.selections) {
        counts.set(s.itemId, (counts.get(s.itemId) ?? 0) + 1);
      }
    }
    return counts;
  }, [session]);

  // ── All items flat (for unassigned check) ────────────────────────────────────
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

  const unassignedItems = useMemo<ReceiptItem[]>(() => {
    const selectedIds = new Set(
      session?.participants.flatMap((p) => p.selections.map((s) => s.itemId)) ?? []
    );
    return allItems.filter((item) => !selectedIds.has(item.id));
  }, [allItems, session]);

  const handleRemoveParticipant = (userId: string) => {
    if (!session) return;
    setSession({ ...session, participants: session.participants.filter((p) => p.userId !== userId) });
    setLeftUserIds((prev) => { const next = new Set(prev); next.delete(userId); return next; });
  };

  const closeConfirmedSession = useCallback(async () => {
    if (!session) return;
    const isOfflineSession = session.id.startsWith("session_") || session.id.startsWith("dev_session_");
    try {
      if (isCreator && !isOfflineSession) {
        channelRef.current?.send({ type: "broadcast", event: "host_left", payload: {} });
        await supabase
          .from("sessions")
          .update({ status: "closed" })
          .eq("id", session.id);
      } else if (!isCreator && !isOfflineSession && realProfile?.id) {
        await supabase
          .from("session_participants")
          .update({ status: "left" })
          .eq("session_id", session.id)
          .eq("user_id", realProfile.id);
      }
    } finally {
      clearSession();
      router.replace("/(app)");
    }
  }, [clearSession, isCreator, realProfile?.id, session]);

  const confirmExitConfirmedSession = useCallback(() => {
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
      if (!receipt) return;
      const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
        confirmExitConfirmedSession();
        return true;
      });
      return () => subscription.remove();
    }, [confirmExitConfirmedSession, receipt])
  );

  const handleHostBack = () => {
    if (receipt) {
      confirmExitConfirmedSession();
      return;
    }
    if (isCreator) {
      const title = sessionLocked ? t("session_cancel_scan_title") : t("lobby_confirm_end_title");
      const message = sessionLocked
        ? t("session_cancel_scan_msg")
        : t("session_end_all_msg");
      Alert.alert(title, message, [
        { text: t("lobby_stay"), style: "cancel" },
        {
          text: sessionLocked ? t("session_cancel_scan_btn") : t("lobby_end_session"),
          style: "destructive",
          onPress: async () => {
            channelRef.current?.send({ type: "broadcast", event: "host_left", payload: {} });
            if (id && !String(id).startsWith("session_") && !String(id).startsWith("dev_session_")) {
              try { await supabase.from("sessions").update({ status: "closed" }).eq("id", id); } catch {}
            }
            clearSession();
            router.replace("/(app)");
          },
        },
      ]);
    } else {
      void forceLeaveSession();
    }
  };

  const forceLeaveSession = async () => {
    if (id && !String(id).startsWith("session_") && realProfile?.id) {
      await supabase
        .from("session_participants")
        .update({ status: "left" })
        .eq("session_id", id)
        .eq("user_id", realProfile.id);
    }
    clearSession();
    router.replace("/(app)");
  };

  const handleLeaveSession = () => {
    Alert.alert(t("lobby_confirm_leave_title"), t("session_leave_rejoin_msg"), [
      { text: t("cancel"), style: "cancel" },
      {
        text: t("lobby_leave_btn"),
        style: "destructive",
        onPress: async () => {
          if (id && !String(id).startsWith("session_") && realProfile?.id) {
            await supabase
              .from("session_participants")
              .update({ status: "left" })
              .eq("session_id", id)
              .eq("user_id", realProfile.id);
          }
          clearSession();
          router.replace("/(app)");
        },
      },
    ]);
  };

  const handleSplitBillPress = () => {
    if (!receipt) return;
    if (unassignedItems.length > 0) {
      setItemAssignments(new Map());
      setUnassignedModalVisible(true);
    } else {
      router.push(`/(app)/dashboard/${id}`);
    }
  };

  const handleApplyAssignments = () => {
    if (!session) return;
    for (const [itemId, userId] of itemAssignments) {
      const participant = session.participants.find((p) => p.userId === userId);
      if (!participant) continue;
      updateSelections(userId, [
        ...participant.selections,
        { itemId, quantity: 1, isShared: false, sharedWith: [] },
      ]);
    }
    setUnassignedModalVisible(false);
    router.push(`/(app)/dashboard/${id}`);
  };

  const handleShare = async () => {
    const restaurant = receipt?.restaurant ?? "Pick&Pay Session";
    const text = buildSessionShareText(id ?? "", restaurant);
    try {
      await Share.share({ message: text, title: "Join Split Session" });
    } catch (err) {
      console.error(err);
    }
  };

  const handleScanFromLobby = () => {
    if (!canScanReceipt) {
      Alert.alert(
        "Waiting for participants",
        "You can scan the receipt once every participant has confirmed and shows the green check mark."
      );
      return;
    }
    setSessionLocked(true);
    channelRef.current?.send({
      type: "broadcast",
      event: "session_locked",
      payload: {},
    });
    router.push("/(app)/scan");
  };

  if (!session) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: bgColor }]}>
        <View style={styles.emptyContainer}>
          <Text style={[styles.emptyText, { color: mutedColor }]}>{t("session_not_found")}</Text>
        </View>
      </SafeAreaView>
    );
  }

  // ── Pre-receipt lobby ───────────────────────────────────────────────────────
  if (!receipt) {
    const onlineCount = session.participants.filter((p) => !leftUserIds.has(p.userId)).length;

    return (
      <SafeAreaView style={[styles.lobbySafe, { backgroundColor: "#0B0D10" }]}>
        <Stack.Screen options={{ gestureEnabled: false }} />

        {/* Header */}
        <View style={styles.lobbyHeader}>
          <TouchableOpacity
            onPress={handleHostBack}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="chevron-back" size={24} color="#F9FAFB" />
          </TouchableOpacity>

          <View style={styles.lobbyHeaderCenter}>
            <Text style={styles.lobbyHeaderTitle} numberOfLines={1}>
              {t("session_title")}
            </Text>
            <Text style={styles.lobbyHeaderSub}>{onlineCount} people</Text>
          </View>

          <TouchableOpacity
            onPress={handleShare}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="ellipsis-horizontal" size={22} color="#F9FAFB" />
          </TouchableOpacity>
        </View>

        <ScrollView
          contentContainerStyle={[
            styles.lobbyScroll,
            { paddingBottom: 156 + Math.max(insets.bottom, 16) },
          ]}
          showsVerticalScrollIndicator={false}
        >
          {/* Invite card with QR */}
          <View style={styles.lobbyInviteCard}>
            <View style={styles.lobbyInviteCopy}>
              <Text style={styles.lobbyInviteTitle}>Invite friends</Text>
              <Text style={styles.lobbyInviteSub}>Scan or share the QR code</Text>
            </View>
            <TouchableOpacity
              style={styles.lobbyInviteQr}
              onPress={() => setQrExpanded(true)}
              activeOpacity={0.8}
            >
              <QRGenerator value={qrValue} size={82} />
            </TouchableOpacity>
          </View>

          {/* QR expanded modal */}
          <Modal
            visible={qrExpanded}
            transparent
            animationType="fade"
            statusBarTranslucent
            onRequestClose={() => setQrExpanded(false)}
          >
            <TouchableOpacity
              style={styles.qrModalOverlay}
              onPress={() => setQrExpanded(false)}
              activeOpacity={1}
            >
              <View style={styles.qrModalCard}>
                <QRGenerator value={qrValue} size={260} />
                <Text style={styles.qrModalHint}>Tap anywhere to close</Text>
              </View>
            </TouchableOpacity>
          </Modal>

          {/* Participants */}
          <View style={styles.lobbyParticipantsBlock}>
            <Text style={styles.lobbySectionLabel}>Participants ({onlineCount})</Text>

            <View style={styles.lobbyParticipantsCard}>
              {session.participants.map((p, index) => {
                const participantColor = p.profile.color;
                const isPending = pendingUserIds.has(p.userId);
                const hasLeft = leftUserIds.has(p.userId);
                const isLast = index === session.participants.length - 1;

                return (
                  <View key={p.userId}>
                    <View style={[styles.lobbyParticipantRow, hasLeft && { opacity: 0.45 }]}>
                      <View style={[styles.lobbyParticipantAccent, { backgroundColor: participantColor }]} />
                      <View style={[styles.lobbyAvatarRing, { borderColor: participantColor }]}>
                        <Avatar
                          name={p.profile.name}
                          avatarIcon={p.profile.avatarIcon}
                          avatarUrl={p.profile.avatarUrl}
                          color={participantColor}
                          size={36}
                        />
                      </View>
                      <View style={styles.lobbyParticipantInfo}>
                        <Text style={styles.lobbyParticipantName} numberOfLines={1}>
                          {p.profile.name}
                        </Text>
                        <Text style={styles.lobbyParticipantStatus}>
                          {hasLeft ? "Left" : isPending ? "Joining" : "Online"}
                        </Text>
                      </View>
                      {hasLeft ? (
                        <Ionicons name="close-circle" size={18} color="#6B7280" />
                      ) : isPending ? (
                        <ActivityIndicator size="small" color="#22C55E" />
                      ) : (
                        <Ionicons name="checkmark-circle" size={18} color="#22C55E" />
                      )}
                    </View>
                    {!isLast && <View style={styles.lobbyDivider} />}
                  </View>
                );
              })}
            </View>
          </View>
        </ScrollView>

        {/* Fixed bottom panel */}
        <View
          style={[
            styles.lobbyBottomPanel,
            { paddingBottom: 16 + Math.max(insets.bottom, 16) },
          ]}
        >
          <View style={styles.lobbyBottomCopy}>
            <View style={styles.lobbyBottomIcon}>
              <Ionicons name="receipt-outline" size={18} color="#F9FAFB" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.lobbyBottomTitle}>
                {canScanReceipt ? "Ready to scan" : "Host is waiting for all participants"}
              </Text>
              <Text style={styles.lobbyBottomSub}>
                {canScanReceipt ? "next step is to scan the receipt" : "wait for every green check mark"}
              </Text>
            </View>
          </View>

          {isCreator ? (
            <TouchableOpacity
              style={[styles.lobbyPrimaryButton, !canScanReceipt && { opacity: 0.45 }]}
              onPress={handleScanFromLobby}
              activeOpacity={0.88}
            >
              <Text style={styles.lobbyPrimaryText}>Scan receipt</Text>
              <Ionicons name="arrow-forward" size={20} color="#fff" />
            </TouchableOpacity>
          ) : (
            <View style={styles.lobbyGuestWaiting}>
              <ActivityIndicator size="small" color="#9CA3AF" />
              <Text style={styles.lobbyGuestWaitingText}>
                Waiting for host to scan the bill...
              </Text>
            </View>
          )}
        </View>

        {/* Fun facts overlay — shown to participants while host scans */}
        <Modal
          visible={sessionLocked && !isCreator}
          transparent={false}
          animationType="fade"
          statusBarTranslucent
        >
          <SafeAreaView style={styles.lobbyFactsOverlay}>
            <TouchableOpacity
              style={styles.forceExitButton}
              onPress={forceLeaveSession}
              activeOpacity={0.85}
            >
              <Ionicons name="close" size={24} color="#fff" />
            </TouchableOpacity>
            <View style={styles.factsHeader}>
              <Text style={styles.lobbyFactsTitle}>Pick<Text style={{ color: Colors.primary }}>&</Text>Pay</Text>
              <Text style={styles.lobbyFactsSub}>{t("session_sit_tight")}</Text>
            </View>

            <View style={styles.factsCenter}>
              <View style={styles.lobbyFactsCard} {...factPanRef.panHandlers}>
                <Text style={[styles.factsLabel, { color: "#9CA3AF" }]}>{t("session_did_you_know")}</Text>
                <Text style={[styles.factsText, { color: "#F9FAFB" }]} key={factIndex}>
                  {FUN_FACTS[factIndex]}
                </Text>
              </View>

              <View style={styles.factsDots}>
                {FUN_FACTS.map((_, i) => (
                  <View
                    key={i}
                    style={[
                      styles.factsDot,
                      {
                        backgroundColor: i === factIndex ? Colors.primary : "#9CA3AF40",
                        width: i === factIndex ? 20 : 7,
                      },
                    ]}
                  />
                ))}
              </View>
            </View>

            <View style={styles.factsBottom}>
              <View style={[styles.factsIconWrap, { backgroundColor: Colors.primary + "18" }]}>
                <Ionicons name="restaurant-outline" size={36} color={Colors.primary} />
              </View>
              <Text style={styles.lobbyFactsNote}>{t("session_host_working")}</Text>
              <Text style={styles.lobbyFactsSubNote}>{t("session_redirected_soon")}</Text>
              <ActivityIndicator size="small" color={Colors.primary} style={{ marginTop: 8 }} />
            </View>
          </SafeAreaView>
        </Modal>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: bgColor }]}>
      <Stack.Screen options={{ gestureEnabled: false }} />
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={handleHostBack}>
          <Ionicons name="arrow-back" size={24} color={textColor} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={[styles.headerTitle, { color: textColor }]} numberOfLines={1}>
            {t("session_title")}
          </Text>
          {testActiveProfile && (
            <View style={[styles.viewingAsPill, { borderColor: testActiveProfile.color }]}>
              <Text style={[styles.viewingAsText, { color: testActiveProfile.color }]}>
                👁 {testActiveProfile.name}
              </Text>
            </View>
          )}
        </View>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Restaurant name — only shown once receipt is scanned ─────────── */}
        {receipt && (
          <View style={styles.restaurantRow}>
            <Ionicons name="restaurant-outline" size={16} color={mutedColor} />
            <Text style={[styles.restaurantLabel, { color: mutedColor }]} numberOfLines={1}>
              {receipt.restaurant}
            </Text>
            {sessionLocked && (
              <View style={styles.lockedBadge}>
                <Ionicons name="lock-closed" size={11} color="#10B981" />
                <Text style={styles.lockedBadgeText}>{t("session_locked_badge")}</Text>
              </View>
            )}
          </View>
        )}

        {/* ── QR Code (prominent, top) ─────────────────────────────────────── */}
        <View style={styles.qrSection}>
          <QRGenerator value={qrValue} size={qrSize} />
          <Text style={[styles.qrHint, { color: mutedColor }]}>{t("session_scan_to_join")}</Text>
          <TouchableOpacity style={[styles.shareQrBtn, { borderColor: Colors.primary }]} onPress={handleShare}>
            <Ionicons name="share-outline" size={16} color={Colors.primary} />
            <Text style={styles.shareQrText}>{t("session_share_link")}</Text>
          </TouchableOpacity>
        </View>

        {/* ── Participants ─────────────────────────────────────────────────── */}
        <View style={styles.participantsSection}>
          <Text style={[styles.sectionTitle, { color: mutedColor }]}>
            {t("session_people_in_split")} ({participantCount})
          </Text>

          <Card style={styles.participantsCard} padding={0}>
            {session.participants.map((p, index) => {
              const participantColor = p.profile.color;
              const hasDoneSelections = p.selections.length > 0;
              const isLast = index === session.participants.length - 1;
              const isHost = p.userId === session.creatorId;
              const isPending = pendingUserIds.has(p.userId);
              const hasLeft = leftUserIds.has(p.userId);
              return (
                <View key={p.userId}>
                  <View style={[styles.participantRow, hasLeft && { opacity: 0.5 }]}>
                    <View style={[styles.participantAccent, { backgroundColor: hasLeft ? mutedColor : participantColor }]} />
                    <Avatar
                      name={p.profile.name}
                      avatarIcon={p.profile.avatarIcon}
                      avatarUrl={p.profile.avatarUrl}
                      color={participantColor}
                      size={40}
                    />
                    <View style={styles.participantInfo}>
                      <View style={styles.participantNameRow}>
                        <Text style={[styles.participantName, { color: textColor }]} numberOfLines={1}>
                          {p.profile.name}
                        </Text>
                        {isHost && (
                          <View style={styles.hostBadge}>
                            <Text style={styles.hostBadgeText}>{t("session_host_badge")}</Text>
                          </View>
                        )}
                      </View>
                      {hasLeft ? (
                        <Text style={[styles.joiningText, { color: mutedColor }]}>{t("session_left")}</Text>
                      ) : isPending ? (
                        <Text style={[styles.joiningText, { color: mutedColor }]}>⏳ {t("session_joining")}</Text>
                      ) : hasDoneSelections ? (
                        <Text style={[styles.selectionsDone, { color: Colors.success }]}>
                          ✓ {p.selections.length} {p.selections.length === 1 ? t("session_item") : t("session_items")} {t("session_selected_label")}
                        </Text>
                      ) : (
                        <Text style={styles.joinedText}>{t("session_joined")}</Text>
                      )}
                    </View>

                    {hasLeft && isCreator ? (
                      <TouchableOpacity
                        style={styles.removeBtn}
                        onPress={() => handleRemoveParticipant(p.userId)}
                        activeOpacity={0.7}
                      >
                        <Ionicons name="close-circle" size={20} color={mutedColor} />
                      </TouchableOpacity>
                    ) : receipt && !hasLeft ? (
                      <TouchableOpacity
                        style={[
                          styles.selectBtn,
                          hasDoneSelections && styles.selectBtnDone,
                        ]}
                        onPress={() =>
                          router.push(`/(app)/selection/${id}?userId=${p.userId}`)
                        }
                        activeOpacity={0.75}
                      >
                        <Text
                          style={[
                            styles.selectBtnText,
                            hasDoneSelections && styles.selectBtnTextDone,
                          ]}
                        >
                          {hasDoneSelections ? t("session_edit") : t("session_select")}
                        </Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                  {!isLast && (
                    <View style={[styles.divider, { backgroundColor: borderColor }]} />
                  )}
                </View>
              );
            })}

            {participantCount === 0 && (
              <View style={styles.noParticipants}>
                <Text style={[styles.noParticipantsText, { color: mutedColor }]}>
                  {t("session_waiting_join")}
                </Text>
              </View>
            )}
          </Card>

          {isDeveloperUser(profile?.email) && (
            <TestModeBar
              onActiveUserChange={setTestActiveProfile}
              sessionId={id ?? ""}
              hasReceipt={!!receipt}
            />
          )}

          {/* Dev: force lock + go to lobby — uses real profile, bypasses isCreator check */}
          {isDeveloperUser(profile?.email) && !sessionLocked && (
            <TouchableOpacity
              style={styles.devForceBtn}
              onPress={() => {
                setSessionLocked(true);
                channelRef.current?.send({ type: "broadcast", event: "session_locked", payload: {} });
                if (receipt) router.push(`/(app)/session-lobby/${id}`);
              }}
              activeOpacity={0.8}
            >
              <Text style={styles.devForceBtnText}>
                🧪 Force Lock{receipt ? " + Go to Lobby →" : " Session"}
              </Text>
            </TouchableOpacity>
          )}

          {/* Animated waiting indicator — shown below participants when session not yet locked */}
          {!sessionLocked && (
            <View style={styles.waitingRow}>
              <Animated.Text style={[styles.hourglassIcon, { transform: [{ rotate: hourglassRotate }] }]}>
                ⏳
              </Animated.Text>
              <Text style={styles.waitingText}>{t("session_waiting_everyone")}</Text>
            </View>
          )}
        </View>

        {/* ── Receipt Summary — only shown after bill is scanned ───────────── */}
        {receipt && <Card style={styles.summaryCard} padding={0}>
          <TouchableOpacity
            style={styles.summaryHeader}
            onPress={() => setSummaryExpanded((v) => !v)}
            activeOpacity={0.7}
          >
            <Ionicons name="document-text-outline" size={18} color={mutedColor} />
            <Text style={[styles.summaryTitle, { color: textColor }]}>{t("session_receipt_summary")}</Text>
            <Text style={[styles.summaryTotal, { color: Colors.primary }]}>
              {formatCurrency(
                allItems.reduce((s, i) => s + i.totalPrice, 0)
                  + receipt.globalCosts.reduce((s, c) => s + c.amount, 0)
                  + (receipt.selectedTip ?? 0),
                receipt.currency
              )}
            </Text>
            <Ionicons
              name={summaryExpanded ? "chevron-up" : "chevron-down"}
              size={18}
              color={mutedColor}
            />
          </TouchableOpacity>

          {summaryExpanded && (
            <View style={[styles.summaryBody, { borderColor }]}>
              {ORDERED_CATEGORIES.map((cat) => {
                const items = receipt.categories[cat];
                if (items.length === 0) return null;
                return (
                  <View key={cat}>
                    <Text style={[styles.summaryCatLabel, { color: mutedColor, borderColor }]}>
                      {CATEGORY_LABELS[cat].toUpperCase()}
                    </Text>
                    {items.map((item) => {
                      const count = itemSelectionCounts.get(item.id) ?? 0;
                      return (
                        <View
                          key={item.id}
                          style={[
                            styles.summaryItemRow,
                            { borderBottomColor: borderColor },
                            count === 0
                              ? styles.summaryItemUnselected
                              : styles.summaryItemFaded,
                          ]}
                        >
                          <Text
                            style={[styles.summaryItemName, { color: textColor }]}
                            numberOfLines={1}
                          >
                            {item.quantity > 1 ? `${item.quantity}× ` : ""}
                            {item.name}
                          </Text>
                          <Text style={[styles.summaryItemPrice, { color: mutedColor }]}>
                            {formatCurrency(item.totalPrice, receipt.currency)}
                          </Text>
                          {count > 0 ? (
                            <View style={[styles.countBadge, { backgroundColor: Colors.success + "22" }]}>
                              <Text style={[styles.countBadgeText, { color: Colors.success }]}>
                                {count}👤
                              </Text>
                            </View>
                          ) : (
                            <View style={styles.countBadgePlaceholder} />
                          )}
                        </View>
                      );
                    })}
                  </View>
                );
              })}
            </View>
          )}
        </Card>}

        {/* ── Session controls ─────────────────────────────────────────────── */}
        {isCreator ? (
          // ── HOST controls ──────────────────────────────────────────────
          !sessionLocked ? (
            <TouchableOpacity
              style={styles.lockBtn}
              onPress={() => {
                setSessionLocked(true);
                channelRef.current?.send({ type: "broadcast", event: "session_locked", payload: {} });
              }}
              activeOpacity={0.85}
            >
              <Ionicons name="checkmark-circle-outline" size={22} color="#fff" />
              <Text style={styles.lockBtnText}>{t("session_everyones_here")}</Text>
            </TouchableOpacity>
          ) : !receipt ? (
            <View style={styles.readySection}>
              <View style={styles.readyBanner}>
                <Ionicons name="lock-closed" size={14} color="#10B981" />
                <Text style={styles.readyBannerText}>
                  {participantCount} participant{participantCount !== 1 ? "s" : ""} locked in · Scan the bill
                </Text>
              </View>
              <TouchableOpacity
                style={[styles.scanBillBtn, !canScanReceipt && { opacity: 0.45 }]}
                onPress={handleScanFromLobby}
                activeOpacity={0.85}
              >
                <Ionicons name="scan-outline" size={22} color="#fff" />
                <Text style={styles.scanBillBtnText}>{t("session_scan_btn")}</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.readySection}>
              <View style={styles.readyBanner}>
                <Ionicons name="lock-closed" size={14} color="#10B981" />
                <Text style={styles.readyBannerText}>
                  Session locked · {participantCount} participant{participantCount !== 1 ? "s" : ""}
                </Text>
              </View>
              <TouchableOpacity
                style={styles.splitBtn}
                onPress={() => router.push(`/(app)/review-accept/${id}`)}
                activeOpacity={0.85}
              >
                <Ionicons name="checkmark-done-outline" size={22} color="#fff" />
                <Text style={styles.splitBtnText}>{t("session_review_accept")}</Text>
                <Ionicons name="arrow-forward" size={20} color="#fff" />
              </TouchableOpacity>
            </View>
          )
        ) : sessionLocked && receipt ? (
          // ── PARTICIPANT: bill is ready → can review & accept ───────────
          <TouchableOpacity
            style={styles.splitBtn}
            onPress={() => router.push(`/(app)/review-accept/${id}`)}
            activeOpacity={0.85}
          >
            <Ionicons name="checkmark-done-outline" size={22} color="#fff" />
            <Text style={styles.splitBtnText}>{t("session_review_accept")}</Text>
            <Ionicons name="arrow-forward" size={20} color="#fff" />
          </TouchableOpacity>
        ) : (
          // ── PARTICIPANT: waiting for host ──────────────────────────────
          <View style={[styles.waitingForHostBox, { borderColor }]}>
            <Ionicons
              name={sessionLocked ? "scan-outline" : "time-outline"}
              size={26}
              color={mutedColor}
            />
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={[styles.waitingForHostTitle, { color: textColor }]}>
                {sessionLocked ? t("session_waiting") : t("session_waiting_lock")}
              </Text>
              <Text style={[styles.waitingForHostSub, { color: mutedColor }]}>
                {sessionLocked ? t("session_scanning_ready") : t("session_waiting_host_sub")}
              </Text>
            </View>
          </View>
        )}

        {/* ── Leave Session — non-host participants only ───────────────── */}
        {!isCreator && (
          <TouchableOpacity
            style={[styles.leaveBtn, { borderColor: "#EF444480" }]}
            onPress={handleLeaveSession}
            activeOpacity={0.7}
          >
            <Ionicons name="exit-outline" size={17} color="#EF4444" />
            <Text style={styles.leaveBtnText}>{t("session_leave")}</Text>
          </TouchableOpacity>
        )}

        {/* ── End Session — host only ───────────────────────────────────── */}
        {isCreator && (
          <TouchableOpacity
            style={[styles.leaveBtn, { borderColor: "#EF444480" }]}
            onPress={() => {
              Alert.alert(
                t("session_end_confirm_title"),
                t("session_end_confirm_msg"),
                [
                  { text: t("cancel"), style: "cancel" },
                  {
                    text: t("session_end_confirm_btn"),
                    style: "destructive",
                    onPress: async () => {
                      channelRef.current?.send({ type: "broadcast", event: "host_left", payload: {} });
                      if (id && !String(id).startsWith("session_") && !String(id).startsWith("dev_session_")) {
                        try {
                          await supabase.from("sessions").update({ status: "closed" }).eq("id", id);
                        } catch {}
                      }
                      clearSession();
                      router.replace("/(app)");
                    },
                  },
                ]
              );
            }}
            activeOpacity={0.7}
          >
            <Ionicons name="close-circle-outline" size={17} color="#EF4444" />
            <Text style={styles.leaveBtnText}>{t("session_end")}</Text>
          </TouchableOpacity>
        )}

        {/* ── Missing participants warning — host only, after bill is scanned ── */}
        {isCreator && sessionLocked && receipt && (() => {
          const missing = session.participants.filter((p) => p.selections.length === 0);
          if (missing.length === 0) return null;
          return (
            <View style={[styles.missingBanner, { borderColor: Colors.warning + "66", backgroundColor: Colors.warning + "12" }]}>
              <Ionicons name="time-outline" size={15} color={Colors.warning} />
              <View style={{ flex: 1, gap: 6 }}>
                <Text style={[styles.missingTitle, { color: Colors.warning }]}>
                  {missing.length} participant{missing.length !== 1 ? "s" : ""} haven't selected items
                </Text>
                <View style={styles.missingList}>
                  {missing.map((p) => (
                    <View key={p.userId} style={styles.missingRow}>
                      <Avatar
                        name={p.profile.name}
                        avatarIcon={p.profile.avatarIcon}
                        avatarUrl={p.profile.avatarUrl}
                        color={p.profile.color}
                        size={28}
                      />
                      <Text style={[styles.missingName, { color: textColor }]}>{p.profile.name}</Text>
                      <TouchableOpacity
                        style={[styles.takeoverBtn, { borderColor: Colors.primary }]}
                        onPress={() => setTakeoverTarget(p.userId)}
                      >
                        <Text style={styles.takeoverBtnText}>{t("session_take_over")}</Text>
                      </TouchableOpacity>
                    </View>
                  ))}
                </View>
              </View>
            </View>
          );
        })()}
      </ScrollView>

      {/* Fun facts overlay — shown to participants while host scans the bill */}
      <Modal
        visible={sessionLocked && !receipt && !isCreator}
        transparent={false}
        animationType="fade"
        statusBarTranslucent
      >
        <SafeAreaView style={[styles.factsOverlay, { backgroundColor: bgColor }]}>
          <TouchableOpacity
            style={styles.forceExitButton}
            onPress={forceLeaveSession}
            activeOpacity={0.85}
          >
            <Ionicons name="close" size={24} color="#fff" />
          </TouchableOpacity>
          <View style={styles.factsHeader}>
            <Text style={[styles.factsHeaderTitle, { color: textColor }]}>{t("session_sit_tight")}</Text>
          </View>

          {/* DID YOU KNOW card — center of screen */}
          <View style={styles.factsCenter}>
            <View style={[styles.factsCard, { backgroundColor: cardColor, borderColor }]}>
              <Text style={[styles.factsLabel, { color: mutedColor }]}>{t("session_did_you_know")}</Text>
              <Text style={[styles.factsText, { color: textColor }]} key={factIndex}>
                {FUN_FACTS[factIndex]}
              </Text>
            </View>

            <View style={styles.factsDots}>
              {FUN_FACTS.map((_, i) => (
                <View
                  key={i}
                  style={[
                    styles.factsDot,
                    {
                      backgroundColor: i === factIndex ? Colors.primary : mutedColor + "40",
                      width: i === factIndex ? 20 : 7,
                    },
                  ]}
                />
              ))}
            </View>
          </View>

          {/* Host info — below the card */}
          <View style={styles.factsBottom}>
            <View style={[styles.factsIconWrap, { backgroundColor: Colors.primary + "18" }]}>
              <Ionicons name="restaurant-outline" size={36} color={Colors.primary} />
            </View>
            <Text style={[styles.factsNote, { color: textColor }]}>{t("session_host_working")}</Text>
            <Text style={[styles.factsSubNote, { color: mutedColor }]}>{t("session_redirected_soon")}</Text>
          </View>
        </SafeAreaView>
      </Modal>

      {/* Takeover confirmation modal */}
      {takeoverTarget && (() => {
        const target = session?.participants.find((p) => p.userId === takeoverTarget);
        const taker = session?.participants.find((p) => p.userId === effectiveProfile?.id);
        if (!target || !taker) return null;

        const targetTotal = target.totalOwed;
        const takerTotal = taker.totalOwed;
        const combined = Math.round((takerTotal + targetTotal) * 100) / 100;
        const currency = receipt?.currency ?? "EUR";

        return (
          <Modal
            visible
            transparent
            animationType="slide"
            onRequestClose={() => setTakeoverTarget(null)}
          >
            <View style={styles.modalOverlay}>
              <View style={[styles.modalCard, { backgroundColor: cardColor }]}>
                <Text style={[styles.modalTitle, { color: textColor }]}>
                  {t("session_takeover_title")} {target.profile.name}?
                </Text>
                <Text style={[styles.modalSubtitle, { color: mutedColor }]}>
                  {t("session_takeover_sub")}
                </Text>

                <View style={[styles.takeoverBreakdown, { borderColor }]}>
                  <View style={styles.takeoverLine}>
                    <Text style={[styles.takeoverLineLabel, { color: mutedColor }]}>
                      {target.profile.name}'s bill
                    </Text>
                    <Text style={[styles.takeoverLineAmt, { color: textColor }]}>
                      {formatCurrency(targetTotal, currency)}
                    </Text>
                  </View>
                  <View style={[styles.takeoverDivider, { backgroundColor: borderColor }]} />
                  <View style={styles.takeoverLine}>
                    <Text style={[styles.takeoverLineLabel, { color: mutedColor }]}>{t("session_takeover_your_bill")}</Text>
                    <Text style={[styles.takeoverLineAmt, { color: textColor }]}>
                      {formatCurrency(takerTotal, currency)}
                    </Text>
                  </View>
                  <View style={[styles.takeoverDivider, { backgroundColor: borderColor }]} />
                  <View style={styles.takeoverLine}>
                    <Text style={[styles.takeoverLineLabelBold, { color: textColor }]}>
                      {t("session_takeover_after")}
                    </Text>
                    <Text style={[styles.takeoverLineAmtBold, { color: Colors.primary }]}>
                      {formatCurrency(combined, currency)}
                    </Text>
                  </View>
                </View>

                <Text style={[styles.takeoverWarning, { color: Colors.warning }]}>
                  {t("session_takeover_warning_pre")} {target.profile.name} {t("session_takeover_warning_post")}
                </Text>

                <View style={styles.modalActions}>
                  <TouchableOpacity
                    style={[styles.skipBtn, { borderColor }]}
                    onPress={() => setTakeoverTarget(null)}
                  >
                    <Text style={[styles.skipBtnText, { color: mutedColor }]}>{t("cancel")}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.applyBtn}
                    onPress={() => {
                      setTakeoverTarget(null);
                      router.push(`/(app)/selection/${id}?userId=${takeoverTarget}`);
                    }}
                  >
                    <Text style={styles.applyBtnText}>{t("session_confirm_takeover")}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          </Modal>
        );
      })()}

      {/* Unassigned items modal */}
      <Modal
        visible={unassignedModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setUnassignedModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: cardColor }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalWarningIcon}>⚠️</Text>
              <Text style={[styles.modalTitle, { color: textColor }]}>
                {t("session_unassigned_title")}
              </Text>
            </View>
            <Text style={[styles.modalSubtitle, { color: mutedColor }]}>
              {t("session_unassigned_sub")}
            </Text>

            <ScrollView style={styles.unassignedList} showsVerticalScrollIndicator={false}>
              {unassignedItems.map((item) => {
                const assignedUserId = itemAssignments.get(item.id);
                return (
                  <View key={item.id} style={[styles.unassignedRow, { borderColor }]}>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.unassignedName, { color: textColor }]} numberOfLines={1}>
                        {item.name}
                      </Text>
                      <Text style={[styles.unassignedPrice, { color: mutedColor }]}>
                        {formatCurrency(item.totalPrice, receipt?.currency ?? "EUR")}
                      </Text>
                    </View>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ maxWidth: 180 }}>
                      <View style={styles.participantPicker}>
                        {session.participants.map((p) => {
                          const isSelected = assignedUserId === p.userId;
                          return (
                            <TouchableOpacity
                              key={p.userId}
                              style={[
                                styles.assignBtn,
                                { borderColor: isSelected ? p.profile.color : borderColor },
                                isSelected && { backgroundColor: p.profile.color + "22" },
                              ]}
                              onPress={() => {
                                setItemAssignments((prev) => {
                                  const next = new Map(prev);
                                  if (isSelected) next.delete(item.id);
                                  else next.set(item.id, p.userId);
                                  return next;
                                });
                              }}
                            >
                              <Text
                                style={[
                                  styles.assignBtnText,
                                  { color: isSelected ? p.profile.color : mutedColor },
                                ]}
                                numberOfLines={1}
                              >
                                {p.profile.name.split(" ")[0]}
                              </Text>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    </ScrollView>
                  </View>
                );
              })}
            </ScrollView>

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.skipBtn, { borderColor }]}
                onPress={() => {
                  setUnassignedModalVisible(false);
                  router.push(`/(app)/dashboard/${id}`);
                }}
              >
                <Text style={[styles.skipBtnText, { color: mutedColor }]}>{t("session_skip_anyway")}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.applyBtn,
                  itemAssignments.size < unassignedItems.length && { opacity: 0.5 },
                ]}
                onPress={handleApplyAssignments}
              >
                <Text style={styles.applyBtnText}>{t("session_apply_split")}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },

  // ── Dev force button ─────────────────────────────────────────────────────────
  devForceBtn: {
    alignItems: "center",
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: Colors.warning,
    backgroundColor: Colors.warningBg,
  },
  devForceBtnText: {
    color: Colors.warning,
    fontSize: 13,
    fontWeight: "700",
  },

  // ── Header ───────────────────────────────────────────────────────────────────
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  headerCenter: { flex: 1, alignItems: "center", gap: 4, paddingHorizontal: 8 },
  headerTitle: { fontSize: 17, fontWeight: "700" },
  viewingAsPill: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  viewingAsText: { fontSize: 11, fontWeight: "600" },

  scroll: {
    paddingHorizontal: 20,
    paddingBottom: 32,
    gap: 20,
  },

  // ── QR section ───────────────────────────────────────────────────────────────
  qrSection: {
    alignItems: "center",
    gap: 14,
    paddingVertical: 8,
  },
  qrHint: { fontSize: 14, textAlign: "center" },
  shareQrBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 9,
    paddingHorizontal: 18,
    borderRadius: 10,
    borderWidth: 1.5,
  },
  shareQrText: { color: Colors.primary, fontWeight: "600", fontSize: 13 },

  // ── Participants ──────────────────────────────────────────────────────────────
  participantsSection: { gap: 10 },
  sectionTitle: {
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  participantsCard: { overflow: "hidden" },
  participantRow: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 64,
    paddingRight: 12,
    gap: 10,
  },
  participantAccent: { width: 3, alignSelf: "stretch" },
  participantInfo: { flex: 1, gap: 3 },
  participantNameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
  },
  participantName: { fontSize: 15, fontWeight: "600", flexShrink: 1 },
  selectionsDone: { fontSize: 12, fontWeight: "500" },
  joiningText: { fontSize: 12, fontWeight: "500", fontStyle: "italic" },
  joinedText: { fontSize: 12, fontWeight: "600", color: Colors.success },
  hostBadge: {
    backgroundColor: Colors.primary + "33",
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 5,
  },
  hostBadgeText: { color: Colors.primary, fontSize: 10, fontWeight: "600" },
  selectBtn: {
    backgroundColor: Colors.primary,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    minWidth: 70,
    minHeight: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  selectBtnDone: { backgroundColor: Colors.success + "22" },
  selectBtnText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  selectBtnTextDone: { color: Colors.success },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 63 },
  noParticipants: { padding: 24, alignItems: "center" },
  noParticipantsText: { fontSize: 14 },

  // ── Receipt summary card ──────────────────────────────────────────────────────
  summaryCard: { overflow: "hidden" },
  summaryHeader: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    gap: 10,
  },
  summaryTitle: {
    flex: 1,
    fontSize: 15,
    fontWeight: "600",
  },
  summaryTotal: {
    fontSize: 15,
    fontWeight: "700",
  },
  summaryBody: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  summaryCatLabel: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  summaryItemRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  summaryItemUnselected: {
    backgroundColor: "rgba(251, 191, 36, 0.15)",
    borderLeftWidth: 3,
    borderLeftColor: "#F59E0B",
  },
  summaryItemFaded: {
    opacity: 0.45,
  },
  summaryItemName: {
    flex: 1,
    fontSize: 13,
    fontWeight: "500",
  },
  summaryItemPrice: {
    fontSize: 13,
    fontWeight: "600",
    minWidth: 54,
    textAlign: "right",
  },
  countBadge: {
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 8,
    minWidth: 38,
    alignItems: "center",
  },
  countBadgeText: {
    fontSize: 11,
    fontWeight: "700",
  },
  countBadgePlaceholder: {
    width: 38,
  },

  // ── Restaurant row ────────────────────────────────────────────────────────────
  restaurantRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  restaurantLabel: { fontSize: 13, flex: 1 },
  lockedBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    backgroundColor: "#10B98115",
    borderRadius: 8,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  lockedBadgeText: { color: "#10B981", fontSize: 11, fontWeight: "700" },

  // ── Session controls ──────────────────────────────────────────────────────────
  lockBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#10B981",
    paddingVertical: 16,
    borderRadius: 16,
    gap: 10,
  },
  lockBtnText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  readySection: { gap: 10 },
  readyBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 8,
  },
  readyBannerText: { color: "#10B981", fontSize: 13, fontWeight: "600" },

  // ── Scan Our Bill (pre-scan locked state) ────────────────────────────────────
  scanBillBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#6366F1",
    paddingVertical: 18,
    borderRadius: 16,
    gap: 10,
    minHeight: 56,
  },
  scanBillBtnText: { color: "#fff", fontSize: 17, fontWeight: "800" },

  // ── Split Our Bill ────────────────────────────────────────────────────────────
  splitBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.primary,
    paddingVertical: 18,
    borderRadius: 16,
    gap: 10,
    minHeight: 56,
  },
  splitBtnText: { color: "#fff", fontSize: 17, fontWeight: "800" },

  // ── Missing participants ───────────────────────────────────────────────────────
  missingBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
  },
  missingTitle: { fontSize: 13, fontWeight: "600" },
  missingList: { gap: 8 },
  missingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  missingName: { flex: 1, fontSize: 14, fontWeight: "500" },
  takeoverBtn: {
    borderWidth: 1.5,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  takeoverBtnText: { color: Colors.primary, fontSize: 12, fontWeight: "700" },

  // ── Takeover breakdown ────────────────────────────────────────────────────────
  takeoverBreakdown: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    overflow: "hidden",
    marginVertical: 4,
  },
  takeoverLine: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  takeoverLineLabel: { fontSize: 14 },
  takeoverLineAmt: { fontSize: 14, fontWeight: "600" },
  takeoverLineLabelBold: { fontSize: 14, fontWeight: "700" },
  takeoverLineAmtBold: { fontSize: 16, fontWeight: "800" },
  takeoverDivider: { height: StyleSheet.hairlineWidth },
  takeoverWarning: { fontSize: 13, textAlign: "center", fontWeight: "500" },

  // ── Empty state ───────────────────────────────────────────────────────────────
  emptyContainer: { flex: 1, alignItems: "center", justifyContent: "center" },
  emptyText: { fontSize: 16 },

  // ── Unassigned items modal ────────────────────────────────────────────────────
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "flex-end",
  },
  modalCard: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    paddingBottom: 36,
    gap: 14,
    maxHeight: "80%",
  },
  modalHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  modalWarningIcon: { fontSize: 20 },
  modalTitle: { fontSize: 17, fontWeight: "700" },
  modalSubtitle: { fontSize: 13, lineHeight: 18 },
  unassignedList: { maxHeight: 280 },
  unassignedRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 10,
  },
  unassignedName: { fontSize: 14, fontWeight: "600" },
  unassignedPrice: { fontSize: 12, marginTop: 2 },
  participantPicker: { flexDirection: "row", gap: 6 },
  assignBtn: {
    borderWidth: 1.5,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  assignBtnText: { fontSize: 12, fontWeight: "600" },
  modalActions: { flexDirection: "row", gap: 10, marginTop: 4 },
  skipBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
    borderWidth: 1,
  },
  skipBtnText: { fontSize: 14, fontWeight: "600" },
  applyBtn: {
    flex: 2,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
    backgroundColor: Colors.primary,
  },
  applyBtnText: { color: "#fff", fontSize: 14, fontWeight: "700" },

  // ── Waiting indicator ─────────────────────────────────────────────────────────
  waitingRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 14,
    gap: 10,
    backgroundColor: Colors.primary + "15",
    borderRadius: 10,
  },
  hourglassIcon: { fontSize: 18 },
  waitingText: { fontSize: 13, color: Colors.primary, fontStyle: "italic", flex: 1 },

  // ── Participant waiting for host ───────────────────────────────────────────────
  waitingForHostBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 16,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  waitingForHostTitle: { fontSize: 14, fontWeight: "600" },
  waitingForHostSub: { fontSize: 12 },

  // ── Fun facts overlay ─────────────────────────────────────────────────────────
  factsOverlay: {
    flex: 1,
    paddingHorizontal: 24,
    paddingBottom: 36,
    justifyContent: "space-between",
  },
  factsHeader: {
    paddingTop: 20,
    alignItems: "center",
  },
  factsHeaderTitle: {
    fontSize: 22,
    fontWeight: "800",
    letterSpacing: -0.5,
  },
  factsCenter: {
    flex: 1,
    justifyContent: "center",
    gap: 16,
  },
  factsCard: {
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 28,
    gap: 14,
    minHeight: 180,
    justifyContent: "center",
  },
  factsLabel: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1.2,
  },
  factsText: {
    fontSize: 18,
    fontWeight: "500",
    lineHeight: 26,
  },
  factsDots: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
  },
  factsDot: {
    height: 7,
    borderRadius: 4,
  },
  factsBottom: {
    alignItems: "center",
    gap: 10,
    paddingTop: 4,
  },
  factsIconWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  factsNote: {
    fontSize: 16,
    fontWeight: "700",
    textAlign: "center",
    letterSpacing: -0.2,
  },
  factsSubNote: {
    fontSize: 13,
    textAlign: "center",
    lineHeight: 18,
  },
  forceExitButton: {
    position: "absolute",
    right: 22,
    bottom: 22,
    zIndex: 20,
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: "#EF4444",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },

  // ── Remove participant (host only) ───────────────────────────────────────────
  removeBtn: {
    padding: 6,
  },

  // ── Leave session ─────────────────────────────────────────────────────────────
  leaveBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 13,
    borderRadius: 12,
    borderWidth: 1,
  },
  leaveBtnText: { color: "#EF4444", fontSize: 13, fontWeight: "600" },

  // ── Pre-receipt lobby ─────────────────────────────────────────────────────────
  lobbySafe: { flex: 1 },
  lobbyHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 12,
  },
  lobbyHeaderCenter: {
    flex: 1,
    alignItems: "center",
    gap: 2,
    paddingHorizontal: 12,
  },
  lobbyHeaderTitle: { color: "#F9FAFB", fontSize: 15, fontWeight: "800" },
  lobbyHeaderSub: { color: "#9CA3AF", fontSize: 12, fontWeight: "500" },
  lobbyScroll: { paddingHorizontal: 16, paddingTop: 14, gap: 20 },
  lobbyInviteCard: {
    minHeight: 104,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#252A32",
    backgroundColor: "#15181D",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 16,
    shadowColor: "#000",
    shadowOpacity: 0.22,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 4,
  },
  lobbyInviteCopy: { flex: 1, gap: 7 },
  lobbyInviteTitle: { color: "#F9FAFB", fontSize: 15, fontWeight: "800" },
  lobbyInviteSub: { color: "#9CA3AF", fontSize: 12, fontWeight: "500" },
  lobbyInviteQr: {
    width: 92,
    height: 92,
    borderRadius: 10,
    backgroundColor: "#F9FAFB",
    alignItems: "center",
    justifyContent: "center",
  },
  qrModalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.88)",
    alignItems: "center",
    justifyContent: "center",
  },
  qrModalCard: {
    backgroundColor: "#fff",
    borderRadius: 20,
    padding: 24,
    alignItems: "center",
    gap: 16,
  },
  qrModalHint: { fontSize: 12, color: "#9CA3AF" },
  lobbyParticipantsBlock: { gap: 9 },
  lobbySectionLabel: { color: "#9CA3AF", fontSize: 13, fontWeight: "700" },
  lobbyParticipantsCard: {
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#252A32",
    backgroundColor: "#15181D",
    overflow: "hidden",
  },
  lobbyParticipantRow: {
    minHeight: 62,
    flexDirection: "row",
    alignItems: "center",
    paddingRight: 14,
    gap: 10,
  },
  lobbyParticipantAccent: {
    width: 3,
    alignSelf: "stretch",
  },
  lobbyAvatarRing: {
    width: 46,
    height: 46,
    borderRadius: 23,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  lobbyParticipantInfo: { flex: 1, gap: 3 },
  lobbyParticipantName: { color: "#F9FAFB", fontSize: 14, fontWeight: "800" },
  lobbyParticipantStatus: { color: "#9CA3AF", fontSize: 12, fontWeight: "500" },
  lobbyDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: "#252A32",
    marginLeft: 68,
  },
  lobbyBottomPanel: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: 0,
    borderColor: "#252A32",
    backgroundColor: "#15181D",
    paddingHorizontal: 16,
    paddingTop: 16,
    gap: 14,
    shadowColor: "#000",
    shadowOpacity: 0.38,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: -8 },
    elevation: 12,
  },
  lobbyBottomCopy: { flexDirection: "row", alignItems: "center", gap: 10 },
  lobbyBottomIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  lobbyBottomTitle: { color: "#F9FAFB", fontSize: 14, fontWeight: "800" },
  lobbyBottomSub: { color: "#9CA3AF", fontSize: 12, marginTop: 2, fontWeight: "500" },
  lobbyPrimaryButton: {
    minHeight: 56,
    borderRadius: 13,
    backgroundColor: "#6366F1",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    shadowColor: "#6366F1",
    shadowOpacity: 0.32,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 5,
  },
  lobbyPrimaryText: { color: "#fff", fontSize: 16, fontWeight: "800" },
  lobbyGuestWaiting: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingVertical: 14,
  },
  lobbyGuestWaitingText: { color: "#9CA3AF", fontSize: 13, fontWeight: "500" },

  // ── Fun facts (pre-receipt lobby) ─────────────────────────────────────────────
  lobbyFactsOverlay: {
    flex: 1,
    backgroundColor: "#0B0D10",
    paddingHorizontal: 24,
    paddingBottom: 36,
    justifyContent: "space-between",
  },
  lobbyFactsTitle: {
    fontSize: 26,
    fontWeight: "800",
    color: "#F9FAFB",
    letterSpacing: -0.5,
    textAlign: "center",
  },
  lobbyFactsSub: {
    fontSize: 14,
    color: "#9CA3AF",
    textAlign: "center",
    marginTop: 4,
    fontWeight: "500",
  },
  lobbyFactsCard: {
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#252A32",
    backgroundColor: "#15181D",
    padding: 28,
    gap: 14,
    minHeight: 180,
    justifyContent: "center",
  },
  lobbyFactsNote: {
    fontSize: 16,
    fontWeight: "700",
    color: "#F9FAFB",
    textAlign: "center",
    letterSpacing: -0.2,
  },
  lobbyFactsSubNote: {
    fontSize: 13,
    color: "#9CA3AF",
    textAlign: "center",
    lineHeight: 18,
  },
});
