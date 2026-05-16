import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  useColorScheme,
  Alert,
  Modal,
  Share,
  Platform,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "@/constants/colors";
import { useAuthStore } from "@/store/authStore";
import { Avatar } from "@/components/ui/Avatar";
import { formatCurrency, formatDate } from "@/utils/formatter";
import { useReceiptStore } from "@/store/receiptStore";
import { useSessionStore } from "@/store/sessionStore";
import { Session, SessionParticipant } from "@/types";
import { supabase } from "@/lib/supabase";
import { DevPanel } from "@/components/dev/DevPanel";
import { isDeveloperUser } from "@/constants/dev";
import { getColorForIndex } from "@/constants/colors";

export default function HomeScreen() {
  const isDark = useColorScheme() === "dark";
  const { profile, user, isGuest } = useAuthStore();
  const { clearReceipt } = useReceiptStore();
  const { clearSession, setSession, completedSessions, setViewingSession, removeCompletedSession, currentSession } = useSessionStore();

  const [showAllHistory, setShowAllHistory] = useState(false);
  const [billsExpanded, setBillsExpanded] = useState(true);
  const [billActionTarget, setBillActionTarget] = useState<Session | null>(null);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [showDevPanel, setShowDevPanel] = useState(false);
  const [rejoinSession, setRejoinSession] = useState<{
    id: string;
    restaurant: string | null;
    hostName: string;
  } | null>(null);
  const [isRejoining, setIsRejoining] = useState(false);

  const textColor = isDark ? Colors.textPrimaryDark : Colors.textPrimaryLight;
  const mutedColor = isDark ? Colors.textMutedDark : Colors.textMutedLight;
  const bgColor = isDark ? Colors.bgDark : Colors.bgLight;
  const borderColor = isDark ? Colors.cardBorderDark : Colors.cardBorderLight;


  // Query for rejoinable sessions when no active session is in store
  useEffect(() => {
    if (!profile?.id || currentSession) {
      setRejoinSession(null);
      return;
    }
    let cancelled = false;
    const checkRejoin = async () => {
      try {
        const { data } = await supabase
          .from("session_participants")
          .select("session_id, status, sessions!inner(id, status, receipt_data, created_at, host_id)")
          .eq("user_id", profile.id)
          .in("status", ["joined", "left"])
          .neq("sessions.status", "closed")
          .order("sessions.created_at", { foreignTable: "sessions", ascending: false })
          .limit(1);

        if (cancelled || !data || data.length === 0) { setRejoinSession(null); return; }
        const row = data[0] as any;
        const sessionRow = row.sessions;
        const { data: hostProfile } = await supabase
          .from("profiles")
          .select("name")
          .eq("id", sessionRow.host_id)
          .single();
        if (!cancelled) {
          setRejoinSession({
            id: row.session_id as string,
            restaurant: sessionRow.receipt_data?.restaurant ?? null,
            hostName: hostProfile?.name ?? "Host",
          });
        }
      } catch {
        // Non-critical — just don't show the banner
      }
    };
    checkRejoin();
    return () => { cancelled = true; };
  }, [profile?.id, currentSession]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRejoin = async () => {
    if (!rejoinSession || !profile) return;
    setIsRejoining(true);
    try {
      // Restore status to "joined"
      await supabase
        .from("session_participants")
        .update({ status: "joined" })
        .eq("session_id", rejoinSession.id)
        .eq("user_id", profile.id);

      // Load full session from DB
      const { data: sessionData, error } = await supabase
        .from("sessions")
        .select("*, session_participants(*)")
        .eq("id", rejoinSession.id)
        .single();

      if (error || !sessionData) throw new Error("Session not found");

      const participantRows: any[] = sessionData.session_participants ?? [];
      const userIds: string[] = participantRows.map((sp: any) => sp.user_id as string);

      const { data: profilesData } = await supabase
        .from("profiles")
        .select("id, name, color, avatar_icon, avatar_url, bill_credits, referral_count, is_pro")
        .in("id", userIds);
      const profileMap = new Map((profilesData ?? []).map((p: any) => [p.id as string, p]));

      const participants: SessionParticipant[] = participantRows.map((sp: any, idx: number) => {
        const p = profileMap.get(sp.user_id as string);
        return {
          userId: sp.user_id as string,
          profile: p
            ? {
                id: p.id,
                name: p.name ?? "User",
                color: p.color ?? getColorForIndex(idx),
                avatarIcon: p.avatar_icon ?? undefined,
                avatarUrl: p.avatar_url ?? undefined,
                billCredits: p.bill_credits ?? 0,
                referralCount: p.referral_count ?? 0,
                isPro: p.is_pro ?? false,
              }
            : {
                id: sp.user_id as string,
                name: "User",
                color: getColorForIndex(idx),
                billCredits: 0,
                referralCount: 0,
                isPro: false,
              },
          selections: (sp.selections as any[]) ?? [],
          totalOwed: (sp.total_owed as number) ?? 0,
          paid: (sp.paid as boolean) ?? false,
          confirmedByCreator: false,
        };
      });

      const rebuiltSession: Session = {
        id: sessionData.id,
        creatorId: sessionData.host_id,
        receiptId: sessionData.id,
        receipt: sessionData.receipt_data,
        status: sessionData.status,
        createdAt: sessionData.created_at,
        confirmedBy: [],
        participants,
      };

      setSession(rebuiltSession);
      setRejoinSession(null);

      if (sessionData.receipt_data) {
        router.push(`/(app)/session-lobby/${rejoinSession.id}`);
      } else {
        router.push(`/(app)/session/${rejoinSession.id}`);
      }
    } catch (err: any) {
      Alert.alert("Error", "Could not rejoin session. Please try again.");
    } finally {
      setIsRejoining(false);
    }
  };

  const handleStartNewSession = async () => {
    if (!user && !isGuest) {
      Alert.alert("Sign in required", "Please sign in to start a session.");
      return;
    }
    setIsCreatingSession(true);
    try {
      let sessionId: string;
      const creatorId = profile?.id ?? user?.id ?? `guest_${Date.now()}`;

      if (user) {
        console.log("[home] Starting session for user:", user.id);

        // VERIFY profile exists first — sessions.host_id has FK constraint
        console.log("[home] Verifying profile exists...");
        const { data: existingProfile } = await supabase
          .from("profiles")
          .select("id")
          .eq("id", user.id)
          .single();

        if (!existingProfile) {
          console.log("[home] Profile missing, creating...");
          const { error: createError } = await supabase
            .from("profiles")
            .insert({
              id: user.id,
              email: user.email,
              name: user.email?.split("@")[0] || "User",
              color: "#3B82F6",
              bill_credits: 3,
              avatar_icon: "👤",
              referral_count: 0,
              is_pro: false,
            });
          if (createError) {
            console.error("[home] Profile creation failed:", JSON.stringify(createError));
            throw new Error("Could not create profile. Please log out and log in again.");
          }
          console.log("[home] Profile created");
        } else {
          console.log("[home] Profile verified:", existingProfile.id);
        }

        // NOW create session
        console.log("[home] Inserting session row...");
        const { data, error } = await supabase
          .from("sessions")
          .insert({
            host_id: user.id,
            status: "waiting_participants",
          })
          .select("id")
          .single();
        if (error) {
          console.error("[home] sessions insert error:", JSON.stringify(error));
          throw new Error(error.message ?? "sessions insert failed");
        }
        sessionId = data.id;
        console.log("[home] Session created:", sessionId);

        console.log("[home] Inserting participant row...");
        const { error: pErr } = await supabase.from("session_participants").insert({
          session_id: sessionId,
          user_id: user.id,
          role: "host",
          status: "joined",
        });
        if (pErr) {
          console.error("[home] session_participants insert error:", JSON.stringify(pErr));
          throw new Error(pErr.message ?? "participant insert failed");
        }
      } else {
        sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      }

      const creatorProfile = profile ?? {
        id: creatorId,
        name: "You",
        avatarIcon: "person" as const,
        color: Colors.primary,
        billCredits: 0,
        referralCount: 0,
        isPro: false,
      };

      const emptySession: Session = {
        id: sessionId,
        creatorId,
        receiptId: sessionId,
        status: "draft",
        createdAt: new Date().toISOString(),
        confirmedBy: [creatorId],
        participants: [
          {
            userId: creatorId,
            profile: creatorProfile,
            selections: [],
            totalOwed: 0,
            paid: false,
            confirmedByCreator: true,
          },
        ],
      };

      setSession(emptySession);
      router.push(`/(app)/session/${sessionId}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[home] Session creation failed:", msg);
      Alert.alert("Could not start session", msg || "Please check your connection and try again.");
    } finally {
      setIsCreatingSession(false);
    }
  };

  const handleJoinQR = () => {
    router.push("/(app)/session/join");
  };

  const handleShareApp = async () => {
    const appLink =
      Platform.OS === "ios"
        ? "https://apps.apple.com/app/pickandpay/id123456789"
        : "https://play.google.com/store/apps/details?id=com.pickandpay";
    try {
      await Share.share({
        message: `Check out Pick&Pay - The easiest way for groups to split bills fairly and avoid awkward conversations. Join now and get 3 free bills to split.\n\n${appLink}`,
        title: "Try Pick&Pay",
      });
    } catch {
      // user dismissed
    }
  };

  const handleClearCache = () => {
    Alert.alert("Clear Cache", "Clear stored receipt and session data?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Clear",
        style: "destructive",
        onPress: () => {
          clearReceipt();
          clearSession();
          Alert.alert("Done", "Cache cleared.");
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: bgColor }]}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.header}>
          <View>
            <Text style={[styles.appName, { color: textColor }]}>Pick&Pay</Text>
            <Text style={[styles.tagline, { color: mutedColor }]}>Split bills effortlessly</Text>
          </View>
          <TouchableOpacity
            onPress={() => router.push("/(app)/profile")}
            style={styles.headerProfile}
            activeOpacity={0.8}
          >
            <View style={{ alignItems: "flex-end", gap: 1 }}>
              <Text style={[styles.greeting, { color: mutedColor }]}>
                {isGuest ? "Guest mode" : "Welcome back"}
              </Text>
              <Text style={[styles.userName, { color: textColor }]}>
                {profile?.name ?? (isGuest ? "Guest" : "")}
              </Text>
            </View>
            {profile ? (
              <Avatar
                name={profile.name}
                avatarIcon={profile.avatarIcon}
                avatarUrl={profile.avatarUrl}
                color={profile.color}
                size={44}
              />
            ) : (
              <View style={styles.profileFallback}>
                <Ionicons name="person-outline" size={22} color={Colors.primary} />
              </View>
            )}
          </TouchableOpacity>
        </View>

        {/* Active session banner — visible for all users with an ongoing session */}
        {currentSession && (
          <TouchableOpacity
            style={styles.activeSessionBanner}
            onPress={() => {
              // Navigate to the most relevant screen based on session state
              const allPicked =
                currentSession.receipt != null &&
                currentSession.participants.length > 0 &&
                currentSession.participants.every((p) => p.selections.length > 0);
              if (allPicked) {
                router.push(`/(app)/dashboard/${currentSession.id}?source=lobby`);
              } else if (currentSession.receipt) {
                router.push(`/(app)/session-lobby/${currentSession.id}`);
              } else {
                router.push(`/(app)/session/${currentSession.id}`);
              }
            }}
            activeOpacity={0.85}
          >
            <View style={styles.activeSessionDot} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.activeSessionTitle}>Active Session</Text>
              <Text style={styles.activeSessionSub}>
                {currentSession.participants.length} participant{currentSession.participants.length !== 1 ? "s" : ""}
                {currentSession.receipt?.restaurant ? ` · ${currentSession.receipt.restaurant}` : ""}
              </Text>
            </View>
            <Text style={styles.activeSessionReturn}>Return →</Text>
          </TouchableOpacity>
        )}

        {/* Rejoin session banner — shown when a previous session is still active */}
        {!currentSession && rejoinSession && (
          <TouchableOpacity
            style={styles.rejoinBanner}
            onPress={handleRejoin}
            disabled={isRejoining}
            activeOpacity={0.85}
          >
            <Ionicons name="return-down-forward-outline" size={20} color={Colors.primary} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.rejoinTitle}>Resume Session</Text>
              <Text style={styles.rejoinSub}>
                {rejoinSession.restaurant
                  ? `${rejoinSession.restaurant} · ${rejoinSession.hostName}`
                  : `Host: ${rejoinSession.hostName}`}
              </Text>
            </View>
            {isRejoining
              ? <ActivityIndicator size="small" color={Colors.primary} />
              : <Text style={styles.rejoinCta}>Rejoin →</Text>
            }
          </TouchableOpacity>
        )}

        {/* Main actions */}
        <TouchableOpacity
          style={[styles.primaryAction, isCreatingSession && { opacity: 0.7 }]}
          onPress={handleStartNewSession}
          activeOpacity={0.85}
          disabled={isCreatingSession}
        >
          <View style={styles.primaryActionInner}>
            <View style={styles.primaryIcon}>
              {isCreatingSession
                ? <ActivityIndicator color="#fff" />
                : <Ionicons name="people-outline" size={32} color="#fff" />
              }
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.primaryActionTitle}>Start a New Split Session</Text>
              <Text style={styles.primaryActionSub}>
                {isCreatingSession ? "Setting up session..." : "Share QR · Scan bill · Split"}
              </Text>
            </View>
            {!isCreatingSession && (
              <Ionicons name="arrow-forward" size={20} color="rgba(255,255,255,0.7)" />
            )}
          </View>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.secondaryAction, { borderColor }]}
          onPress={handleJoinQR}
          activeOpacity={0.85}
        >
          <Ionicons name="qr-code-outline" size={24} color={Colors.primary} />
          <Text style={[styles.secondaryActionText, { color: textColor }]}>
            Join with QR Code
          </Text>
          <Ionicons name="arrow-forward" size={18} color={mutedColor} />
        </TouchableOpacity>

        {/* Utility row */}
        <View style={styles.utilRow}>
          <TouchableOpacity
            style={[styles.utilBtn, { borderColor }]}
            onPress={handleShareApp}
            activeOpacity={0.8}
          >
            <Ionicons name="share-social-outline" size={18} color={mutedColor} />
            <Text style={[styles.utilBtnText, { color: mutedColor }]}>Share App</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.utilBtn, { borderColor }]}
            onPress={() => router.push("/onboarding")}
            activeOpacity={0.8}
          >
            <Ionicons name="book-outline" size={18} color={mutedColor} />
            <Text style={[styles.utilBtnText, { color: mutedColor }]}>How It Works</Text>
          </TouchableOpacity>
        </View>

        {/* Credits card — tap to go to paywall */}
        {!isGuest && profile && (
          <TouchableOpacity
            style={[styles.creditsCard, { borderColor: Colors.primary + "44" }]}
            onPress={() => router.push("/(app)/paywall")}
            activeOpacity={0.8}
          >
            <View style={styles.creditsCardLeft}>
              <Text style={[styles.creditsCardLabel, { color: mutedColor }]}>Your Credits</Text>
              <Text style={[styles.creditsCardCount, { color: Colors.primary }]}>
                {profile.billCredits}
              </Text>
              <Text style={[styles.creditsCardSub, { color: mutedColor }]}>bills remaining</Text>
            </View>
            <View style={styles.creditsCardRight}>
              <Text style={styles.creditsCardEmoji}>🪙</Text>
              <Text style={[styles.creditsCardBuy, { color: Colors.primary }]}>Buy More →</Text>
            </View>
          </TouchableOpacity>
        )}

        {/* Dev Panel trigger — visible in guest/demo mode or for developer email */}
        {(isGuest || isDeveloperUser(profile?.email)) && (
          <TouchableOpacity
            style={[styles.devPanelBtn, { borderColor: Colors.warning }]}
            onPress={() => setShowDevPanel(true)}
            activeOpacity={0.8}
          >
            <Text style={styles.devPanelIcon}>🧪</Text>
            <Text style={[styles.devPanelText, { color: Colors.warning }]}>
              Developer Panel
            </Text>
            <Ionicons name="chevron-forward" size={16} color={Colors.warning} />
          </TouchableOpacity>
        )}

        {/* Recent Bills */}
        {completedSessions.length > 0 && (() => {
          const displayed = showAllHistory ? completedSessions : completedSessions.slice(0, 3);
          return (
            <View style={styles.recentSection}>
              <TouchableOpacity
                style={styles.sectionHeader}
                onPress={() => setBillsExpanded((v) => !v)}
                activeOpacity={0.7}
              >
                <Text style={[styles.sectionTitle, { color: mutedColor }]}>
                  RECENT BILLS
                </Text>
                <Ionicons
                  name={billsExpanded ? "chevron-up" : "chevron-down"}
                  size={16}
                  color={mutedColor}
                />
              </TouchableOpacity>
              {billsExpanded && <View style={[styles.billsCard, { borderColor }]}>
                {displayed.map((session, idx) => {
                  const total = Object.values(session.receipt?.categories ?? {})
                    .flat()
                    .reduce((s, i) => s + i.totalPrice, 0)
                    + (session.receipt?.globalCosts ?? []).reduce((s, c) => s + c.amount, 0)
                    + (session.receipt?.selectedTip ?? 0);
                  return (
                    <TouchableOpacity
                      key={session.id}
                      style={[
                        styles.billRow,
                        idx < displayed.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: borderColor },
                      ]}
                      onPress={() => setBillActionTarget(session)}
                      activeOpacity={0.7}
                    >
                      <Ionicons name="document-text-outline" size={22} color={mutedColor} style={styles.billIcon} />
                      <View style={styles.billInfo}>
                        <View style={styles.billNameRow}>
                          <Text style={[styles.billName, { color: textColor }]} numberOfLines={1}>
                            {session.receipt?.restaurant ?? "Bill"}
                          </Text>
                          {session.participants.some((p) => !p.paid) && (
                            <View style={styles.unpaidDot} />
                          )}
                        </View>
                        <Text style={[styles.billMeta, { color: mutedColor }]}>
                          {session.participants.length > 0
                            ? `${session.participants.length} people · `
                            : ""}
                          {formatDate(session.createdAt)}
                          {session.participants.some((p) => !p.paid) ? " · Unpaid" : ""}
                        </Text>
                      </View>
                      <Text style={[styles.billTotal, { color: textColor }]}>
                        {formatCurrency(total, session.receipt?.currency ?? "EUR")}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>}
              {billsExpanded && completedSessions.length > 3 && (
                <TouchableOpacity
                  style={styles.viewAllBtn}
                  onPress={() => setShowAllHistory((v) => !v)}
                >
                  <Text style={[styles.viewAllText, { color: Colors.primary }]}>
                    {showAllHistory
                      ? "Show less"
                      : `View all history (${completedSessions.length}) →`}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          );
        })()}

        {/* Dev tools */}
        {__DEV__ && (
          <View style={styles.devSection}>
            <TouchableOpacity
              style={[styles.devClearBtn, { borderColor: mutedColor }]}
              onPress={handleClearCache}
            >
              <Text style={[styles.devClearText, { color: mutedColor }]}>
                🗑 Clear Cache (Dev)
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Report Bug / Suggestions — bottom of page */}
        <TouchableOpacity
          onPress={() => router.push("/(app)/report-bug")}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={styles.bugBtn}
          activeOpacity={0.7}
        >
          <Ionicons name="bug-outline" size={16} color={mutedColor} />
          <Text style={[styles.bugBtnText, { color: mutedColor }]}>Report Bug / Suggestion</Text>
        </TouchableOpacity>
      </ScrollView>
      {/* Dev Panel modal */}
      <DevPanel visible={showDevPanel} onClose={() => setShowDevPanel(false)} />

      {/* Bill action sheet */}
      {billActionTarget && (() => {
        const s = billActionTarget;
        const total = Object.values(s.receipt?.categories ?? {})
          .flat()
          .reduce((acc, i) => acc + i.totalPrice, 0)
          + (s.receipt?.globalCosts ?? []).reduce((acc, c) => acc + c.amount, 0)
          + (s.receipt?.selectedTip ?? 0);
        const isClosed = s.status === "closed";
        return (
          <Modal transparent animationType="slide" visible onRequestClose={() => setBillActionTarget(null)}>
            <TouchableOpacity
              style={styles.sheetOverlay}
              activeOpacity={1}
              onPress={() => setBillActionTarget(null)}
            />
            <View style={[styles.actionSheet, { backgroundColor: isDark ? Colors.cardDark : Colors.cardLight }]}>
              <View style={[styles.sheetHandle, { backgroundColor: borderColor }]} />
              <Text style={[styles.sheetTitle, { color: isDark ? Colors.textPrimaryDark : Colors.textPrimaryLight }]} numberOfLines={1}>
                {s.receipt?.restaurant ?? "Bill"} · {formatCurrency(total, s.receipt?.currency ?? "EUR")}
              </Text>

              <TouchableOpacity
                style={[styles.sheetOption, { backgroundColor: "#6366F1" }]}
                onPress={() => {
                  setBillActionTarget(null);
                  setViewingSession(s);
                  router.push(`/(app)/dashboard/${s.id}?readOnly=true`);
                }}
              >
                <Text style={styles.sheetOptionEmoji}>📊</Text>
                <Text style={[styles.sheetOptionText, { color: "#fff" }]}>View Split</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.sheetOption, { backgroundColor: "#EF4444" }]}
                onPress={() => {
                  Alert.alert("Delete from History", "Remove this bill from your history?", [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Delete",
                      style: "destructive",
                      onPress: () => {
                        removeCompletedSession(s.id);
                        setBillActionTarget(null);
                      },
                    },
                  ]);
                }}
              >
                <Text style={styles.sheetOptionEmoji}>🗑️</Text>
                <Text style={[styles.sheetOptionText, { color: "#fff" }]}>Delete from History</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.sheetCancel, { backgroundColor: "#6B7280" }]}
                onPress={() => setBillActionTarget(null)}
              >
                <Text style={[styles.sheetCancelText, { color: "#fff" }]}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </Modal>
        );
      })()}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  scroll: {
    flexGrow: 1,
    paddingHorizontal: 20,
    paddingBottom: 40,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingTop: 20,
    paddingBottom: 28,
  },
  headerProfile: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  userName: {
    fontSize: 14,
    fontWeight: "700",
  },
  devPanelBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: "dashed",
    marginVertical: 4,
  },
  devPanelIcon: { fontSize: 16 },
  devPanelText: { flex: 1, fontSize: 14, fontWeight: "600" },
  profileFallback: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.primary + "22",
    alignItems: "center",
    justifyContent: "center",
  },
  bugBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 8,
    marginTop: 8,
  },
  bugBtnText: {
    fontSize: 13,
    fontWeight: "500",
  },
  greeting: {
    fontSize: 14,
    fontWeight: "500",
  },
  appName: {
    fontSize: 28,
    fontWeight: "800",
    letterSpacing: -0.5,
  },
  tagline: {
    fontSize: 13,
    fontWeight: "500",
    marginTop: 2,
  },
  primaryAction: {
    backgroundColor: Colors.primary,
    borderRadius: 18,
    marginBottom: 14,
    overflow: "hidden",
  },
  primaryActionInner: {
    flexDirection: "row",
    alignItems: "center",
    padding: 20,
    gap: 16,
  },
  primaryIcon: {
    width: 52,
    height: 52,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.2)",
    alignItems: "center",
    justifyContent: "center",
  },
  primaryActionTitle: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "700",
  },
  primaryActionSub: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 13,
    marginTop: 2,
  },
  secondaryAction: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 16,
    paddingHorizontal: 20,
    borderRadius: 16,
    borderWidth: 1.5,
    gap: 12,
    marginBottom: 24,
  },
  secondaryActionText: {
    flex: 1,
    fontSize: 16,
    fontWeight: "600",
  },
  utilRow: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 24,
    marginTop: -10,
  },
  utilBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
  },
  utilBtnText: {
    fontSize: 13,
    fontWeight: "600",
  },
  creditsCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: Colors.primary + "0A",
    marginBottom: 16,
    marginTop: -8,
  },
  creditsCardLeft: {
    gap: 2,
    flex: 1,
  },
  creditsCardLabel: {
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  creditsCardCount: {
    fontSize: 32,
    fontWeight: "900",
  },
  creditsCardSub: {
    fontSize: 12,
    fontWeight: "500",
  },
  creditsCardRight: {
    alignItems: "center",
    gap: 6,
  },
  creditsCardEmoji: {
    fontSize: 36,
  },
  creditsCardBuy: {
    fontSize: 13,
    fontWeight: "700",
  },
  recentSection: {
    gap: 8,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  billsCard: {
    borderWidth: 1,
    borderRadius: 14,
    overflow: "hidden",
  },
  billRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  billIcon: {
    width: 22,
  },
  billInfo: {
    flex: 1,
    gap: 3,
  },
  billNameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  billName: {
    fontSize: 15,
    fontWeight: "600",
    flexShrink: 1,
  },
  unpaidDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#F59E0B",
    flexShrink: 0,
  },
  billMeta: {
    fontSize: 12,
  },
  billTotal: {
    fontSize: 15,
    fontWeight: "700",
  },
  viewAllBtn: {
    alignSelf: "flex-end",
    paddingVertical: 4,
  },
  viewAllText: {
    fontSize: 13,
    fontWeight: "600",
  },
  devSection: {
    alignItems: "center",
    paddingVertical: 20,
  },
  devClearBtn: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    borderStyle: "dashed",
  },
  devClearText: {
    fontSize: 12,
    fontWeight: "500",
  },

  // ── Bill action sheet ────────────────────────────────────────────────────────
  sheetOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  actionSheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingBottom: 36,
    paddingHorizontal: 16,
    paddingTop: 10,
    gap: 6,
  },
  sheetHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    alignSelf: "center",
    marginBottom: 12,
  },
  sheetTitle: {
    fontSize: 15,
    fontWeight: "700",
    marginBottom: 6,
    paddingHorizontal: 4,
  },
  sheetOption: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 12,
  },
  sheetOptionEmoji: {
    fontSize: 18,
  },
  sheetOptionText: {
    fontSize: 15,
    fontWeight: "700",
  },
  sheetCancel: {
    alignItems: "center",
    paddingVertical: 14,
    borderRadius: 12,
    marginTop: 4,
  },
  sheetCancelText: {
    fontSize: 15,
    fontWeight: "700",
  },

  // ── Rejoin session banner ─────────────────────────────────────────────────────
  rejoinBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: Colors.primary + "55",
    backgroundColor: Colors.primary + "0D",
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginBottom: 14,
  },
  rejoinTitle: {
    color: Colors.primary,
    fontSize: 14,
    fontWeight: "700",
  },
  rejoinSub: {
    fontSize: 12,
    color: Colors.primary + "99",
  },
  rejoinCta: {
    color: Colors.primary,
    fontSize: 14,
    fontWeight: "700",
  },

  // ── Active session banner ─────────────────────────────────────────────────────
  activeSessionBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: Colors.primary,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 16,
    marginBottom: 14,
  },
  activeSessionDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#10B981",
  },
  activeSessionTitle: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "700",
  },
  activeSessionSub: {
    fontSize: 12,
    color: "rgba(255,255,255,0.7)",
  },
  activeSessionReturn: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "700",
  },
});
