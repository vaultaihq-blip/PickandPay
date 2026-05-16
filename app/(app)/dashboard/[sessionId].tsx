import React, { useState, useEffect, useMemo } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  useColorScheme,
  Alert,
  Modal,
  Linking,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as MailComposer from "expo-mail-composer";
import { maybeShowReviewPrompt } from "@/utils/review";
import { Colors } from "@/constants/colors";
import { useSessionStore } from "@/store/sessionStore";
import { useAuthStore } from "@/store/authStore";
import { BarChart } from "@/components/dashboard/BarChart";
import { BreakdownCard } from "@/components/dashboard/BreakdownCard";
import { SummaryShare } from "@/components/dashboard/SummaryShare";
import { CentRoulette } from "@/components/roulette/CentRoulette";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { formatCurrency } from "@/utils/formatter";
import { Colors as C } from "@/constants/colors";
import { supabase } from "@/lib/supabase";
import { CentAdjustment, SessionParticipant, PaymentReminder } from "@/types";
import { sendPushNotification } from "@/lib/notifications";
import { toCents, fromCents } from "@/utils/validator";

type CentMethod = "creator" | "highest" | "roulette" | null;

export default function DashboardScreen() {
  const { sessionId, readOnly, viewSplit: viewSplitParam, source } = useLocalSearchParams<{
    sessionId: string;
    readOnly?: string;
    viewSplit?: string;
    source?: string;
  }>();
  const fromLobby = source === "lobby";
  const isReadOnly = readOnly === "true";
  const isDark = useColorScheme() === "dark";
  const {
    currentSession,
    markPaid,
    markViewingPaid,
    setStatus,
    setCentAdjustment,
    splitResults: storeSplitResults,
    addReminder,
    clearSession,
    addCompletedSession,
    viewingSession,
    viewingSplitResults,
    setViewingSession,
  } = useSessionStore();
  const { profile } = useAuthStore();

  const [rouletteVisible, setRouletteVisible] = useState(false);
  const [centMethod, setCentMethod] = useState<CentMethod>(null);
  const [closing, setClosing] = useState(false);
  const [remindTarget, setRemindTarget] = useState<SessionParticipant | null>(null);
  const [viewSplit, setViewSplit] = useState(viewSplitParam === "true");
  // Track which breakdown cards are expanded — lifted from BreakdownCard so re-renders don't reset state
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set());

  const textColor = isDark ? C.textPrimaryDark : C.textPrimaryLight;
  const mutedColor = isDark ? C.textMutedDark : C.textMutedLight;
  const bgColor = isDark ? C.bgDark : C.bgLight;
  const borderColor = isDark ? C.cardBorderDark : C.cardBorderLight;

  // Para modo readOnly (histórico), usar viewingSession sem tocar na sessão activa
  const session = isReadOnly ? (viewingSession ?? currentSession) : currentSession;
  const splitResults = isReadOnly ? viewingSplitResults : storeSplitResults;
  const receipt = session?.receipt;
  const isCreator = session?.creatorId === profile?.id;

  // ── Limpeza do viewingSession ao sair do modo readOnly ───────────────────
  useEffect(() => {
    if (!isReadOnly) return;
    return () => { setViewingSession(null); };
  }, [isReadOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Sorted participants: current user first, then by amount desc ──────────
  const sortedParticipants = useMemo(() => {
    if (!session) return [];
    return [...session.participants].sort((a, b) => {
      if (a.userId === profile?.id) return -1;
      if (b.userId === profile?.id) return 1;
      return b.totalOwed - a.totalOwed;
    });
  }, [session?.participants, profile?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Popup "bill closed" for non-host participants ──────────────────────────
  useEffect(() => {
    if (!session || session.id.startsWith("session_") || isCreator || isReadOnly) return;

    const ch = supabase
      .channel(`session-closed:${session.id}:${Date.now()}`)
      .on("postgres_changes", {
        event: "UPDATE",
        schema: "public",
        table: "sessions",
        filter: `id=eq.${session.id}`,
      }, (payload) => {
        const newStatus = payload.new?.status as string | undefined;
        if (newStatus === "closed") {
          Alert.alert(
            "Bill Closed",
            "The host has closed this bill.",
            [
              {
                text: "Stay on Payments",
                style: "cancel",
              },
              {
                text: "Go Home",
                onPress: () => {
                  addCompletedSession({ ...session, status: "closed" } as typeof session);
                  clearSession();
                  router.replace("/(app)");
                },
              },
            ]
          );
        }
      })
      .subscribe();

    return () => { supabase.removeChannel(ch); };
  }, [session?.id, isCreator, isReadOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── ReadOnly: fetch latest paid status from Supabase on open ─────────────
  useEffect(() => {
    if (!isReadOnly || !session) return;
    if (session.id.startsWith("session_") || session.id.startsWith("dev_session_")) return;
    const fetchPaid = async () => {
      const { data } = await supabase
        .from("session_participants")
        .select("user_id, paid")
        .eq("session_id", session.id);
      if (!data) return;
      for (const row of data) {
        if (row.paid !== undefined) markViewingPaid(row.user_id as string, row.paid as boolean);
      }
    };
    fetchPaid();
  }, [isReadOnly, session?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── ReadOnly: realtime paid sync (host can mark paid in history view) ─────
  useEffect(() => {
    if (!isReadOnly || !isCreator || !session) return;
    if (session.id.startsWith("session_") || session.id.startsWith("dev_session_")) return;
    const ch = supabase
      .channel(`dashboard-paid-readonly:${session.id}:${Date.now()}`)
      .on("postgres_changes", {
        event: "UPDATE",
        schema: "public",
        table: "session_participants",
        filter: `session_id=eq.${session.id}`,
      }, (payload) => {
        const uid = payload.new?.user_id as string | undefined;
        const paidVal = payload.new?.paid as boolean | undefined;
        if (!uid || paidVal === undefined) return;
        markViewingPaid(uid, paidVal);
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [isReadOnly, isCreator, session?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Realtime: sync paid status to/from all devices ────────────────────────
  useEffect(() => {
    if (!session || session.id.startsWith("session_") || isReadOnly) return;

    const ch = supabase
      .channel(`dashboard-paid:${session.id}:${Date.now()}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "session_participants",
          filter: `session_id=eq.${session.id}`,
        },
        (payload) => {
          const uid = payload.new?.user_id as string | undefined;
          const paidVal = payload.new?.paid as boolean | undefined;
          if (!uid || paidVal === undefined) return;
          markPaid(uid, paidVal);
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(ch); };
  }, [session?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Bottom-up totals using cent arithmetic ────────────────────────────────
  const itemsSubtotalCents = receipt
    ? Object.values(receipt.categories).flat().reduce((s, i) => s + toCents(i.totalPrice), 0)
    : 0;
  const globalCostsCents = receipt
    ? receipt.globalCosts.reduce((s, c) => s + toCents(c.amount), 0)
    : 0;
  const tipCents = (() => {
    if (!receipt || !session) return 0;
    if (receipt.tipMode === "individual") {
      return session.participants.reduce((s, p) => s + toCents(p.tipContribution ?? 0), 0);
    }
    return toCents(receipt.selectedTip ?? 0);
  })();
  const displayTotalCents = itemsSubtotalCents + globalCostsCents + tipCents;

  const itemsSubtotal = fromCents(itemsSubtotalCents);
  const globalCostsTotal = fromCents(globalCostsCents);
  const tipTotal = fromCents(tipCents);
  const displayTotal = fromCents(displayTotalCents);

  const computedTotalCents = session
    ? session.participants.reduce((s, p) => s + toCents(p.totalOwed), 0)
    : 0;

  const centDiffCents = displayTotalCents - computedTotalCents;
  const centDiff = fromCents(centDiffCents);
  const hasCentDiff = Math.abs(centDiff) >= 0.01 && Math.abs(centDiff) <= 0.10;

  // ── Expand toggle for breakdown cards ─────────────────────────────────────
  const toggleExpand = (userId: string) => {
    setExpandedCards((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  // ── Mark paid — host only; in readOnly mode only unpaid→paid allowed ───────
  const handleMarkPaid = async (userId: string, paid: boolean) => {
    if (isReadOnly) {
      if (!paid) return; // can't unmark paid in history view
      markViewingPaid(userId, true);
    } else {
      markPaid(userId, paid);
    }
    const isOffline = session?.id.startsWith("session_") || session?.id.startsWith("dev_session_");
    if (session && !isOffline) {
      await supabase
        .from("session_participants")
        .update({ paid })
        .eq("session_id", session.id)
        .eq("user_id", userId);
    }
  };

  // ── Cent adjustment ───────────────────────────────────────────────────────
  const handleCentAssign = (method: "creator" | "highest", userId?: string) => {
    if (!session) return;
    let assignedTo = userId ?? profile?.id ?? "";
    if (method === "creator") {
      assignedTo = session.creatorId;
    } else if (method === "highest") {
      let max = 0;
      for (const p of session.participants) {
        if (p.totalOwed > max) { max = p.totalOwed; assignedTo = p.userId; }
      }
    }
    const adjustment: CentAdjustment = { amount: centDiff, assignedTo, method };
    setCentAdjustment(adjustment);
    setCentMethod(method);
  };

  const handleRouletteAccept = (userId: string) => {
    const adjustment: CentAdjustment = { amount: centDiff, assignedTo: userId, method: "roulette" };
    setCentAdjustment(adjustment);
    setCentMethod("roulette");
    setRouletteVisible(false);
  };

  // ── Close bill (host only) ────────────────────────────────────────────────
  const doClose = async () => {
    if (!session) return;
    setClosing(true);
    try {
      if (!session.id.startsWith("session_")) {
        await supabase
          .from("sessions")
          .update({ status: "closed", closed_at: new Date().toISOString() })
          .eq("id", session.id);
      }
      setStatus("closed");
      maybeShowReviewPrompt();
      // Clear active session and navigate home — bill is in history via setStatus("closed")
      clearSession();
      router.replace("/(app)");
    } finally {
      setClosing(false);
    }
  };

  const handleCloseBill = () => {
    if (!session) return;
    const unpaid = session.participants.filter((p) => !p.paid);
    if (unpaid.length === 0) {
      doClose();
      return;
    }
    const names = unpaid.map((p) => p.profile.name).join(", ");
    Alert.alert(
      "⚠️ Unpaid participants",
      `${unpaid.length} ${unpaid.length === 1 ? "person hasn't" : "people haven't"} paid yet:\n\n${names}\n\nClose bill anyway?`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Close Anyway", style: "destructive", onPress: doClose },
      ]
    );
  };

  // ── Non-host: close my part ───────────────────────────────────────────────
  const handleCloseMyPart = () => {
    const sessionSnapshot = session;
    if (!sessionSnapshot) {
      router.replace("/(app)");
      return;
    }
    try {
      addCompletedSession(sessionSnapshot);
    } catch (err) {
      console.error("[dashboard] addCompletedSession error:", err);
    }
    clearSession();
    router.replace("/(app)");
  };

  // ── Reminders ─────────────────────────────────────────────────────────────
  const canRemind = (userId: string): boolean => {
    const reminders = session?.reminders ?? [];
    const last = reminders
      .filter((r) => r.recipientId === userId)
      .sort((a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime())[0];
    if (!last) return true;
    return Date.now() - new Date(last.sentAt).getTime() > 24 * 60 * 60 * 1000;
  };

  const recordAndClose = (recipientId: string, method: PaymentReminder["method"]) => {
    addReminder({
      id: String(Date.now()),
      recipientId,
      sentAt: new Date().toISOString(),
      method,
      sentBy: profile?.id ?? "",
    });
    setRemindTarget(null);
  };

  const handlePushReminder = async (p: SessionParticipant) => {
    try {
      await sendPushNotification({
        to: p.userId,
        title: "Payment Reminder",
        body: `⏰ Don't forget to pay your share! You owe ${formatCurrency(p.totalOwed, receipt!.currency)} for ${receipt!.restaurant}.`,
        data: { type: "payment_reminder", session_id: session!.id },
      });
      Alert.alert("Reminder Sent", `Notification sent to ${p.profile.name}.`);
      recordAndClose(p.userId, "push");
    } catch {
      Alert.alert(
        "Push unavailable",
        `${p.profile.name} hasn't enabled notifications in the app. Try Email or WhatsApp instead.`,
        [{ text: "OK" }]
      );
    }
  };

  const handleEmailReminder = async (p: SessionParticipant) => {
    try {
      if (!p.profile.email) {
        Alert.alert("No email on file", "This user has no email address saved.");
        return;
      }
      const subject = `Payment Reminder: ${receipt?.restaurant}`;
      const body = `Hi ${p.profile.name},\n\nFriendly reminder that you owe ${formatCurrency(p.totalOwed, receipt!.currency)} for ${receipt!.restaurant}.\n\nThanks!\nSent via Pick&Pay`;
      const available = await MailComposer.isAvailableAsync();
      if (available) {
        await MailComposer.composeAsync({ recipients: [p.profile.email], subject, body });
      } else {
        const mailto = `mailto:${p.profile.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
        const canOpen = await Linking.canOpenURL(mailto);
        if (!canOpen) {
          Alert.alert("Email unavailable", "No email app is configured on this device.");
          return;
        }
        await Linking.openURL(mailto);
      }
      recordAndClose(p.userId, "email");
    } catch (err) {
      console.error("[Reminder] Email error:", err);
      Alert.alert("Failed to send", "Could not open the email composer.");
    }
  };

  const handleWhatsAppReminder = async (p: SessionParticipant) => {
    try {
      const msg = encodeURIComponent(
        `Hi ${p.profile.name}, friendly reminder: you owe ${formatCurrency(p.totalOwed, receipt!.currency)} for ${receipt!.restaurant}. Thanks!`
      );
      const url = `whatsapp://send?text=${msg}`;
      const canOpen = await Linking.canOpenURL(url);
      if (!canOpen) {
        Alert.alert("WhatsApp not installed", "Install WhatsApp to send reminders this way.");
        return;
      }
      await Linking.openURL(url);
      recordAndClose(p.userId, "whatsapp");
    } catch (err) {
      console.error("[Reminder] WhatsApp error:", err);
      Alert.alert("Failed", "Could not open WhatsApp.");
    }
  };

  if (!session || !receipt) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: bgColor }]}>
        <View style={styles.emptyContainer}>
          <Text style={[styles.emptyText, { color: mutedColor }]}>Session not found.</Text>
          <TouchableOpacity onPress={() => router.replace("/(app)")}>
            <Text style={{ color: C.primary, marginTop: 12, fontSize: 16 }}>Go home</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: bgColor }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() =>
            viewSplit
              ? setViewSplit(false)
              : fromLobby
              ? router.replace("/(app)")
              : router.back()
          }
        >
          <Ionicons name="arrow-back" size={24} color={textColor} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={[styles.restaurantName, { color: textColor }]} numberOfLines={1}>
            Payments
          </Text>
          <View style={styles.headerBadges}>
            <Text style={[styles.headerSub, { color: mutedColor }]} numberOfLines={1}>
              {receipt.restaurant}
            </Text>
            {isReadOnly && (
              <View style={styles.readOnlyBadge}>
                <Ionicons name="eye-outline" size={11} color={mutedColor} />
                <Text style={[styles.readOnlyText, { color: mutedColor }]}>Read-only</Text>
              </View>
            )}
          </View>
        </View>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>
        {/* Bar chart */}
        <Card style={styles.chartCard} padding={0}>
          <BarChart
            participants={session.participants}
            currency={receipt.currency}
            splitResults={splitResults}
          />
        </Card>

        {/* Totals summary */}
        <Card style={styles.summaryCard}>
          <View style={styles.summaryRow}>
            <Text style={[styles.summaryLabel, { color: mutedColor }]}>Items subtotal</Text>
            <Text style={[styles.summaryValue, { color: textColor }]}>
              {formatCurrency(itemsSubtotal, receipt.currency)}
            </Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={[styles.summaryLabel, { color: mutedColor }]}>Global costs</Text>
            <Text style={[styles.summaryValue, { color: globalCostsTotal > 0 ? textColor : mutedColor }]}>
              {formatCurrency(globalCostsTotal, receipt.currency)}
            </Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={[styles.summaryLabel, { color: mutedColor }]}>Tip</Text>
            <Text style={[styles.summaryValue, { color: tipTotal > 0 ? textColor : mutedColor }]}>
              {formatCurrency(tipTotal, receipt.currency)}
            </Text>
          </View>
          <View style={[styles.summaryDivider, { backgroundColor: borderColor }]} />
          <View style={styles.summaryRow}>
            <Text style={[styles.summaryTotal, { color: textColor }]}>Grand Total</Text>
            <Text style={[styles.summaryTotalValue, { color: C.primary }]}>
              {formatCurrency(displayTotal, receipt.currency)}
            </Text>
          </View>

          {hasCentDiff && !centMethod && (
            <>
              <View style={[styles.centAlert, { borderColor: C.warning }]}>
                <Ionicons name="warning-outline" size={16} color={C.warning} />
                <Text style={[styles.centAlertText, { color: C.warning }]}>
                  {formatCurrency(Math.abs(centDiff), receipt.currency)} rounding difference
                </Text>
              </View>
              <Text style={[styles.centHelperText, { color: mutedColor }]}>
                Someone needs to cover the rounding difference
              </Text>
              <View style={styles.centActions}>
                <TouchableOpacity
                  style={[styles.centBtn, { borderColor }]}
                  onPress={() => handleCentAssign("creator")}
                >
                  <Text style={[styles.centBtnText, { color: textColor }]}>Assign to host</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.centBtn, { borderColor }]}
                  onPress={() => handleCentAssign("highest")}
                >
                  <Text style={[styles.centBtnText, { color: textColor }]}>Highest amount</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.centBtn, styles.rouletteBtn]}
                  onPress={() => setRouletteVisible(true)}
                >
                  <Text style={styles.rouletteBtnText}>
                    🎲 Spin to see who pays the {formatCurrency(Math.abs(centDiff), receipt.currency)} adjustment
                  </Text>
                </TouchableOpacity>
              </View>
            </>
          )}
          {centMethod && session.centAdjustment && (
            <View style={[styles.centResolved, { backgroundColor: C.success + "22" }]}>
              <Ionicons name="checkmark-circle" size={14} color={C.success} />
              <Text style={[styles.centResolvedText, { color: C.success }]}>
                {formatCurrency(Math.abs(centDiff), receipt.currency)} assigned to{" "}
                {session.participants.find(
                  (p) => p.userId === session.centAdjustment?.assignedTo
                )?.profile.name ?? "unknown"}
              </Text>
            </View>
          )}
        </Card>

        {/* Per-participant breakdown cards — current user first, then by amount */}
        <Text style={[styles.sectionTitle, { color: mutedColor }]}>PAYMENT STATUS</Text>
        {sortedParticipants.map((p) => {
          const isCurrentUser = p.userId === profile?.id;
          // Enrich current user's card with latest auth profile data (avatar, icon)
          const enrichedParticipant =
            isCurrentUser && profile
              ? {
                  ...p,
                  profile: {
                    ...p.profile,
                    avatarUrl: profile.avatarUrl ?? p.profile.avatarUrl,
                    avatarIcon: profile.avatarIcon ?? p.profile.avatarIcon,
                  },
                }
              : p;

          return (
            <View key={p.userId}>
              <BreakdownCard
                participant={enrichedParticipant}
                splitResult={splitResults?.get(p.userId)}
                currency={receipt.currency}
                isCreator={p.userId === session.creatorId}
                isCurrentUser={isCurrentUser}
                canMarkPaid={isCreator && !isReadOnly}
                onMarkPaid={(paid) => handleMarkPaid(p.userId, paid)}
                tipMode={receipt.tipMode ?? "equal"}
                expanded={expandedCards.has(p.userId)}
                onToggleExpand={() => toggleExpand(p.userId)}
              />
              {!p.paid && !isReadOnly && (
                <View style={[styles.remindRow, { borderColor }]}>
                  <View style={styles.pendingBadge}>
                    <Text style={styles.pendingBadgeText}>⚠️ Payment Pending</Text>
                  </View>
                  <TouchableOpacity
                    style={[styles.remindBtn, !canRemind(p.userId) && styles.remindBtnDisabled]}
                    onPress={() => setRemindTarget(p)}
                    disabled={!canRemind(p.userId)}
                  >
                    <Ionicons name="notifications-outline" size={14} color="#fff" />
                    <Text style={styles.remindBtnText}>
                      {canRemind(p.userId) ? "Remind" : "Reminded"}
                    </Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          );
        })}

        {/* Share summary */}
        <SummaryShare session={session} splitResults={splitResults} />

        {/* Bottom action buttons */}
        {viewSplit ? (
          <TouchableOpacity style={styles.backToSummaryBtn} onPress={() => setViewSplit(false)}>
            <Ionicons name="arrow-back" size={18} color={C.primary} />
            <Text style={styles.backToSummaryText}>Back to Summary</Text>
          </TouchableOpacity>
        ) : isReadOnly ? (
          <TouchableOpacity style={styles.backToSummaryBtn} onPress={() => router.replace("/(app)")}>
            <Ionicons name="home-outline" size={18} color={C.primary} />
            <Text style={styles.backToSummaryText}>Back to Home Screen</Text>
          </TouchableOpacity>
        ) : isCreator ? (
          <TouchableOpacity
            style={[styles.closeBtn, closing && { opacity: 0.6 }]}
            onPress={handleCloseBill}
            disabled={closing}
          >
            <Ionicons name="lock-closed-outline" size={20} color="#fff" />
            <Text style={styles.closeBtnText}>
              {closing ? "Closing..." : "Close Bill"}
            </Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={styles.doneBtn} onPress={handleCloseMyPart}>
            <Ionicons name="checkmark-done-outline" size={20} color="#fff" />
            <Text style={styles.closeBtnText}>Done — Close My Part</Text>
          </TouchableOpacity>
        )}
      </ScrollView>

      {/* Reminder modal */}
      <Modal
        visible={!!remindTarget}
        transparent
        animationType="slide"
        onRequestClose={() => setRemindTarget(null)}
      >
        <TouchableOpacity
          style={styles.reminderOverlay}
          activeOpacity={1}
          onPress={() => setRemindTarget(null)}
        />
        <View style={[styles.reminderSheet, { backgroundColor: isDark ? C.cardDark : C.cardLight }]}>
          <View style={[styles.reminderHandle, { backgroundColor: borderColor }]} />
          <Text style={[styles.reminderTitle, { color: textColor }]}>
            Send payment reminder to {remindTarget?.profile.name}?
          </Text>
          <Text style={[styles.reminderMeta, { color: mutedColor }]}>
            {remindTarget && formatCurrency(remindTarget.totalOwed, receipt.currency)} owed for{" "}
            {receipt.restaurant}
          </Text>
          <Text style={[styles.reminderSendVia, { color: mutedColor }]}>Send via:</Text>

          <TouchableOpacity
            style={[styles.reminderOption, { borderColor }]}
            onPress={() => remindTarget && handlePushReminder(remindTarget)}
          >
            <Text style={styles.reminderOptionIcon}>📱</Text>
            <Text style={[styles.reminderOptionText, { color: textColor }]}>Push Notification</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.reminderOption, { borderColor }]}
            onPress={() => remindTarget && handleEmailReminder(remindTarget)}
          >
            <Text style={styles.reminderOptionIcon}>📧</Text>
            <Text style={[styles.reminderOptionText, { color: textColor }]}>Email</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.reminderOption, { borderColor }]}
            onPress={() => remindTarget && handleWhatsAppReminder(remindTarget)}
          >
            <Text style={styles.reminderOptionIcon}>💬</Text>
            <Text style={[styles.reminderOptionText, { color: textColor }]}>WhatsApp</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.reminderCancel, { borderColor }]}
            onPress={() => setRemindTarget(null)}
          >
            <Text style={[styles.reminderCancelText, { color: mutedColor }]}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </Modal>

      {/* Cent roulette modal */}
      <CentRoulette
        visible={rouletteVisible}
        participants={session.participants}
        adjustmentAmount={Math.abs(centDiff)}
        currency={receipt.currency}
        onAccept={handleRouletteAccept}
        onClose={() => setRouletteVisible(false)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 14,
    gap: 12,
  },
  headerCenter: {
    flex: 1,
    alignItems: "center",
    gap: 2,
  },
  restaurantName: {
    fontSize: 17,
    fontWeight: "700",
  },
  headerSub: {
    fontSize: 12,
  },
  scroll: {
    paddingHorizontal: 16,
    paddingBottom: 40,
    gap: 12,
  },
  chartCard: { overflow: "hidden" },
  summaryCard: { gap: 10 },
  summaryRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  summaryLabel: { fontSize: 14 },
  summaryValue: { fontSize: 14, fontWeight: "600" },
  summaryDivider: { height: StyleSheet.hairlineWidth, marginVertical: 4 },
  summaryTotal: { fontSize: 16, fontWeight: "700" },
  summaryTotalValue: { fontSize: 22, fontWeight: "800" },

  centAlert: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    marginTop: 4,
  },
  centAlertText: { fontSize: 13, fontWeight: "500" },
  centHelperText: { fontSize: 12, fontStyle: "italic", marginTop: -4 },
  centActions: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  centBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
  },
  centBtnText: { fontSize: 12, fontWeight: "600" },
  rouletteBtn: { backgroundColor: Colors.primary + "22", borderColor: Colors.primary },
  rouletteBtnText: { color: Colors.primary, fontSize: 12, fontWeight: "700" },
  centResolved: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    padding: 8,
    borderRadius: 8,
  },
  centResolvedText: { fontSize: 12, fontWeight: "500" },

  sectionTitle: {
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.5,
    textTransform: "uppercase",
    paddingHorizontal: 4,
  },

  closeBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.success,
    paddingVertical: 18,
    borderRadius: 14,
    gap: 10,
    marginTop: 4,
  },
  doneBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.primary,
    paddingVertical: 18,
    borderRadius: 14,
    gap: 10,
    marginTop: 4,
  },
  closeBtnText: { color: "#fff", fontSize: 16, fontWeight: "700" },

  emptyContainer: { flex: 1, alignItems: "center", justifyContent: "center" },
  emptyText: { fontSize: 16 },

  backToSummaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderWidth: 1.5,
    borderColor: Colors.primary,
    borderRadius: 14,
    paddingVertical: 16,
    marginTop: 4,
  },
  backToSummaryText: { color: Colors.primary, fontSize: 16, fontWeight: "700" },

  // ── Header badges ──────────────────────────────────────────────────────────
  headerBadges: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  readOnlyBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: "rgba(128,128,128,0.12)",
  },
  readOnlyText: { fontSize: 10, fontWeight: "600" },

  // ── Remind row ─────────────────────────────────────────────────────────────
  remindRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: -1,
  },
  pendingBadge: {
    backgroundColor: "rgba(245,158,11,0.15)",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  pendingBadgeText: { fontSize: 12, fontWeight: "600", color: "#F59E0B" },
  remindBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: Colors.primary,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
  },
  remindBtnDisabled: { opacity: 0.4 },
  remindBtnText: { color: "#fff", fontSize: 12, fontWeight: "700" },

  // ── Reminder modal ─────────────────────────────────────────────────────────
  reminderOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)" },
  reminderSheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 40,
    gap: 8,
  },
  reminderHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    alignSelf: "center",
    marginBottom: 10,
  },
  reminderTitle: { fontSize: 16, fontWeight: "700" },
  reminderMeta: { fontSize: 13, marginBottom: 4 },
  reminderSendVia: {
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.3,
    textTransform: "uppercase",
    marginBottom: 2,
  },
  reminderOption: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  reminderOptionIcon: { fontSize: 20 },
  reminderOptionText: { fontSize: 15, fontWeight: "600" },
  reminderCancel: {
    alignItems: "center",
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: 4,
  },
  reminderCancelText: { fontSize: 15, fontWeight: "600" },
});
