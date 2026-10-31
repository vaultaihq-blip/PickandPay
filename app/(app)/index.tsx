import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  useColorScheme,
  Modal,
  Share,
  Platform,
  ActivityIndicator,
  Image,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { router, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "@/constants/colors";
import { useAuthStore } from "@/store/authStore";
import { Avatar } from "@/components/ui/Avatar";
import { formatCurrency, formatDate } from "@/utils/formatter";
import { useReceiptStore } from "@/store/receiptStore";
import { useSessionStore } from "@/store/sessionStore";
import { Session, SessionParticipant } from "@/types";
import { supabase } from "@/lib/supabase";
import { expectRows, showWriteError, WriteError } from "@/lib/checkedWrite";
import { ensureCreditsForNewSession, fetchFreshCredits, isNoCreditsError, showNoCreditsDialog } from "@/lib/credits";
import { DevPanel } from "@/components/dev/DevPanel";
import { isDeveloperUser, DEV_PIN } from "@/constants/dev";
import { useI18nStore } from "@/store/i18nStore";
import { getColorForIndex } from "@/constants/colors";
import { BottomNavBar } from "@/components/ui/BottomNavBar";
import { showDialog } from "@/lib/dialog";

const HOME_THEME = {
  background: "#0A0A0F",
  card: "#1A1B26",
  cardPrimary: "#2A2D5F",
  border: "#252A32",
  primary: "#5B68F4",
  success: "#10B981",
  warning: "#F59E0B",
  text: "#FFFFFF",
  secondary: "#8B8FA3",
  muted: "#6B7280",
  teal: "#2DD4BF",
};

const tokenImg = require("@/assets/images/token.png");


function getRestaurantInitials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "SM";
}

function formatHistoryDate(date: string) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "Today";
  const today = new Date();
  const isToday =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  const month = d.toLocaleString("en-US", { month: "short" });
  const day = d.getDate();
  const year = String(d.getFullYear()).slice(-2);
  return `${isToday ? "Today, " : ""}${month} ${day}/${year}`;
}

