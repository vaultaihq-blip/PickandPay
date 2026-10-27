import React, { useState, useEffect, useMemo } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Modal,
  Linking,
  InteractionManager,
} from "react-native";
import { showDialog } from "@/lib/dialog";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
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
import { Avatar } from "@/components/ui/Avatar";
import { formatCurrency } from "@/utils/formatter";
import { Colors as C } from "@/constants/colors";
import { supabase } from "@/lib/supabase";
import { expectRows, showWriteError } from "@/lib/checkedWrite";
import { CentAdjustment, SessionParticipant, PaymentReminder } from "@/types";
import { sendPushNotification } from "@/lib/notifications";
import { toCents, fromCents } from "@/utils/validator";
import { useI18nStore } from "@/store/i18nStore";

const BG = "#0B0D10";
const CARD = "#15181D";
const BORDER = "#252A32";
const TEXT = "#F8FAFC";
const MUTED = "#6B7280";

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
  const insets = useSafeAreaInsets();

  const {
    currentSession, markPaid, markViewingPaid, markCoveredBy, setStatus, setCentAdjustment,
    splitResults: storeSplitResults, addReminder, clearSession, addCompletedSession,
    viewingSession, viewingSplitResults, setViewingSession,
  } = useSessionStore();
  const { profile } = useAuthStore();
  const { t, language } = useI18nStore();
  void language;

  const [rouletteVisible, setRouletteVisible] = useState(false);
  const [centMethod, setCentMethod] = useState<CentMethod>(null);
  const [closing, setClosing] = useState(false);
  const [remindTarget, setRemindTarget] = useState<SessionParticipant | null>(null);
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set());
  const [actionSheetP, setActionSheetP] = useState<SessionParticipant | null>(null);
  const [viewItemsForUser, setViewItemsForUser] = useState<string | null>(null);
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [renderBreakdown, setRenderBreakdown] = useState(false);
  const [contentReady, setContentReady] = useState(false);

  const session = isReadOnly ? (viewingSession ?? currentSession) : currentSession;
  const splitResults = isReadOnly ? viewingSplitResults : storeSplitResults;
  const receipt = session?.receipt;
  const isCreator = session?.creatorId === profile?.id;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const task = InteractionManager.runAfterInteractions(() => {
      timer = setTimeout(() => setContentReady(true), 250);
    });
    return () => { task.cancel(); clearTimeout(timer); };
  }, []);

  useEffect(() => {
    if (!isReadOnly) return;
    return () => { setViewingSession(null); };
  }, [isReadOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (viewSplitParam === "true" && profile?.id) {
      setViewItemsForUser(profile.id);
    }
  }, [viewSplitParam, profile?.id]);

  const sortedParticipants = useMemo(() => {
    if (!session) return [];
    return [...session.participants].sort((a, b) => {
      if (a.userId === profile?.id) return -1;
      if (b.userId === profile?.id) return 1;
      return b.totalOwed - a.totalOwed;
    });
  }, [session?.participants, profile?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const headerDate = useMemo(() => {
    if (receipt?.date) {
      try {
        return new Date(receipt.date).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
      } catch {}
    }
    return new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  }, [receipt?.date]);

  // One-time paid-status fetch for readonly view
  useEffect(() => {
    if (!isReadOnly || !session) return;
    if (session.id.startsWith("session_") || session.id.startsWith("dev_session_")) return;
    supabase.from("session_participants").select("user_id, paid").eq("session_id", session.id).then(({ data }) => {
      if (!data) return;
      for (const row of data) {
        if (row.paid !== undefined) markViewingPaid(row.user_id as string, row.paid as boolean);
      }
    });
  }, [isReadOnly, session?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // All realtime subscriptions in one delayed batch — avoids concurrent channel setup during navigation animation
  useEffect(() => {
    if (!session) return;
    const isOffline = session.id.startsWith("session_") || session.id.startsWith("dev_session_");
    if (isOffline) return;

    const channels: ReturnType<typeof supabase.channel>[] = [];
    let timer: ReturnType<typeof setTimeout>;

    const task = InteractionManager.runAfterInteractions(() => {
      timer = setTimeout(() => {
        if (!isReadOnly && !isCreator) {
          channels.push(
            supabase
              .channel(`session-closed:${session.id}:${Date.now()}`)
              .on("postgres_changes", { event: "UPDATE", schema: "public", table: "sessions", filter: `id=eq.${session.id}` }, (payload) => {
                if ((payload.new?.status as string | undefined) === "closed") {
                  showDialog(t("dashboard_bill_closed"), t("dashboard_bill_closed_msg"), [
                    { text: t("dashboard_stay_payments"), style: "cancel" },
                    { text: t("dashboard_go_home_btn"), onPress: () => { addCompletedSession({ ...session, status: "closed" } as typeof session); clearSession(); router.replace("/(app)"); } },
                  ]);
                }
              })
              .subscribe()
          );
        }

        if (isReadOnly && isCreator) {
          channels.push(
            supabase
              .channel(`dashboard-paid-ro:${session.id}:${Date.now()}`)
              .on("postgres_changes", { event: "UPDATE", schema: "public", table: "session_participants", filter: `session_id=eq.${session.id}` }, (payload) => {
                const uid = payload.new?.user_id as string | undefined;
                const paidVal = payload.new?.paid as boolean | undefined;
                if (uid && paidVal !== undefined) markViewingPaid(uid, paidVal);
              })
              .subscribe()
          );
        }

        if (!isReadOnly) {
          channels.push(
            supabase
              .channel(`dashboard-paid:${session.id}:${Date.now()}`)
              .on("postgres_changes", { event: "UPDATE", schema: "public", table: "session_participants", filter: `session_id=eq.${session.id}` }, (payload) => {
                const uid = payload.new?.user_id as string | undefined;
                const paidVal = payload.new?.paid as boolean | undefined;
                const coveredBy = payload.new?.covered_by_user_id as string | null | undefined;
                if (uid) {
                  if (paidVal !== undefined) markPaid(uid, paidVal);
                  if (coveredBy !== undefined) markCoveredBy(uid, coveredBy);
                }
              })
              .subscribe()
          );
        }
      }, 500);
    });

    return () => { task.cancel(); clearTimeout(timer); for (const ch of channels) supabase.removeChannel(ch); };
  }, [session?.id, isCreator, isReadOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cent arithmetic
  const itemsSubtotalCents = receipt ? Object.values(receipt.categories).flat().reduce((s, i) => s + toCents(i.totalPrice), 0) : 0;
  const globalCostsCents = receipt ? receipt.globalCosts.reduce((s, c) => s + toCents(c.amount), 0) : 0;
  const tipCents = (() => {
    if (!receipt || !session) return 0;
    if (receipt.tipMode === "individual") return session.participants.reduce((s, p) => s + toCents(p.tipContribution ?? 0), 0);
    return toCents(receipt.selectedTip ?? 0);
  })();
  const displayTotalCents = itemsSubtotalCents + globalCostsCents + tipCents;
  const itemsSubtotal = fromCents(itemsSubtotalCents);
  const globalCostsTotal = fromCents(globalCostsCents);
  const tipTotal = fromCents(tipCents);
  const displayTotal = fromCents(displayTotalCents);

  const computedTotalCents = session ? session.participants.reduce((s, p) => s + toCents(p.totalOwed), 0) : 0;
  const centDiffCents = displayTotalCents - computedTotalCents;
  const centDiff = fromCents(centDiffCents);
  const hasCentDiff = Math.abs(centDiff) >= 0.01 && Math.abs(centDiff) <= 0.10;

  const toggleExpand = (userId: string) => {
    setExpandedCards((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId); else next.add(userId);
      return next;
    });
  };

  const handleMarkPaid = async (userId: string, paid: boolean) => {
    if (!isCreator) return;
    if (isReadOnly) {
      if (!paid) return;
      markViewingPaid(userId, true);
    } else {
      markPaid(userId, paid);
    }
    const isOffline = session?.id.startsWith("session_") || session?.id.startsWith("dev_session_");
    if (session && !isOffline) {
      try {
        await expectRows(
          "dashboard: mark paid",
          supabase
            .from("session_participants")
            .update({ paid })
            .eq("session_id", session.id)
            .eq("user_id", userId)
            .select("id")
        );
      } catch (err) {
        // Undo the optimistic mark so the screen shows what the server has.
        if (isReadOnly) markViewingPaid(userId, !paid);
        else markPaid(userId, !paid);
        showWriteError(err, t);
      }
    }
  };

  const handleMarkCoveredBy = async (targetUserId: string, coveredByUserId: string | null) => {
    const isOffline = session?.id.startsWith("session_") || session?.id.startsWith("dev_session_");
    const previous = session?.participants.find((p) => p.userId === targetUserId)?.coveredByUserId ?? null;
    markCoveredBy(targetUserId, coveredByUserId);
    if (session && !isOffline) {
      try {
        await expectRows(
          "dashboard: mark covered by",
          supabase
            .from("session_participants")
            .update({ covered_by_user_id: coveredByUserId })
            .eq("session_id", session.id)
            .eq("user_id", targetUserId)
            .select("id")
        );
      } catch (err) {
        markCoveredBy(targetUserId, previous);
        showWriteError(err, t);
      }
    }
  };

  const handleCentAssign = (method: "creator" | "highest") => {
    if (!session) return;
    let assignedTo = profile?.id ?? "";
    if (method === "creator") assignedTo = session.creatorId;
    else { let max = 0; for (const p of session.participants) { if (p.totalOwed > max) { max = p.totalOwed; assignedTo = p.userId; } } }
    setCentAdjustment({ amount: centDiff, assignedTo, method } as CentAdjustment);
    setCentMethod(method);
  };

  const handleRouletteAccept = (userId: string) => {
    setCentAdjustment({ amount: centDiff, assignedTo: userId, method: "roulette" } as CentAdjustment);
    setCentMethod("roulette");
    setRouletteVisible(false);
  };

  const doClose = async () => {
    if (!session) return;
    setClosing(true);
    try {
      if (!session.id.startsWith("session_")) {
        // No closed_at: the column doesn't exist in production, and sending it
        // made PostgREST reject the whole update — no bill was ever closed
        // from here (the 27 sessions left in awaiting_payment).
        await expectRows(
          "dashboard: close bill (closed)",
          supabase.from("sessions").update({ status: "closed" }).eq("id", session.id).select("id")
        );
      }
      setStatus("closed");
      maybeShowReviewPrompt();
      clearSession();
      router.replace("/(app)");
    } catch (err) {
      showWriteError(err, t);
    } finally { setClosing(false); }
  };

  const handleCloseBill = () => {
    if (!session) return;
    const unpaid = session.participants.filter((p) => !p.paid);
    if (unpaid.length === 0) { doClose(); return; }
    showDialog("⚠️ Unpaid participants",
      `${unpaid.length} ${unpaid.length === 1 ? "person hasn't" : "people haven't"} paid yet:\n\n${unpaid.map((p) => p.profile.name).join(", ")}\n\nClose bill anyway?`,
      [{ text: t("cancel"), style: "cancel" }, { text: t("dashboard_close_anyway"), style: "destructive", onPress: doClose }]);
  };

  const handleCloseMyPart = () => {
    const snap = session;
    if (!snap) { router.replace("/(app)"); return; }
    try { addCompletedSession(snap); } catch {}
    maybeShowReviewPrompt();
    clearSession();
    router.replace("/(app)");
  };

  const canRemind = (userId: string): boolean => {
    const last = (session?.reminders ?? [])
      .filter((r) => r.recipientId === userId)
      .sort((a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime())[0];
    if (!last) return true;
    return Date.now() - new Date(last.sentAt).getTime() > 24 * 60 * 60 * 1000;
  };

  const recordAndClose = (recipientId: string, method: PaymentReminder["method"]) => {
    addReminder({ id: String(Date.now()), recipientId, sentAt: new Date().toISOString(), method, sentBy: profile?.id ?? "" });
    setRemindTarget(null);
  };

  const isCoverageReminder = (p: SessionParticipant) => p.coveredByUserId === profile?.id;

  const reminderTitle = (p: SessionParticipant) =>
    isCoverageReminder(p) ? "Devolução pendente 💸" : "Payment Reminder";

  const reminderBody = (p: SessionParticipant) =>
    isCoverageReminder(p)
      ? `${profile?.name} pagou a tua conta (${formatCurrency(p.totalOwed, receipt?.currency ?? "EUR")}) em ${receipt?.restaurant}. Não te esqueças de devolver!`
      : `⏰ Don't forget to pay! You owe ${formatCurrency(p.totalOwed, receipt?.currency ?? "EUR")} for ${receipt?.restaurant}.`;

  const handlePushReminder = async (p: SessionParticipant) => {
    try {
      await sendPushNotification({ to: p.userId, title: reminderTitle(p), body: reminderBody(p), data: { type: "payment_reminder", session_id: session?.id } });
      showDialog("Lembrete enviado", `${p.profile.name} foi notificado.`);
      recordAndClose(p.userId, "push");
    } catch {
      showDialog("Sem notificação push", `${p.profile.name} não tem notificações ativadas. Tenta por email ou WhatsApp.`, [{ text: "OK" }]);
    }
  };

  const handleEmailReminder = async (p: SessionParticipant) => {
    try {
      if (!p.profile.email) { showDialog("Sem email", `${p.profile.name} não tem email registado.`); return; }
      const subject = isCoverageReminder(p)
        ? `Devolução pendente — ${receipt?.restaurant}`
        : `Payment Reminder: ${receipt?.restaurant}`;
      const body = isCoverageReminder(p)
        ? `Olá ${p.profile.name},\n\n${profile?.name} pagou a tua conta (${formatCurrency(p.totalOwed, receipt?.currency ?? "EUR")}) em ${receipt?.restaurant}.\n\nNão te esqueças de devolver!\n\nEnviado via Pick&Pay`
        : `Hi ${p.profile.name},\n\nFriendly reminder: you owe ${formatCurrency(p.totalOwed, receipt?.currency ?? "EUR")} for ${receipt?.restaurant}.\n\nThanks!\nSent via Pick&Pay`;
      const available = await MailComposer.isAvailableAsync();
      if (available) { await MailComposer.composeAsync({ recipients: [p.profile.email], subject, body }); }
      else {
        const mailto = `mailto:${p.profile.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
        if (!(await Linking.canOpenURL(mailto))) { showDialog("Email indisponível", "Nenhuma app de email configurada."); return; }
        await Linking.openURL(mailto);
      }
      recordAndClose(p.userId, "email");
    } catch { showDialog("Erro", "Não foi possível abrir o compositor de email."); }
  };

  const handleWhatsAppReminder = async (p: SessionParticipant) => {
    try {
      const text = isCoverageReminder(p)
        ? `Olá ${p.profile.name}! ${profile?.name} pagou a tua conta (${formatCurrency(p.totalOwed, receipt?.currency ?? "EUR")}) em ${receipt?.restaurant}. Não te esqueças de devolver! 🤝`
        : `Hi ${p.profile.name}, friendly reminder: you owe ${formatCurrency(p.totalOwed, receipt?.currency ?? "EUR")} for ${receipt?.restaurant}. Thanks!`;
      const url = `whatsapp://send?text=${encodeURIComponent(text)}`;
      if (!(await Linking.canOpenURL(url))) { showDialog("WhatsApp não instalado", "Instala o WhatsApp para enviar lembretes."); return; }
      await Linking.openURL(url);
      recordAndClose(p.userId, "whatsapp");
    } catch { showDialog("Erro", "Não foi possível abrir o WhatsApp."); }
  };

  const handlePersonCardTap = (p: SessionParticipant) => {
    setActionSheetP(p);
  };

  const handleBack = () => {
    if (fromLobby) { router.replace("/(app)"); return; }
    router.back();
  };

  const itemToUsers = useMemo(() => {
    const map = new Map<string, SessionParticipant[]>();
    if (!splitResults || !session) return map;
    for (const p of session.participants) {
      const result = splitResults.get(p.userId);
      if (!result) continue;
      for (const entry of result.itemBreakdown) {
        if (!map.has(entry.itemId)) map.set(entry.itemId, []);
        map.get(entry.itemId)!.push(p);
      }
    }
    return map;
  }, [splitResults, session]); // eslint-disable-line react-hooks/exhaustive-deps

  const viewItemsParticipant = viewItemsForUser ? sortedParticipants.find((p) => p.userId === viewItemsForUser) : null;
  const viewItemsSplitResult = viewItemsForUser ? splitResults?.get(viewItemsForUser) : null;

  if (!session || !receipt) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>Session not found.</Text>
          <TouchableOpacity onPress={() => router.replace("/(app)")}>
            <Text style={{ color: C.primary, marginTop: 12, fontSize: 16 }}>Go home</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle} numberOfLines={1}>Payment Screen</Text>
        <Text style={styles.headerDate} numberOfLines={1}>{receipt.restaurant} · {headerDate}{isReadOnly ? " · View only" : ""}</Text>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>
        {/* Total Bill Card */}
        <View style={styles.totalCard}>
          <Text style={styles.totalCardLabel}>Total bill</Text>
          <Text style={styles.totalCardAmount}>{formatCurrency(displayTotal, receipt.currency)}</Text>
          <View style={styles.totalDivider} />
          <View style={styles.totalRow}>
            <Text style={styles.totalRowLabel}>Service</Text>
            <Text style={[styles.totalRowValue, globalCostsTotal === 0 && { color: MUTED }]}>{formatCurrency(globalCostsTotal, receipt.currency)}</Text>
          </View>
          <View style={styles.totalRow}>
            <Text style={styles.totalRowLabel}>Tip</Text>
            <Text style={[styles.totalRowValue, tipTotal === 0 ? { color: MUTED } : { color: C.success }]}>{formatCurrency(tipTotal, receipt.currency)}</Text>
          </View>
          <View style={[styles.totalRow, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: BORDER, paddingTop: 8, marginTop: 2 }]}>
            <Text style={[styles.totalRowLabel, { color: TEXT, fontWeight: "700" }]}>Total</Text>
            <Text style={[styles.totalRowValue, { color: TEXT, fontWeight: "800", fontSize: 16 }]}>{formatCurrency(displayTotal, receipt.currency)}</Text>
          </View>

          {hasCentDiff && !centMethod && (
            <>
              <View style={[styles.centAlert, { borderColor: C.warning }]}>
                <Ionicons name="warning-outline" size={16} color={C.warning} />
                <Text style={[styles.centAlertText, { color: C.warning }]}>
                  {formatCurrency(Math.abs(centDiff), receipt.currency)} {t("dashboard_rounding_diff")}
                </Text>
              </View>
              <Text style={styles.centHelperText}>{t("dashboard_someone_needs")}</Text>
              <View style={styles.centActions}>
                <TouchableOpacity style={styles.centBtn} onPress={() => handleCentAssign("creator")}>
                  <Text style={styles.centBtnText}>{t("dashboard_assign_host")}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.centBtn} onPress={() => handleCentAssign("highest")}>
                  <Text style={styles.centBtnText}>{t("dashboard_highest_amount")}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.centBtn, styles.rouletteBtn]} onPress={() => setRouletteVisible(true)}>
                  <Text style={styles.rouletteBtnText}>{t("dashboard_spin_text")} {formatCurrency(Math.abs(centDiff), receipt.currency)} {t("dashboard_spin_adjustment")}</Text>
                </TouchableOpacity>
              </View>
            </>
          )}
          {centMethod && session.centAdjustment && (
            <View style={[styles.centResolved, { backgroundColor: C.success + "22" }]}>
              <Ionicons name="checkmark-circle" size={14} color={C.success} />
              <Text style={[styles.centResolvedText, { color: C.success }]}>
                {formatCurrency(Math.abs(centDiff), receipt.currency)} {t("dashboard_assigned_to")}{" "}
                {session.participants.find((p) => p.userId === session.centAdjustment?.assignedTo)?.profile.name ?? "unknown"}
              </Text>
            </View>
          )}
        </View>

        {/* Amounts owed — bar chart */}
        {contentReady && (
        <View style={styles.chartCard}>
          <BarChart participants={session.participants} currency={receipt.currency} splitResults={splitResults} />
        </View>
        )}

        {/* Participant cards grid */}
        <View>
          <Text style={styles.sectionLabel}>PARTICIPANTS</Text>
          <View style={styles.personGrid}>
            {sortedParticipants.map((p) => {
              const personColor = p.profile.color ?? C.primary;
              const isCurrentUser = p.userId === profile?.id;
              const enriched = isCurrentUser && profile
                ? { ...p, profile: { ...p.profile, avatarUrl: profile.avatarUrl ?? p.profile.avatarUrl, avatarIcon: profile.avatarIcon ?? p.profile.avatarIcon } }
                : p;
              return (
                <TouchableOpacity
                  key={p.userId}
                  style={[styles.personCard, { borderColor: BORDER }]}
                  onPress={() => handlePersonCardTap(enriched)}
                  activeOpacity={0.75}
                >
                  {p.userId === session.creatorId && (
                    <View style={styles.hostBadge}><Text style={styles.hostBadgeText}>Host</Text></View>
                  )}
                  <View style={styles.personCardContent}>
                    <Avatar name={enriched.profile.name} avatarIcon={enriched.profile.avatarIcon} avatarUrl={enriched.profile.avatarUrl} color={enriched.profile.color} size={48} />
                    <Text style={styles.personCardName} numberOfLines={1}>{enriched.profile.name}</Text>
                    <Text style={[styles.personCardAmount, { color: personColor }]}>
                      {formatCurrency(p.totalOwed, receipt.currency)}
                    </Text>
                    <View style={[styles.paidBadge, { backgroundColor: p.paid ? C.success + "22" : "#F59E0B22" }]}>
                      <Ionicons name={p.paid ? "checkmark-circle" : "time-outline"} size={12} color={p.paid ? C.success : "#F59E0B"} />
                      <Text style={[styles.paidBadgeText, { color: p.paid ? C.success : "#F59E0B" }]}>
                        {p.paid ? "Paid" : "Pending"}
                      </Text>
                    </View>
                    {p.coveredByUserId && (
                      <View style={[styles.paidBadge, { backgroundColor: "#6366F122", marginTop: -4 }]}>
                        <Text style={[styles.paidBadgeText, { color: C.primary }]}>
                          🤝 {session.participants.find((x) => x.userId === p.coveredByUserId)?.profile.name ?? ""}
                        </Text>
                      </View>
                    )}
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* Bill Split Breakdown — dropdown accordion */}
        <View style={styles.breakdownAccordion}>
          <TouchableOpacity
            style={styles.breakdownAccordionHeader}
            onPress={() => {
              const next = !showBreakdown;
              setShowBreakdown(next);
              if (next) {
                requestAnimationFrame(() => setRenderBreakdown(true));
              } else {
                setRenderBreakdown(false);
              }
            }}
            activeOpacity={0.7}
          >
            <Ionicons name="receipt-outline" size={16} color={MUTED} />
            <Text style={styles.breakdownAccordionTitle}>Bill Split Breakdown</Text>
            <Ionicons name={showBreakdown ? "chevron-up" : "chevron-down"} size={16} color={MUTED} />
          </TouchableOpacity>
          {renderBreakdown && (
            <View style={styles.receiptBreakdown}>
              {(["starters", "mains", "drinks", "desserts", "others"] as const).map((cat) => {
                const catItems = receipt.categories[cat];
                if (!catItems || catItems.length === 0) return null;
                return (
                  <View key={cat}>
                    <Text style={styles.breakdownCatLabel}>{cat.charAt(0).toUpperCase() + cat.slice(1)}</Text>
                    {catItems.map((item) => {
                      const users = itemToUsers.get(item.id) ?? [];
                      return (
                        <View key={item.id} style={styles.breakdownItemRow}>
                          <View style={{ flex: 1 }}>
                            <Text style={styles.breakdownItemName} numberOfLines={1}>
                              {item.quantity > 1 ? `${item.quantity}× ` : ""}{item.name}
                            </Text>
                            <Text style={styles.breakdownItemPrice}>
                              {formatCurrency(item.unitPrice, receipt.currency)}
                            </Text>
                          </View>
                          <View style={styles.breakdownUserCluster}>
                            {users.length === 0 ? (
                              <Text style={styles.breakdownUnassigned}>—</Text>
                            ) : (
                              <>
                                {users.slice(0, 4).map((u, i) => (
                                  <View key={u.userId} style={[styles.breakdownAvatarWrap, { marginLeft: i > 0 ? -8 : 0, zIndex: 10 - i }]}>
                                    <Avatar name={u.profile.name} avatarIcon={u.profile.avatarIcon} avatarUrl={u.profile.avatarUrl} color={u.profile.color} size={26} />
                                  </View>
                                ))}
                                {users.length > 4 && (
                                  <View style={[styles.breakdownAvatarOverflow, { marginLeft: -8 }]}>
                                    <Text style={styles.breakdownOverflowText}>+{users.length - 4}</Text>
                                  </View>
                                )}
                              </>
                            )}
                          </View>
                        </View>
                      );
                    })}
                  </View>
                );
              })}
            </View>
          )}
        </View>

        <SummaryShare session={session} splitResults={splitResults} />
        <View style={{ height: 120 }} />
      </ScrollView>

      {/* Fixed bottom action bar */}
      <View style={[styles.actionBar, { paddingBottom: insets.bottom + 14 }]}>
        {isReadOnly ? (
          <TouchableOpacity style={[styles.closeBillBtn, { flex: 1 }]} onPress={() => router.replace("/(app)")}>
            <Ionicons name="home-outline" size={18} color="#fff" />
            <Text style={styles.closeBillText}>Go home</Text>
          </TouchableOpacity>
        ) : isCreator ? (
          <TouchableOpacity style={[styles.closeBillBtn, { flex: 1 }, closing && { opacity: 0.6 }]} onPress={handleCloseBill} disabled={closing}>
            <Ionicons name="lock-closed-outline" size={18} color="#fff" />
            <Text style={styles.closeBillText}>{closing ? "Closing…" : "Close bill"}</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={[styles.closeBillBtn, { flex: 1 }]} onPress={handleCloseMyPart}>
            <Ionicons name="checkmark-done-outline" size={18} color="#fff" />
            <Text style={styles.closeBillText}>Done</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Action sheet — tap em participante */}
      <Modal visible={!!actionSheetP} transparent animationType="slide" onRequestClose={() => setActionSheetP(null)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setActionSheetP(null)} />
        <View style={[styles.actionSheet, { paddingBottom: insets.bottom + 20 }]}>
          <View style={styles.sheetHandle} />
          {actionSheetP && (
            <>
              <View style={styles.actionSheetHeader}>
                <Avatar
                  name={actionSheetP.profile.name}
                  avatarIcon={actionSheetP.profile.avatarIcon}
                  avatarUrl={actionSheetP.profile.avatarUrl}
                  color={actionSheetP.profile.color}
                  size={36}
                />
                <View style={{ flex: 1 }}>
                  <Text style={styles.actionSheetName}>{actionSheetP.profile.name}</Text>
                  <Text style={[styles.actionSheetAmount, { color: actionSheetP.profile.color ?? C.primary }]}>
                    {formatCurrency(actionSheetP.totalOwed, receipt.currency)}
                  </Text>
                </View>
                <View style={[styles.paidBadge, { backgroundColor: actionSheetP.paid ? C.success + "22" : "#F59E0B22" }]}>
                  <Text style={{ color: actionSheetP.paid ? C.success : "#F59E0B", fontSize: 12, fontWeight: "700" }}>
                    {actionSheetP.paid ? "Pago" : "Pendente"}
                  </Text>
                </View>
              </View>
              <TouchableOpacity
                style={styles.actionSheetBtn}
                onPress={() => { setViewItemsForUser(actionSheetP.userId); setActionSheetP(null); }}
              >
                <Ionicons name="list-outline" size={20} color={TEXT} />
                <Text style={styles.actionSheetBtnText}>Ver seleção</Text>
              </TouchableOpacity>

              {/* Opção: cobrir pagamento de outro utilizador */}
              {!isReadOnly && actionSheetP.userId !== profile?.id && !actionSheetP.paid && (
                (() => {
                  const iAmCovering = actionSheetP.coveredByUserId === profile?.id;
                  const isCoveredByOther = !!actionSheetP.coveredByUserId && !iAmCovering;
                  if (isCoveredByOther) return null;
                  return (
                    <TouchableOpacity
                      style={styles.actionSheetBtn}
                      onPress={async () => {
                        const newCoverer = iAmCovering ? null : (profile?.id ?? null);
                        await handleMarkCoveredBy(actionSheetP.userId, newCoverer);
                        setActionSheetP(null);
                      }}
                    >
                      <Text style={{ fontSize: 20 }}>🤝</Text>
                      <Text style={[styles.actionSheetBtnText, { color: iAmCovering ? "#F59E0B" : C.primary }]}>
                        {iAmCovering ? "Cancelar cobertura" : "Cobri o pagamento deste"}
                      </Text>
                    </TouchableOpacity>
                  );
                })()
              )}

              {/* Lembrar reembolso: disponível sempre para o coverer (mesmo pago, mesmo em readonly) */}
              {actionSheetP.coveredByUserId === profile?.id && (
                <TouchableOpacity
                  style={styles.actionSheetBtn}
                  onPress={() => { setRemindTarget(actionSheetP); setActionSheetP(null); }}
                >
                  <Ionicons name="notifications-outline" size={20} color={TEXT} />
                  <Text style={styles.actionSheetBtnText}>Lembrar pagamento 🔔</Text>
                </TouchableOpacity>
              )}

              {/* Já me devolveu: limpa a cobertura */}
              {!isReadOnly && actionSheetP.coveredByUserId === profile?.id && (
                <TouchableOpacity
                  style={styles.actionSheetBtn}
                  onPress={async () => { await handleMarkCoveredBy(actionSheetP.userId, null); setActionSheetP(null); }}
                >
                  <Text style={{ fontSize: 18 }}>✅</Text>
                  <Text style={[styles.actionSheetBtnText, { color: C.success }]}>Já me devolveu o valor</Text>
                </TouchableOpacity>
              )}

              {/* Host: marcar como pago */}
              {isCreator && !isReadOnly && (
                <TouchableOpacity
                  style={styles.actionSheetBtn}
                  onPress={() => { handleMarkPaid(actionSheetP.userId, !actionSheetP.paid); setActionSheetP(null); }}
                >
                  <Ionicons
                    name={actionSheetP.paid ? "close-circle-outline" : "checkmark-circle"}
                    size={20}
                    color={actionSheetP.paid ? "#F59E0B" : C.success}
                  />
                  <Text style={[styles.actionSheetBtnText, { color: actionSheetP.paid ? "#F59E0B" : C.success }]}>
                    {actionSheetP.paid ? "Marcar como pendente" : "Marcar como pago"}
                  </Text>
                </TouchableOpacity>
              )}
            </>
          )}
        </View>
      </Modal>

      {/* Items view modal */}
      <Modal visible={!!viewItemsForUser} transparent animationType="slide" onRequestClose={() => setViewItemsForUser(null)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setViewItemsForUser(null)} />
        <View style={[styles.itemsSheet, { paddingBottom: insets.bottom + 20 }]}>
          <View style={styles.sheetHandle} />
          {viewItemsParticipant && (
            <>
              <View style={styles.itemsSheetHeader}>
                <Avatar name={viewItemsParticipant.profile.name} avatarIcon={viewItemsParticipant.profile.avatarIcon} avatarUrl={viewItemsParticipant.profile.avatarUrl} color={viewItemsParticipant.profile.color} size={40} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.itemsSheetName}>{viewItemsParticipant.profile.name}</Text>
                  <Text style={[styles.itemsSheetAmount, { color: viewItemsParticipant.profile.color ?? C.primary }]}>
                    {formatCurrency(viewItemsParticipant.totalOwed, receipt.currency)}
                  </Text>
                </View>
                <View style={[styles.itemsSheetStatusBadge, { backgroundColor: viewItemsParticipant.paid ? C.success + "22" : "#F59E0B22" }]}>
                  <Text style={{ color: viewItemsParticipant.paid ? C.success : "#F59E0B", fontSize: 12, fontWeight: "700" }}>
                    {viewItemsParticipant.paid ? "Paid" : "Pending"}
                  </Text>
                </View>
              </View>

              <Text style={styles.itemsSheetLabel}>ITEMS CHOSEN</Text>
              <ScrollView style={{ maxHeight: 280 }} showsVerticalScrollIndicator={false}>
                {(viewItemsSplitResult?.itemBreakdown.length ?? 0) > 0 ? (
                  viewItemsSplitResult!.itemBreakdown.map((entry) => (
                    <View key={entry.itemId} style={styles.itemRow}>
                      <Text style={styles.itemRowName} numberOfLines={2}>{entry.itemName}</Text>
                      <View style={{ alignItems: "flex-end" }}>
                        <Text style={[styles.itemRowAmount, { color: viewItemsParticipant.profile.color ?? C.primary }]}>
                          {formatCurrency(entry.amount, receipt.currency)}
                        </Text>
                        {entry.splitCount > 1 && (
                          <Text style={styles.itemRowSplit}>÷{entry.splitCount} of {formatCurrency(entry.itemTotal, receipt.currency)}</Text>
                        )}
                      </View>
                    </View>
                  ))
                ) : (
                  <Text style={styles.itemRowEmpty}>No individual items — bill split equally</Text>
                )}
                {(viewItemsSplitResult?.globalCostsShare ?? 0) > 0 && (
                  <View style={styles.itemRow}>
                    <Text style={styles.itemRowName}>Tax & fees share</Text>
                    <Text style={[styles.itemRowAmount, { color: MUTED }]}>+{formatCurrency(viewItemsSplitResult!.globalCostsShare, receipt.currency)}</Text>
                  </View>
                )}
                {(viewItemsSplitResult?.tipShare ?? 0) > 0 && (
                  <View style={styles.itemRow}>
                    <Text style={styles.itemRowName}>Tip share</Text>
                    <Text style={[styles.itemRowAmount, { color: C.success }]}>+{formatCurrency(viewItemsSplitResult!.tipShare, receipt.currency)}</Text>
                  </View>
                )}
              </ScrollView>

              <View style={styles.itemsSheetFooter}>
                {isCreator && !isReadOnly && !viewItemsParticipant.paid && canRemind(viewItemsParticipant.userId) && (
                  <TouchableOpacity
                    style={[styles.remindSheetBtn, { flex: 1 }]}
                    onPress={() => { setRemindTarget(viewItemsParticipant); setViewItemsForUser(null); }}
                  >
                    <Ionicons name="notifications-outline" size={16} color="#fff" />
                    <Text style={styles.remindSheetBtnText}>Remind</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity style={[styles.closeBillBtn, { flex: 1 }]} onPress={() => setViewItemsForUser(null)}>
                  <Text style={styles.closeBillText}>Close</Text>
                </TouchableOpacity>
              </View>
            </>
          )}
        </View>
      </Modal>

      {/* Reminder modal */}
      <Modal visible={!!remindTarget} transparent animationType="slide" onRequestClose={() => setRemindTarget(null)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setRemindTarget(null)} />
        <View style={[styles.reminderSheet, { paddingBottom: insets.bottom + 20 }]}>
          <View style={styles.sheetHandle} />
          <Text style={styles.reminderTitle}>
            {remindTarget && isCoverageReminder(remindTarget)
              ? `Lembrar ${remindTarget.profile.name} de te devolver?`
              : `Send reminder to ${remindTarget?.profile.name}?`}
          </Text>
          <Text style={styles.reminderMeta}>
            {remindTarget && formatCurrency(remindTarget.totalOwed, receipt.currency)}
            {remindTarget && isCoverageReminder(remindTarget)
              ? ` — pagaste tu por ${receipt.restaurant}`
              : ` owed for ${receipt.restaurant}`}
          </Text>
          <Text style={styles.reminderSendVia}>Send via:</Text>
          <TouchableOpacity style={styles.reminderOption} onPress={() => remindTarget && handlePushReminder(remindTarget)}>
            <Text style={styles.reminderOptionIcon}>📱</Text><Text style={styles.reminderOptionText}>Push Notification</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.reminderOption} onPress={() => remindTarget && handleEmailReminder(remindTarget)}>
            <Text style={styles.reminderOptionIcon}>📧</Text><Text style={styles.reminderOptionText}>Email</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.reminderOption} onPress={() => remindTarget && handleWhatsAppReminder(remindTarget)}>
            <Text style={styles.reminderOptionIcon}>💬</Text><Text style={styles.reminderOptionText}>WhatsApp</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.reminderCancel} onPress={() => setRemindTarget(null)}>
            <Text style={styles.reminderCancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </Modal>

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
  safe: { flex: 1, backgroundColor: BG },

  header: { alignItems: "center", paddingHorizontal: 16, paddingVertical: 14, gap: 2 },
  headerTitle: { fontSize: 17, fontWeight: "700", color: TEXT },
  headerDate: { fontSize: 12, color: MUTED },

  scroll: { paddingHorizontal: 16, paddingBottom: 20, gap: 14 },

  // Total bill card
  totalCard: { backgroundColor: CARD, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: BORDER, padding: 20, gap: 10 },
  totalCardLabel: { fontSize: 12, fontWeight: "600", color: MUTED, letterSpacing: 0.6, textTransform: "uppercase", textAlign: "center" },
  totalCardAmount: { fontSize: 40, fontWeight: "800", color: TEXT, letterSpacing: -1, textAlign: "center" },
  totalDivider: { height: StyleSheet.hairlineWidth, backgroundColor: BORDER, marginVertical: 2 },
  totalRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  totalRowLabel: { fontSize: 14, color: MUTED },
  totalRowValue: { fontSize: 14, fontWeight: "600", color: TEXT },

  // Bar chart
  chartCard: { backgroundColor: CARD, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: BORDER, overflow: "hidden" },

  // Section label
  sectionLabel: { fontSize: 11, fontWeight: "700", letterSpacing: 0.8, color: MUTED, marginBottom: 10 },

  // Person grid
  personGrid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  personCard: {
    width: "47%",
    backgroundColor: CARD,
    borderRadius: 14,
    borderWidth: 1.5,
    overflow: "hidden",
    position: "relative",
    minHeight: 140,
  },
  personCardContent: {
    padding: 14,
    alignItems: "center",
    gap: 7,
    flex: 1,
  },
  personCardOverlay: {
    position: "absolute",
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: "rgba(11,13,16,0.90)",
    borderRadius: 13,
    justifyContent: "center",
    alignItems: "center",
    gap: 8,
    padding: 10,
  },
  overlayActionBtn: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: BORDER,
    backgroundColor: CARD,
  },
  overlayActionText: { fontSize: 12, fontWeight: "600", color: TEXT },
  hostBadge: { position: "absolute", top: 8, right: 8, backgroundColor: C.primary + "33", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  hostBadgeText: { color: C.primary, fontSize: 10, fontWeight: "700" },
  personCardName: { fontSize: 14, fontWeight: "600", color: TEXT, textAlign: "center" },
  personCardAmount: { fontSize: 20, fontWeight: "800" },
  paidBadge: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
  paidBadgeText: { fontSize: 11, fontWeight: "700" },

  // Receipt breakdown (flat view)
  breakdownAccordion: { marginHorizontal: 16, marginBottom: 12, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: BORDER, overflow: "hidden", backgroundColor: CARD },
  breakdownAccordionHeader: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 14 },
  breakdownAccordionTitle: { flex: 1, fontSize: 14, fontWeight: "600", color: TEXT },
  receiptBreakdown: { paddingVertical: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: BORDER },
  breakdownCatLabel: { fontSize: 10, fontWeight: "700", letterSpacing: 0.6, color: MUTED, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 4, textTransform: "uppercase" },
  breakdownItemRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: BORDER, gap: 8 },
  breakdownItemName: { fontSize: 13, fontWeight: "500", color: TEXT },
  breakdownItemPrice: { fontSize: 11, color: MUTED, marginTop: 2 },
  breakdownUserCluster: { flexDirection: "row", alignItems: "center", minWidth: 26 },
  breakdownAvatarWrap: { borderRadius: 13, borderWidth: 1.5, borderColor: CARD },
  breakdownAvatarOverflow: { width: 26, height: 26, borderRadius: 13, backgroundColor: "#374151", alignItems: "center", justifyContent: "center", borderWidth: 1.5, borderColor: CARD },
  breakdownOverflowText: { color: "#fff", fontSize: 9, fontWeight: "700" },
  breakdownUnassigned: { fontSize: 13, color: MUTED },

  // Action bar
  actionBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    paddingHorizontal: 16,
    paddingTop: 14,
    backgroundColor: CARD,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: BORDER,
  },
  closeBillBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: C.primary,
    paddingVertical: 14,
    borderRadius: 12,
  },
  closeBillText: { color: "#fff", fontSize: 14, fontWeight: "700" },

  // Modals
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)" },
  sheetHandle: { width: 36, height: 4, borderRadius: 2, backgroundColor: BORDER, alignSelf: "center", marginBottom: 8 },

  itemsSheet: { backgroundColor: CARD, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 20, paddingTop: 14, gap: 12 },
  itemsSheetHeader: { flexDirection: "row", alignItems: "center", gap: 12 },
  itemsSheetName: { fontSize: 16, fontWeight: "700", color: TEXT },
  itemsSheetAmount: { fontSize: 14, fontWeight: "600", marginTop: 2 },
  itemsSheetStatusBadge: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8 },
  itemsSheetLabel: { fontSize: 11, fontWeight: "700", letterSpacing: 0.8, color: MUTED },
  itemRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: BORDER },
  itemRowName: { flex: 1, fontSize: 14, color: TEXT, fontWeight: "500", marginRight: 10 },
  itemRowAmount: { fontSize: 14, fontWeight: "700" },
  itemRowSplit: { fontSize: 11, color: MUTED, marginTop: 2 },
  itemRowEmpty: { fontSize: 14, color: MUTED, textAlign: "center", paddingVertical: 24 },
  itemsSheetFooter: { flexDirection: "row", gap: 10, marginTop: 4 },
  remindSheetBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: Colors.primary, paddingVertical: 14, borderRadius: 12 },
  remindSheetBtnText: { color: "#fff", fontSize: 14, fontWeight: "700" },

  reminderSheet: { backgroundColor: CARD, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 16, paddingTop: 14, gap: 8 },
  reminderTitle: { fontSize: 16, fontWeight: "700", color: TEXT },
  reminderMeta: { fontSize: 13, color: MUTED, marginBottom: 4 },
  reminderSendVia: { fontSize: 11, fontWeight: "700", letterSpacing: 0.5, textTransform: "uppercase", color: MUTED },
  reminderOption: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 14, paddingHorizontal: 12, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: BORDER },
  reminderOptionIcon: { fontSize: 20 },
  reminderOptionText: { fontSize: 15, fontWeight: "600", color: TEXT },
  reminderCancel: { alignItems: "center", paddingVertical: 14, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: BORDER, marginTop: 4 },
  reminderCancelText: { fontSize: 15, fontWeight: "600", color: MUTED },

  // Action sheet
  actionSheet: { backgroundColor: CARD, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 20, paddingTop: 14, gap: 12 },
  actionSheetHeader: { flexDirection: "row", alignItems: "center", gap: 12, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: BORDER },
  actionSheetName: { fontSize: 16, fontWeight: "700", color: TEXT },
  actionSheetAmount: { fontSize: 14, fontWeight: "600", marginTop: 2 },
  actionSheetBtn: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 14, paddingHorizontal: 12, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: BORDER },
  actionSheetBtnText: { fontSize: 15, fontWeight: "600", color: TEXT },

  // Cent adjustment
  centAlert: { flexDirection: "row", alignItems: "center", gap: 6, padding: 10, borderRadius: 10, borderWidth: 1, marginTop: 4 },
  centAlertText: { fontSize: 13, fontWeight: "500" },
  centHelperText: { fontSize: 12, fontStyle: "italic", color: MUTED },
  centActions: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  centBtn: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: BORDER },
  centBtnText: { fontSize: 12, fontWeight: "600", color: TEXT },
  rouletteBtn: { backgroundColor: Colors.primary + "22", borderColor: Colors.primary },
  rouletteBtnText: { color: Colors.primary, fontSize: 12, fontWeight: "700" },
  centResolved: { flexDirection: "row", alignItems: "center", gap: 6, padding: 8, borderRadius: 8 },
  centResolvedText: { fontSize: 12, fontWeight: "500" },

  emptyContainer: { flex: 1, alignItems: "center", justifyContent: "center" },
  emptyText: { fontSize: 16, color: MUTED },
});
