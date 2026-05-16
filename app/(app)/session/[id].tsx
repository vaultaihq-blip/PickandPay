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
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
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
import { getColorForIndex } from "@/constants/colors";
import { formatCurrency, formatDate } from "@/utils/formatter";
import { buildSessionLink, buildSessionShareText } from "@/lib/deeplink";
import { supabase } from "@/lib/supabase";
import { isDeveloperUser } from "@/constants/dev";

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
  "In France, asking for separate bills is considered a bit rude. Thank goodness for SplitMate.",
  "People are 3× more likely to order dessert when they know the bill is being split.",
  "The average group dinner has at least one person who 'forgot their wallet.' Be the hero.",
  "Fun fact: Dutch courage has nothing to do with splitting bills, but 'going Dutch' does.",
];

export default function SessionScreen() {
  const { id, redirectToSelection } = useLocalSearchParams<{ id: string; redirectToSelection?: string }>();
  const isDark = useColorScheme() === "dark";
  const { width } = useWindowDimensions();
  const { currentSession, updateSelections, recalculateSplit, addParticipant, clearSession, setSession } = useSessionStore();
  const { profile, isGuest } = useAuthStore();

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

  const rotateAnim = useRef(new Animated.Value(0)).current;
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  // Kept in sync every render so stale broadcast closures can read latest value
  const isCreatorRef = useRef(false);
  // Holds a receipt that needs to be broadcast as soon as bcChannel subscribes
  const pendingReceiptBroadcastRef = useRef<any>(null);
  // True once the current bcChannel has reached SUBSCRIBED state
  const bcSubscribedRef = useRef(false);

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

  // Real-time subscription: watch for new participants joining via QR
  useEffect(() => {
    if (!id || id.startsWith("session_")) return;

    // --- postgres_changes channel (unique per mount to avoid "after subscribed" error) ---
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
                  color: p.color ?? getColorForIndex(0),
                  avatarIcon: p.avatar_icon ?? undefined,
                  avatarUrl: p.avatar_url ?? undefined,
                  billCredits: p.bill_credits ?? 0,
                  referralCount: p.referral_count ?? 0,
                  isPro: p.is_pro ?? false,
                }
              : {
                  id: newUserId,
                  name: "User",
                  color: getColorForIndex(0),
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
        (payload) => {
          const updatedUserId = payload.new?.user_id as string | undefined;
          const newStatus = payload.new?.status as string | undefined;
          if (!updatedUserId) return;
          if (newStatus === "joined") {
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
          } else if (newStatus === "left") {
            console.log("[session] Participant left:", updatedUserId);
            setLeftUserIds((prev) => new Set([...prev, updatedUserId]));
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
          // Reliable fallback: detect when host writes receipt_data to DB
          const receiptData = payload.new?.receipt_data;
          if (receiptData && !isCreatorRef.current) {
            const sess = useSessionStore.getState().currentSession;
            if (sess && !sess.receipt) {
              useSessionStore.getState().setSession({ ...sess, receipt: receiptData });
              router.replace(`/(app)/session-lobby/${id}`);
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
          useSessionStore.getState().setSession({ ...sess, receipt: payload.receipt });
          // Non-host participants go directly to the shared lobby when receipt is ready
          if (!isCreatorRef.current) {
            router.replace(`/(app)/session-lobby/${id}`);
          }
        }
      })
      .on("broadcast", { event: "host_left" }, () => {
        Alert.alert(
          "Session Ended",
          "The host has ended the session.",
          [{ text: "OK", onPress: () => { clearSession(); router.replace("/(app)"); } }]
        );
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

  // After host confirms receipt, auto-redirect them to their own selection screen.
  // The session screen is briefly visited so useFocusEffect can broadcast receipt_ready.
  useEffect(() => {
    if (redirectToSelection !== "1") return;
    if (!receipt || !realProfile?.id || !id) return;
    router.replace(`/(app)/session-lobby/${id}`);
  }, [redirectToSelection, receipt, realProfile?.id, id]);
  const participantCount = session?.participants.length ?? 0;
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

  const handleHostBack = () => {
    if (isCreator) {
      Alert.alert(
        "End Session?",
        "Leaving will end the session for all participants.",
        [
          { text: "Stay", style: "cancel" },
          {
            text: "End Session",
            style: "destructive",
            onPress: () => {
              channelRef.current?.send({ type: "broadcast", event: "host_left", payload: {} });
              clearSession();
              router.replace("/(app)");
            },
          },
        ]
      );
    } else {
      router.back();
    }
  };

  const handleLeaveSession = () => {
    Alert.alert("Leave Session?", "You can rejoin later from the home screen.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Leave",
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
    const restaurant = receipt?.restaurant ?? "Pick&Pay Split";
    const text = buildSessionShareText(id ?? "", restaurant);
    try {
      await Share.share({ message: text, title: "Join Split Session" });
    } catch (err) {
      console.error(err);
    }
  };

  if (!session) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: bgColor }]}>
        <View style={styles.emptyContainer}>
          <Text style={[styles.emptyText, { color: mutedColor }]}>Session not found.</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: bgColor }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={handleHostBack}>
          <Ionicons name="arrow-back" size={24} color={textColor} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={[styles.headerTitle, { color: textColor }]} numberOfLines={1}>
            Split Session
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
                <Text style={styles.lockedBadgeText}>Locked</Text>
              </View>
            )}
          </View>
        )}

        {/* ── QR Code (prominent, top) ─────────────────────────────────────── */}
        <View style={styles.qrSection}>
          <QRGenerator value={qrValue} size={qrSize} />
          <Text style={[styles.qrHint, { color: mutedColor }]}>
            Scan to join this split
          </Text>
          <TouchableOpacity style={[styles.shareQrBtn, { borderColor: Colors.primary }]} onPress={handleShare}>
            <Ionicons name="share-outline" size={16} color={Colors.primary} />
            <Text style={styles.shareQrText}>Share Link</Text>
          </TouchableOpacity>
        </View>

        {/* ── Participants ─────────────────────────────────────────────────── */}
        <View style={styles.participantsSection}>
          <Text style={[styles.sectionTitle, { color: mutedColor }]}>
            PEOPLE IN THIS SPLIT ({participantCount})
          </Text>

          <Card style={styles.participantsCard} padding={0}>
            {session.participants.map((p, index) => {
              const hasDoneSelections = p.selections.length > 0;
              const isLast = index === session.participants.length - 1;
              const isHost = p.userId === session.creatorId;
              const isPending = pendingUserIds.has(p.userId);
              const hasLeft = leftUserIds.has(p.userId);
              return (
                <View key={p.userId}>
                  <View style={[styles.participantRow, hasLeft && { opacity: 0.5 }]}>
                    <View style={[styles.participantAccent, { backgroundColor: hasLeft ? mutedColor : p.profile.color }]} />
                    <Avatar
                      name={p.profile.name}
                      avatarIcon={p.profile.avatarIcon}
                      avatarUrl={p.profile.avatarUrl}
                      color={p.profile.color}
                      size={40}
                    />
                    <View style={styles.participantInfo}>
                      <View style={styles.participantNameRow}>
                        <Text style={[styles.participantName, { color: textColor }]} numberOfLines={1}>
                          {p.profile.name}
                        </Text>
                        {isHost && (
                          <View style={styles.hostBadge}>
                            <Text style={styles.hostBadgeText}>Host</Text>
                          </View>
                        )}
                      </View>
                      {hasLeft ? (
                        <Text style={[styles.joiningText, { color: mutedColor }]}>Left the session</Text>
                      ) : isPending ? (
                        <Text style={[styles.joiningText, { color: mutedColor }]}>⏳ Joining...</Text>
                      ) : hasDoneSelections ? (
                        <Text style={[styles.selectionsDone, { color: Colors.success }]}>
                          ✓ {p.selections.length} item{p.selections.length > 1 ? "s" : ""} selected
                        </Text>
                      ) : (
                        <Text style={styles.joinedText}>✓ Joined</Text>
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
                          {hasDoneSelections ? "Edit" : "Select →"}
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
                  Waiting for people to join...
                </Text>
              </View>
            )}
          </Card>

          {(isGuest || isDeveloperUser(profile?.email)) && (
            <TestModeBar
              onActiveUserChange={setTestActiveProfile}
              sessionId={id ?? ""}
              hasReceipt={!!receipt}
            />
          )}

          {/* Dev: force lock + go to lobby — uses real profile, bypasses isCreator check */}
          {(isGuest || isDeveloperUser(profile?.email)) && !sessionLocked && (
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
              <Text style={styles.waitingText}>Waiting for everyone to join...</Text>
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
            <Text style={[styles.summaryTitle, { color: textColor }]}>Receipt Summary</Text>
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
              <Text style={styles.lockBtnText}>Everyone's Here</Text>
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
                style={styles.scanBillBtn}
                onPress={() => router.push("/(app)/scan")}
                activeOpacity={0.85}
              >
                <Ionicons name="scan-outline" size={22} color="#fff" />
                <Text style={styles.scanBillBtnText}>Scan Our Bill →</Text>
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
                <Text style={styles.splitBtnText}>Review & Accept</Text>
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
            <Text style={styles.splitBtnText}>Review & Accept</Text>
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
                {sessionLocked ? "Host is scanning the bill..." : "Waiting for the session to lock"}
              </Text>
              <Text style={[styles.waitingForHostSub, { color: mutedColor }]}>
                {sessionLocked
                  ? "You'll be notified when it's ready to review."
                  : "The host will lock the session when everyone's here."}
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
            <Text style={styles.leaveBtnText}>Leave Session</Text>
          </TouchableOpacity>
        )}

        {/* ── End Session — host only ───────────────────────────────────── */}
        {isCreator && (
          <TouchableOpacity
            style={[styles.leaveBtn, { borderColor: "#EF444480" }]}
            onPress={() => {
              Alert.alert(
                "End Session?",
                "This will end the session for all participants and cannot be undone.",
                [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "End Session",
                    style: "destructive",
                    onPress: () => {
                      channelRef.current?.send({ type: "broadcast", event: "host_left", payload: {} });
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
            <Text style={styles.leaveBtnText}>End Session</Text>
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
                        <Text style={styles.takeoverBtnText}>Take Over</Text>
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
          <View style={styles.factsHeader}>
            <Text style={[styles.factsHeaderTitle, { color: textColor }]}>Sit tight...</Text>
          </View>

          {/* DID YOU KNOW card — center of screen */}
          <View style={styles.factsCenter}>
            <View style={[styles.factsCard, { backgroundColor: cardColor, borderColor }]}>
              <Text style={[styles.factsLabel, { color: mutedColor }]}>DID YOU KNOW?</Text>
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
            <Text style={[styles.factsNote, { color: textColor }]}>
              Host is working on the group bill
            </Text>
            <Text style={[styles.factsSubNote, { color: mutedColor }]}>
              You'll be redirected as soon as they finish.
            </Text>
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
                  Take Over {target.profile.name}'s Bill?
                </Text>
                <Text style={[styles.modalSubtitle, { color: mutedColor }]}>
                  You'll pay for both bills and sort it out with them later.
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
                    <Text style={[styles.takeoverLineLabel, { color: mutedColor }]}>Your current bill</Text>
                    <Text style={[styles.takeoverLineAmt, { color: textColor }]}>
                      {formatCurrency(takerTotal, currency)}
                    </Text>
                  </View>
                  <View style={[styles.takeoverDivider, { backgroundColor: borderColor }]} />
                  <View style={styles.takeoverLine}>
                    <Text style={[styles.takeoverLineLabelBold, { color: textColor }]}>
                      After taking over
                    </Text>
                    <Text style={[styles.takeoverLineAmtBold, { color: Colors.primary }]}>
                      {formatCurrency(combined, currency)}
                    </Text>
                  </View>
                </View>

                <Text style={[styles.takeoverWarning, { color: Colors.warning }]}>
                  ⚠️ Sort it out with {target.profile.name} later
                </Text>

                <View style={styles.modalActions}>
                  <TouchableOpacity
                    style={[styles.skipBtn, { borderColor }]}
                    onPress={() => setTakeoverTarget(null)}
                  >
                    <Text style={[styles.skipBtnText, { color: mutedColor }]}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.applyBtn}
                    onPress={() => {
                      // In a real app this would call supabase to update covered_by
                      // For now we navigate to selection for the target user
                      setTakeoverTarget(null);
                      router.push(`/(app)/selection/${id}?userId=${takeoverTarget}`);
                    }}
                  >
                    <Text style={styles.applyBtnText}>Confirm Take Over</Text>
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
                Some items weren't selected
              </Text>
            </View>
            <Text style={[styles.modalSubtitle, { color: mutedColor }]}>
              Assign each item to a participant or skip.
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
                <Text style={[styles.skipBtnText, { color: mutedColor }]}>Skip anyway</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.applyBtn,
                  itemAssignments.size < unassignedItems.length && { opacity: 0.5 },
                ]}
                onPress={handleApplyAssignments}
              >
                <Text style={styles.applyBtnText}>Apply & Split</Text>
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
});