export default function HomeScreen() {
  const isDark = useColorScheme() === "dark";
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const { profile, user } = useAuthStore();
  // The balance shown is the server's: read again each time home opens.
  useFocusEffect(
    useCallback(() => {
      if (profile?.id) void fetchFreshCredits(profile.id);
    }, [profile?.id])
  );
  const { t, language } = useI18nStore();
  void language;
  const { clearReceipt } = useReceiptStore();
  const { clearSession, setSession, completedSessions, setViewingSession, removeCompletedSession, currentSession } = useSessionStore();

  const [showAllHistory, setShowAllHistory] = useState(false);
  const [billsExpanded, setBillsExpanded] = useState(true);
  const [billActionTarget, setBillActionTarget] = useState<Session | null>(null);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [showDevPanel, setShowDevPanel] = useState(false);
  const [showPinModal, setShowPinModal] = useState(false);
  const [pinValue, setPinValue] = useState("");
  const [pinError, setPinError] = useState(false);
  const [rejoinSession, setRejoinSession] = useState<{
    id: string;
    restaurant: string | null;
    hostName: string;
    myStatus: string | null;
  } | null>(null);
  const [isRejoining, setIsRejoining] = useState(false);
  const [carouselIdx, setCarouselIdx] = useState(0);

  const textColor = isDark ? Colors.textPrimaryDark : Colors.textPrimaryLight;
  const mutedColor = isDark ? Colors.textMutedDark : Colors.textMutedLight;
  const borderColor = isDark ? Colors.cardBorderDark : Colors.cardBorderLight;
  const cardColor = isDark ? Colors.cardDark : Colors.cardLight;

  useEffect(() => {
    const timer = setInterval(() => setCarouselIdx((i) => (i + 1) % 4), 3000);
    return () => clearInterval(timer);
  }, []);

  // Query for rejoinable sessions when no active session is in store. R7: the
  // same rule as the QR's "already part of it" (my_rejoinable_session on the
  // server): current or original host, still in it, or left after paying.
  useEffect(() => {
    if (!profile?.id || currentSession) {
      setRejoinSession(null);
      return;
    }
    let cancelled = false;
    const checkRejoin = async () => {
      try {
        const { data, error } = await supabase.rpc("my_rejoinable_session");
        if (error) console.log(`[home] rejoinable-session lookup failed: ${error.message}`);
        const row = (data ?? null) as { session_id?: string; host_name?: string | null; restaurant?: string | null; my_status?: string | null } | null;
        if (cancelled) return;
        if (!row?.session_id) { setRejoinSession(null); return; }
        setRejoinSession({
          id: row.session_id,
          restaurant: row.restaurant ?? null,
          hostName: row.host_name ?? "Host",
          myStatus: row.my_status ?? null,
        });
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
      // A1 — still in it (joined, selecting, items_picked): the status stays
      // as it is, so items already picked are not taken back. Only someone
      // who left (after paying) or was pending is written back to joined.
      const st = rejoinSession.myStatus;
      if (st === "joined" || st === "selecting" || st === "items_picked") {
        console.log(`[home] rejoin: status kept (${st})`);
      } else {
        await expectRows(
          `home: rejoin (${st ?? "?"} → joined)`,
          supabase
            .from("session_participants")
            .update({ status: "joined" })
            .eq("session_id", rejoinSession.id)
            .eq("user_id", profile.id)
            .select("id")
        );
      }

      const { data: sessionData, error } = await supabase
        .from("sessions")
        .select("*, session_participants(*)")
        .eq("id", rejoinSession.id)
        .single();

      if (error || !sessionData) throw new Error("Session not found");

      // Someone still pending (scanned, not confirmed) or cancelled is not a
      // participant, and must not count in the split's divisor (C.2).
      const participantRows: any[] = (sessionData.session_participants ?? []).filter(
        (sp: any) => sp.status !== "cancelled" && sp.status !== "pending"
      );
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

      router.push(`/(app)/session-lobby/${rejoinSession.id}`);
    } catch (err: any) {
      // R3: coming back after leaving needs a credit (the server refuses left → joined at 0).
      if (isNoCreditsError(err)) showNoCreditsDialog(t);
      else if (err instanceof WriteError) showWriteError(err, t);
      else showDialog(t("error"), t("home_rejoin_error"));
    } finally {
      setIsRejoining(false);
    }
  };

  const handleStartNewSession = async () => {
    if (!user) {
      showDialog(t("error"), t("home_sign_in_msg"));
      return;
    }
    if (isCreatingSession) return;
    setIsCreatingSession(true);
    // R3: no new session at 0 credits (fresh balance; the server refuses too).
    if (!(await ensureCreditsForNewSession(user.id, t))) {
      setIsCreatingSession(false);
      return;
    }
    try {
      let sessionId: string;
      const creatorId = profile?.id ?? user?.id ?? `guest_${Date.now()}`;

      if (user) {
        if (__DEV__) console.log("[home] Starting session for user:", user.id);

        if (__DEV__) console.log("[home] Verifying profile exists...");
        const { data: existingProfile } = await supabase
          .from("profiles")
          .select("id")
          .eq("id", user.id)
          .single();

        if (!existingProfile) {
          if (__DEV__) console.log("[home] Profile missing, creating...");
          const { error: createError } = await supabase
            .from("profiles")
            .insert({
              id: user.id,
              email: user.email,
              name: user.email?.split("@")[0] || "User",
              color: "#3B82F6",
              // bill_credits / is_pro / referral_count are server-owned: the
              // profile trigger forces 0/false on client inserts, and
              // initialize-user-credits grants the sign-up credits.
              avatar_icon: "👤",
            });
          if (createError) {
            console.error("[home] Profile creation failed:", JSON.stringify(createError));
            throw new Error("Could not create profile. Please log out and log in again.");
          }
          if (__DEV__) console.log("[home] Profile created");
        } else {
          if (__DEV__) console.log("[home] Profile verified:", existingProfile.id);
        }

        if (__DEV__) console.log("[home] Inserting session row...");
        const { data, error } = await supabase
          .from("sessions")
          .insert({
            host_id: user.id,
            status: "draft",
          })
          .select("id")
          .single();
        if (error) {
          console.error("[home] sessions insert error:", JSON.stringify(error));
          if (isNoCreditsError(error)) {
            showNoCreditsDialog(t);
            return;
          }
          throw new Error(error.message ?? "sessions insert failed");
        }
        sessionId = data.id;
        if (__DEV__) console.log("[home] Session created:", sessionId);

        if (__DEV__) console.log("[home] Inserting participant row...");
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
      router.push("/(app)/scan");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[home] Session creation failed:", msg);
      showDialog(t("error_start_session"), msg || t("error_connection"));
    } finally {
      setIsCreatingSession(false);
    }
  };

  const handleJoinQR = () => {
    // R7: the scanner opens at any balance; after the scan the entry screen
    // shows what the server says (rejoin, join, no credits, ended, full).
    router.push("/(app)/session/join");
  };

  const handleShareApp = async () => {
    const appStoreId = process.env.EXPO_PUBLIC_APP_STORE_ID;
    if (Platform.OS === "ios" && !appStoreId) return; // App Store listing not live yet
    const appLink =
      Platform.OS === "ios"
        ? `https://apps.apple.com/app/pickandpay/id${appStoreId}`
        : "https://play.google.com/store/apps/details?id=com.pickandpay.app";
    try {
      await Share.share({
        message: `${t("home_share_msg")}\n\n${appLink}`,
        title: "Try Pick&Pay",
      });
    } catch {
      // user dismissed
    }
  };

  const handleClearCache = () => {
    showDialog(t("home_clear_cache"), t("home_clear_cache_msg"), [
      { text: t("cancel"), style: "cancel" },
      {
        text: t("home_clear_btn"),
        style: "destructive",
        onPress: () => {
          clearReceipt();
          clearSession();
          showDialog(t("done"), t("home_cache_cleared"));
        },
      },
    ]);
  };

  const firstName =
    profile?.name || (user?.email ? user.email.split("@")[0] : "");
  const creditCount = profile?.billCredits ?? 0;
  const activeSessionPeople = currentSession?.participants.length ?? 0;
  const activeSessionRestaurant = currentSession?.receipt?.restaurant ?? "";
  const totalSaved = completedSessions.reduce((sum, session) => {
    const participantCount = session.participants.length || 1;
    const userParticipant = session.participants.find((p) => p.userId === profile?.id);
    if (!userParticipant) return sum;
    const total =
      Object.values(session.receipt?.categories ?? {})
        .flat()
        .reduce((s, i) => s + i.totalPrice, 0) +
      (session.receipt?.globalCosts ?? []).reduce((s, c) => s + c.amount, 0) +
      (session.receipt?.selectedTip ?? 0);
    const equalShare = total / participantCount;
    return sum + Math.max(0, equalShare - (userParticipant.totalOwed ?? 0));
  }, 0);

  const dominantCurrency = (() => {
    if (completedSessions.length === 0) return "EUR" as const;
    const counts: Record<string, number> = {};
    for (const s of completedSessions) {
      const c = s.receipt?.currency ?? "EUR";
      counts[c] = (counts[c] || 0) + 1;
    }
    return (Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]) as "EUR" | "USD" | "GBP" | "CAD";
  })();

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" backgroundColor={HOME_THEME.background} translucent={false} />
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingBottom: 112 + Math.max(insets.bottom, 16) },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity
            onPress={() => { if (isDeveloperUser(profile?.email)) setShowPinModal(true); }}
            activeOpacity={1}
            style={styles.brandBlock}
          >
            <Text style={styles.appName}>
              Pick<Text style={styles.logoAmp}>&</Text>Pay
            </Text>
            <Text style={styles.appMotto}>{t("home_motto")}</Text>
          </TouchableOpacity>
          <View style={styles.profileCluster}>
            <View style={styles.profileGreeting}>
              <Text style={styles.profileGreetingText}>
                {(() => { const h = new Date().getHours(); return h < 12 ? t("greeting_morning") : h < 18 ? t("greeting_afternoon") : t("greeting_evening"); })()}
              </Text>
              <Text style={styles.profileNameText} numberOfLines={1}>{firstName}</Text>
            </View>
            <TouchableOpacity
              onPress={() => router.push("/(app)/profile")}
              activeOpacity={0.8}
            >
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
                  <Text style={styles.profileFallbackText}>{firstName.slice(0, 1).toUpperCase()}</Text>
                </View>
              )}
            </TouchableOpacity>
          </View>
        </View>

        <View style={[styles.homeCore, { minHeight: Math.max(420, height - 250) }]}>
          {/* Main actions */}
          <TouchableOpacity
            style={[styles.primaryAction, isCreatingSession && { opacity: 0.7 }]}
            onPress={handleStartNewSession}
            activeOpacity={0.85}
            disabled={isCreatingSession}
          >
            <View style={styles.primaryActionInner}>
              <View style={styles.actionCardIcon}>
                <Ionicons name="receipt-outline" size={26} color="#fff" />
                <Text style={styles.actionCardEuroBadge}>{"€"}</Text>
              </View>
              <View style={styles.primaryActionCopy}>
                <Text style={styles.primaryActionTitle}>{t("home_start_split")}</Text>
                <Text style={styles.primaryActionSub}>
                  {isCreatingSession ? t("home_creating_session") : t("home_start_subtitle")}
                </Text>
              </View>
              <View style={styles.primaryArrowButton}>
                {isCreatingSession
                  ? <ActivityIndicator color="#fff" size="small" />
                  : <Ionicons name="add" size={26} color="#fff" />
                }
              </View>
            </View>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.secondaryAction}
            onPress={handleJoinQR}
            activeOpacity={0.85}
          >
            <View style={[styles.actionCardIcon, styles.actionCardIconTeal]}>
              <Ionicons name="qr-code-outline" size={26} color="#fff" />
            </View>
            <View style={styles.secondaryCopy}>
              <Text style={styles.secondaryActionText}>
                {t("home_join_qr")}
              </Text>
              <Text style={styles.secondarySub}>{t("home_scan_qr_sub")}</Text>
            </View>
            <View style={styles.qrScanFrame}>
              <Ionicons name="scan-outline" size={22} color={HOME_THEME.secondary} />
            </View>
          </TouchableOpacity>

          {/* Active session banner */}
          {currentSession && (
            <TouchableOpacity
              style={styles.activeSessionBanner}
              onPress={() => {
                const allPicked =
                  currentSession.receipt != null &&
                  currentSession.participants.length > 0 &&
                  currentSession.participants.every((p) => p.selections.length > 0);
                if (allPicked) {
                  router.push(`/(app)/dashboard/${currentSession.id}?source=lobby`);
                } else if (currentSession.receipt) {
                  router.push(`/(app)/session-lobby/${currentSession.id}`);
                } else {
                  router.push("/(app)/scan");
                }
              }}
              activeOpacity={0.85}
            >
              <View style={styles.activeIcon}>
                <Ionicons name="people" size={23} color={HOME_THEME.success} />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.activeSessionTitle}>{t("home_active_session")}</Text>
                <Text style={styles.activeSessionSub}>
                  {activeSessionRestaurant} {"•"} {activeSessionPeople} {t("home_people_suffix")}
                </Text>
              </View>
              <View style={styles.activeOpenPill}>
                <Text style={styles.activeSessionReturn}>{t("home_return")}</Text>
              </View>
            </TouchableOpacity>
          )}

          {/* Rejoin session banner */}
          {!currentSession && rejoinSession && (
            <TouchableOpacity
              style={styles.rejoinBanner}
              onPress={handleRejoin}
              disabled={isRejoining}
              activeOpacity={0.85}
            >
              <Ionicons name="return-down-forward-outline" size={20} color={Colors.primary} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.rejoinTitle}>{t("home_resume_session")}</Text>
                <Text style={styles.rejoinSub}>
                  {rejoinSession.restaurant
                    ? `${rejoinSession.restaurant} • ${rejoinSession.hostName}`
                    : `${t("home_host_prefix")} ${rejoinSession.hostName}`}
                </Text>
              </View>
              {isRejoining
                ? <ActivityIndicator size="small" color={Colors.primary} />
                : <Text style={styles.rejoinCta}>{t("home_rejoin_cta")}</Text>
              }
            </TouchableOpacity>
          )}

          {/* Credits card */}
          <TouchableOpacity
            style={styles.creditsCard}
            onPress={() => router.push("/(app)/paywall")}
            activeOpacity={0.8}
          >
            <View style={styles.creditsIcon}>
              <Image source={tokenImg} style={styles.creditsTokenImage} resizeMode="contain" />
            </View>
            <View style={styles.creditsContent}>
              <View style={styles.creditsTitleRow}>
                <Text style={styles.creditsCardLabel}>{t("home_credits_label")}</Text>
                <Ionicons name="information-circle-outline" size={13} color={HOME_THEME.secondary} />
                <View style={{ flex: 1 }} />
                <View style={styles.topUpButton}>
                  <Text style={styles.topUpButtonText}>{t("home_top_up")}</Text>
                </View>
              </View>
              <Text style={styles.creditsCardCount}>
                {creditCount} {t("paywall_credits")} = {creditCount} {t("home_bills_unit")}
              </Text>
            </View>
          </TouchableOpacity>

          {/* Savings carousel */}
          {(() => {
            const CAROUSEL = [
              {
                icon: "trending-up-outline" as const,
                label: t("home_carousel_1_label"),
                value: formatCurrency(totalSaved, dominantCurrency),
                sub: t("home_carousel_1_sub"),
              },
              {
                icon: "sparkles-outline" as const,
                label: t("home_carousel_2_label"),
                value: t("home_carousel_2_value"),
                sub: "",
              },
              {
                icon: "shield-checkmark-outline" as const,
                label: t("home_carousel_3_label"),
                value: formatCurrency(totalSaved, dominantCurrency),
                sub: t("home_carousel_3_sub"),
              },
              {
                icon: "ribbon-outline" as const,
                label: t("home_carousel_4_label"),
                value: totalSaved > 0 ? t("home_carousel_4_value_yes") : t("home_carousel_4_value_no"),
                sub: t("home_carousel_4_sub"),
              },
            ];
            const slide = CAROUSEL[carouselIdx];
            return (
              <View style={styles.savingsCard}>
                <View style={styles.savingsCardRow}>
                  <View style={styles.savingsIcon}>
                    <Ionicons name={slide.icon} size={22} color={HOME_THEME.success} />
                  </View>
                  <View style={styles.savingsCopy}>
                    <Text style={styles.savingsLabel}>{slide.label}</Text>
                    <Text style={styles.savingsValue}>{slide.value}</Text>
                    {slide.sub ? <Text style={styles.savingsSub}>{slide.sub}</Text> : null}
                  </View>
                </View>
                <View style={styles.carouselDots}>
                  {CAROUSEL.map((_, i) => (
                    <View
                      key={i}
                      style={[styles.carouselDot, i === carouselIdx && styles.carouselDotActive]}
                    />
                  ))}
                </View>
              </View>
            );
          })()}
        </View>

        {/* Recent Bills */}
        {false && completedSessions.length > 0 && (() => {
          const displayed = showAllHistory ? completedSessions : completedSessions.slice(0, 3);
          return (
            <View style={styles.recentSection}>
              <TouchableOpacity
                style={styles.sectionHeader}
                onPress={() => setBillsExpanded((v) => !v)}
                activeOpacity={0.7}
              >
                <View style={styles.creditsTitleRow}>
                  <Text style={[styles.sectionTitle, { color: HOME_THEME.secondary }]}>{t("home_recent_bills")}</Text>
                </View>
                <Text style={styles.seeAllText}>See all</Text>
              </TouchableOpacity>
              {billsExpanded && <View style={styles.billsCard}>
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
                        idx < displayed.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: HOME_THEME.border },
                      ]}
                      onPress={() => setBillActionTarget(session)}
                      activeOpacity={0.7}
                    >
                      <Ionicons name="document-text-outline" size={22} color={HOME_THEME.secondary} style={styles.billIcon} />
                      <View style={styles.billInfo}>
                        <View style={styles.billNameRow}>
                          <Text style={styles.billName} numberOfLines={1}>
                            {session.receipt?.restaurant ?? t("home_bill_fallback")}
                          </Text>
                          {session.participants.some((p) => !p.paid) && (
                            <View style={styles.unpaidDot} />
                          )}
                        </View>
                        <Text style={styles.billMeta}>
                          {session.participants.length > 0
                            ? `${session.participants.length} people · `
                            : ""}
                          {formatDate(session.createdAt)}
                          {session.participants.some((p) => !p.paid) ? " · Unpaid" : ""}
                        </Text>
                      </View>
                      <Text style={styles.billTotal}>
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
                  <Text style={styles.viewAllText}>
                    {showAllHistory
                      ? t("home_show_less")
                      : `${t("home_history_title")} (${completedSessions.length}) →`}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          );
        })()}
      </ScrollView>

      <BottomNavBar activeTab="home" onCenterPress={handleStartNewSession} />

      <DevPanel visible={showDevPanel} onClose={() => setShowDevPanel(false)} />

      {/* Hidden developer access — PIN modal */}
      <Modal
        visible={showPinModal}
        transparent
        animationType="fade"
        onRequestClose={() => { setShowPinModal(false); setPinValue(""); setPinError(false); }}
      >
        <View style={styles.pinOverlay}>
          <View style={[styles.pinCard, { backgroundColor: cardColor }]}>
            <TextInput
              style={[styles.pinInput, { color: textColor, borderColor }]}
              value={pinValue}
              onChangeText={(v) => { setPinValue(v); setPinError(false); }}
              keyboardType="numeric"
              maxLength={4}
              secureTextEntry
              autoFocus
              placeholder="••••"
              placeholderTextColor={HOME_THEME.secondary}
            />
            {pinError && <Text style={styles.pinError}>{t("home_pin_error")}</Text>}
            <TouchableOpacity
              style={[styles.pinSubmit, { backgroundColor: Colors.primary }]}
              onPress={() => {
                if (pinValue === DEV_PIN) {
                  setShowPinModal(false);
                  setPinValue("");
                  setPinError(false);
                  setShowDevPanel(true);
                } else {
                  setPinError(true);
                  setPinValue("");
                }
              }}
            >
              <Text style={styles.pinSubmitText}>{t("confirm")}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setShowPinModal(false); setPinValue(""); setPinError(false); }}>
              <Text style={[styles.pinCancel, { color: HOME_THEME.secondary }]}>{t("cancel")}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Bill action sheet */}
      {billActionTarget && (() => {
        const s = billActionTarget;
        const total = Object.values(s.receipt?.categories ?? {})
          .flat()
          .reduce((acc, i) => acc + i.totalPrice, 0)
          + (s.receipt?.globalCosts ?? []).reduce((acc, c) => acc + c.amount, 0)
          + (s.receipt?.selectedTip ?? 0);
        return (
          <Modal transparent animationType="slide" visible onRequestClose={() => setBillActionTarget(null)}>
            <TouchableOpacity
              style={styles.sheetOverlay}
              activeOpacity={1}
              onPress={() => setBillActionTarget(null)}
            />
            <View style={[styles.actionSheet, { backgroundColor: HOME_THEME.card }]}>
              <View style={[styles.sheetHandle, { backgroundColor: HOME_THEME.border }]} />
              <Text style={[styles.sheetTitle, { color: HOME_THEME.text }]} numberOfLines={1}>
                {s.receipt?.restaurant ?? t("home_bill_fallback")} · {formatCurrency(total, s.receipt?.currency ?? "EUR")}
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
                <Text style={[styles.sheetOptionText, { color: "#fff" }]}>{t("home_view_split")}</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.sheetOption, { backgroundColor: "#EF4444" }]}
                onPress={() => {
                  showDialog(t("home_delete_title"), t("home_delete_confirm"), [
                    { text: t("cancel"), style: "cancel" },
                    {
                      text: t("delete"),
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
                <Text style={[styles.sheetOptionText, { color: "#fff" }]}>{t("home_delete_history")}</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.sheetCancel, { backgroundColor: "#6B7280" }]}
                onPress={() => setBillActionTarget(null)}
              >
                <Text style={[styles.sheetCancelText, { color: "#fff" }]}>{t("cancel")}</Text>
              </TouchableOpacity>
            </View>
          </Modal>
        );
      })()}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: HOME_THEME.background },
  scroll: {
    flexGrow: 1,
    paddingHorizontal: 18,
  },
  homeCore: {
    justifyContent: "center",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingTop: 8,
    paddingBottom: 18,
  },
  brandBlock: {
    flexShrink: 1,
    gap: 2,
  },
  appName: {
    fontSize: 26,
    fontWeight: "800",
    color: HOME_THEME.text,
  },
  logoAmp: {
    color: HOME_THEME.primary,
  },
  appMotto: {
    color: HOME_THEME.secondary,
    fontSize: 12,
    fontWeight: "500",
  },
  profileCluster: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    maxWidth: "50%",
  },
  profileGreeting: {
    alignItems: "flex-end",
    flexShrink: 1,
  },
  profileGreetingText: {
    color: HOME_THEME.secondary,
    fontSize: 12,
    fontWeight: "500",
  },
  profileNameText: {
    color: HOME_THEME.text,
    fontSize: 15,
    fontWeight: "800",
    maxWidth: 92,
  },
  profileFallback: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: HOME_THEME.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  profileFallbackText: {
    color: "#fff",
    fontSize: 20,
    fontWeight: "900",
  },
  pinOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    alignItems: "center",
  },
  pinCard: {
    width: 260,
    borderRadius: 16,
    padding: 24,
    gap: 16,
    alignItems: "center",
  },
  pinInput: {
    width: "100%",
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
    fontSize: 24,
    textAlign: "center",
    letterSpacing: 12,
  },
  pinError: {
    color: "#ef4444",
    fontSize: 13,
  },
  pinSubmit: {
    width: "100%",
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  pinSubmitText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
  pinCancel: {
    fontSize: 14,
    fontWeight: "500",
  },
  primaryAction: {
    backgroundColor: HOME_THEME.cardPrimary,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: HOME_THEME.primary + "38",
    marginBottom: 12,
    overflow: "hidden",
    width: "100%",
    alignSelf: "center",
    shadowColor: HOME_THEME.primary,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.25,
    shadowRadius: 16,
    elevation: 6,
  },
  primaryActionInner: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    gap: 14,
  },
  primaryActionCopy: {
    flex: 1,
    gap: 4,
  },
  actionCardIcon: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: HOME_THEME.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  actionCardEuroBadge: {
    position: "absolute",
    bottom: 8,
    right: 8,
    color: "#fff",
    fontSize: 11,
    fontWeight: "900",
  },
  actionCardIconTeal: {
    backgroundColor: HOME_THEME.teal,
  },
  primaryArrowButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: HOME_THEME.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryActionTitle: {
    color: "#fff",
    fontSize: 17,
    fontWeight: "700",
  },
  primaryActionSub: {
    color: "#C9CCFF",
    fontSize: 13,
    fontWeight: "500",
    marginTop: 2,
  },
  secondaryAction: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: HOME_THEME.border,
    gap: 14,
    marginBottom: 12,
    backgroundColor: HOME_THEME.card,
    width: "100%",
    alignSelf: "center",
  },
  secondaryCopy: {
    flex: 1,
    gap: 4,
  },
  secondaryActionText: {
    fontSize: 17,
    fontWeight: "700",
    color: HOME_THEME.text,
  },
  secondarySub: {
    color: HOME_THEME.secondary,
    fontSize: 13,
    fontWeight: "500",
  },
  qrScanFrame: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(139,143,163,0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  creditsCard: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: HOME_THEME.border,
    padding: 16,
    backgroundColor: HOME_THEME.card,
    marginBottom: 12,
    gap: 14,
    width: "100%",
    alignSelf: "center",
  },
  creditsIcon: {
    width: 58,
    height: 58,
    borderRadius: 16,
    backgroundColor: "rgba(255,255,255,0.07)",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  creditsTokenImage: {
    width: 50,
    height: 50,
  },
  creditsContent: {
    flex: 1,
    gap: 4,
  },
  creditsTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    marginBottom: 4,
  },
  creditsCardLabel: {
    fontSize: 13,
    fontWeight: "500",
    color: HOME_THEME.secondary,
  },
  creditsCardCount: {
    color: HOME_THEME.text,
    fontSize: 18,
    fontWeight: "800",
    lineHeight: 24,
  },
  topUpButton: {
    borderWidth: 1,
    borderColor: HOME_THEME.primary,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  topUpButtonText: {
    fontSize: 14,
    fontWeight: "600",
    color: HOME_THEME.primary,
  },
  savingsCard: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: HOME_THEME.success + "33",
    backgroundColor: HOME_THEME.success + "12",
    padding: 16,
    marginBottom: 18,
    width: "100%",
    alignSelf: "center",
    gap: 10,
  },
  savingsCardRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  savingsIcon: {
    width: 46,
    height: 46,
    borderRadius: 14,
    backgroundColor: HOME_THEME.success + "1F",
    alignItems: "center",
    justifyContent: "center",
  },
  savingsCopy: {
    flex: 1,
    gap: 2,
  },
  savingsLabel: {
    color: HOME_THEME.secondary,
    fontSize: 12,
    fontWeight: "600",
  },
  savingsValue: {
    color: HOME_THEME.text,
    fontSize: 20,
    fontWeight: "900",
  },
  savingsSub: {
    color: HOME_THEME.secondary,
    fontSize: 12,
    fontWeight: "500",
  },
  carouselDots: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 5,
    marginTop: 2,
  },
  carouselDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: HOME_THEME.secondary + "55",
  },
  carouselDotActive: {
    width: 18,
    backgroundColor: HOME_THEME.success,
  },

  // ── Active session banner ──────────────────────────────────────────────────────
  activeSessionBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: HOME_THEME.success + "14",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: HOME_THEME.success + "36",
    borderLeftWidth: 4,
    borderLeftColor: HOME_THEME.success,
    paddingHorizontal: 14,
    paddingVertical: 14,
    marginBottom: 12,
    width: "100%",
    alignSelf: "center",
  },
  activeIcon: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: HOME_THEME.success + "33",
    alignItems: "center",
    justifyContent: "center",
  },
  activeSessionTitle: {
    color: HOME_THEME.success,
    fontSize: 15,
    fontWeight: "600",
  },
  activeSessionSub: {
    fontSize: 13,
    color: HOME_THEME.secondary,
    fontWeight: "400",
  },
  activeOpenPill: {
    borderWidth: 1,
    borderColor: HOME_THEME.success,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  activeSessionReturn: {
    color: HOME_THEME.success,
    fontSize: 13,
    fontWeight: "600",
  },

  // ── Rejoin session banner ──────────────────────────────────────────────────────
  rejoinBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: Colors.primary + "55",
    backgroundColor: Colors.primary + "10",
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

  // ── Recent bills ──────────────────────────────────────────────────────────────
  recentSection: {
    gap: 8,
    marginTop: 4,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  seeAllText: {
    color: HOME_THEME.primary,
    fontSize: 14,
    fontWeight: "600",
  },
  billsCard: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: HOME_THEME.border,
    overflow: "hidden",
    backgroundColor: HOME_THEME.card,
  },
  billRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 14,
    gap: 12,
  },
  billIcon: {
    width: 22,
  },
  billInfo: {
    flex: 1,
    gap: 2,
  },
  billNameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  billName: {
    color: HOME_THEME.text,
    fontSize: 15,
    fontWeight: "700",
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
    color: HOME_THEME.secondary,
    fontSize: 12,
    fontWeight: "400",
  },
  billTotal: {
    color: HOME_THEME.text,
    fontSize: 16,
    fontWeight: "700",
  },
  viewAllBtn: {
    alignSelf: "flex-end",
    paddingVertical: 4,
  },
  viewAllText: {
    fontSize: 13,
    fontWeight: "600",
    color: HOME_THEME.primary,
  },

  // ── Bill action sheet ──────────────────────────────────────────────────────────
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
});
