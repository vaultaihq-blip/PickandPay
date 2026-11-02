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
import { endSession, showEndSessionError } from "@/lib/endSession";
import { useHostTransfer } from "@/hooks/useHostTransfer";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as MailComposer from "expo-mail-composer";
import { maybeShowReviewPrompt } from "@/utils/review";
import { Colors } from "@/constants/colors";
import { useSessionStore } from "@/store/sessionStore";
import { fetchFreshCredits } from "@/lib/credits";
import { useAuthStore } from "@/store/authStore";
import { BarChart } from "@/components/dashboard/BarChart";
import { BreakdownCard } from "@/components/dashboard/BreakdownCard";
import { SessionMissing } from "@/components/session/SessionMissing";
import { SummaryShare } from "@/components/dashboard/SummaryShare";
import { CentRoulette } from "@/components/roulette/CentRoulette";
import { Avatar } from "@/components/ui/Avatar";
import { formatCurrency } from "@/utils/formatter";
import { Colors as C } from "@/constants/colors";
import { supabase } from "@/lib/supabase";
import { expectRows, showWriteError } from "@/lib/checkedWrite";
import { CentAdjustment, ItemSelection, SessionParticipant, PaymentReminder } from "@/types";
import { sendPushNotification } from "@/lib/notifications";
import { toCents, fromCents } from "@/utils/validator";
import { useI18nStore } from "@/store/i18nStore";
import { orderParticipants } from "@/lib/sessionColors";

const BG = "#0B0D10";
const CARD = "#15181D";
const BORDER = "#252A32";
const TEXT = "#F8FAFC";
const MUTED = "#6B7280";



// sessions row (or realtime payload) → the adjustment, if one has been saved.
function centAdjustmentFromRow(row: Record<string, unknown> | null | undefined): CentAdjustment | null {
  const cents = row?.cent_adjustment_cents as number | null | undefined;
  const userId = row?.cent_adjustment_user_id as string | null | undefined;
  const method = row?.cent_adjustment_method as CentAdjustment["method"] | null | undefined;
  if (!cents || !userId || !method) return null;
  return { amount: fromCents(cents), assignedTo: userId, method };
}

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
    currentSession, markPaid, markViewingPaid, markCoveredBy, setStatus, setCentAdjustment, setSplitUserIds, updateSelections,
    splitResults: storeSplitResults, addReminder, clearSession, addCompletedSession,
    viewingSession, viewingSplitResults, setViewingSession,
  } = useSessionStore();
  const { profile } = useAuthStore();
  const { t, language } = useI18nStore();
  void language;

  const [rouletteVisible, setRouletteVisible] = useState(false);
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

  // R6b — the payment phase goes on if the host is gone for 5 min: the server
  // hands the role to the first person still here; this device follows and says so.
  useHostTransfer(
    isReadOnly || !session || session.id.startsWith("session_") || session.id.startsWith("dev_session_") ? undefined : session.id,
    (change) => {
      const people = useSessionStore.getState().currentSession?.participants ?? [];
      const nameOf = (uid: string) => people.find((p) => p.userId === uid)?.profile.name ?? "User";
      showDialog(
        t("host_changed_title"),
        change.mine
          ? `${t("host_now_you").replace("{name}", nameOf(change.fromId))}

${t("host_now_you_payments")}`
          : t("host_now_other").replace("{name}", nameOf(change.toId))
      );
    }
  );

  // true when the frozen set changed
  const applySplitUserIds = (value: unknown): boolean => {
    if (!Array.isArray(value) || value.length === 0) return false;
    const ids = value as string[];
    const current = useSessionStore.getState().currentSession?.splitUserIds;
    if (current && current.length === ids.length && current.every((id, i) => id === ids[i])) return false;
    console.log(`[dashboard] split frozen by the server: n=${ids.length}`);
    setSplitUserIds(ids);
    return true;
  };

  // finalize_session takes people who are not in the split out of the
  // sharedWith lists (their part goes to those still sharing the item), and
  // the shares here come from the store: load the saved selections.
  const syncSplitSelections = (sessionId: string, value: unknown) => {
    if (!Array.isArray(value) || value.length === 0) return;
    const key = (sels: ItemSelection[]) =>
      JSON.stringify(sels.map((s) => [s.itemId, s.quantity ?? 1, s.sharedWith ?? []]));
    supabase
      .from("session_participants")
      .select("user_id, selections")
      .eq("session_id", sessionId)
      .in("user_id", value as string[])
      .then(({ data, error }) => {
        if (error || !data) { console.error("[dashboard] Failed to load selections:", error); return; }
        const current = useSessionStore.getState().currentSession?.participants ?? [];
        let changed = 0;
        for (const row of data) {
          const sels = (Array.isArray(row.selections) ? row.selections : []) as ItemSelection[];
          const p = current.find((x) => x.userId === row.user_id);
          if (!p || key(p.selections) === key(sels)) continue;
          updateSelections(row.user_id as string, sels);
          changed++;
        }
        console.log(`[dashboard] selections checked against the server: ${changed} updated`);
      });
  };

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
    // R1: once finalized, the bill is divided between the frozen set only.
    const frozen = session.splitUserIds ? new Set(session.splitUserIds) : null;
    const inSplit = frozen ? session.participants.filter((p) => frozen.has(p.userId)) : session.participants;
    // R4: host first, then me, then by arrival — the same order on every device.
    return orderParticipants(inSplit, session.creatorId, profile?.id);
  }, [session?.participants, session?.splitUserIds, session?.creatorId, profile?.id]); // eslint-disable-line react-hooks/exhaustive-deps

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
    // The history keeps the host this device had at close; the host buttons
    // follow the server's host_id (the role may have moved since — R6b).
    supabase.from("sessions").select("host_id, original_host_id").eq("id", session.id).single().then(({ data, error }) => {
      if (error || !data) {
        console.log(`[dashboard] history: host lookup failed: ${error?.message ?? "no row"}`);
        return;
      }
      const viewing = useSessionStore.getState().viewingSession;
      if (viewing && viewing.id === session.id && (viewing.creatorId !== data.host_id || viewing.originalHostId !== (data.original_host_id ?? undefined))) {
        console.log(`[dashboard] history: host is ${data.host_id} on the server (this device had ${viewing.creatorId})`);
        setViewingSession({ ...viewing, creatorId: data.host_id, originalHostId: data.original_host_id ?? undefined });
      }
    });
    supabase.from("session_participants").select("user_id, paid").eq("session_id", session.id).then(({ data }) => {
      if (!data) return;
      for (const row of data) {
        if (row.paid !== undefined) markViewingPaid(row.user_id as string, row.paid as boolean);
      }
    });
  }, [isReadOnly, session?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // B.2 — rounding adjustment saved on the session (by the host), and (C.2)
  // the participant set the server froze at finalize. Read once on open;
  // participants also get later changes from the sessions channel below.
  useEffect(() => {
    if (isReadOnly || !session) return;
    if (session.id.startsWith("session_") || session.id.startsWith("dev_session_")) return;
    supabase
      .from("sessions")
      .select("cent_adjustment_cents, cent_adjustment_user_id, cent_adjustment_method, split_user_ids")
      .eq("id", session.id)
      .single()
      .then(({ data, error }) => {
        if (error) { console.error("[dashboard] Failed to load session split data:", error); return; }
        applySplitUserIds(data?.split_user_ids);
        syncSplitSelections(session.id, data?.split_user_ids);
        const adjustment = centAdjustmentFromRow(data);
        if (adjustment) setCentAdjustment(adjustment);
      });
    // The credit was spent server-side at finalize; show the real balance.
    if (profile?.id) void fetchFreshCredits(profile.id);
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
                if (applySplitUserIds(payload.new?.split_user_ids)) syncSplitSelections(session.id, payload.new?.split_user_ids);
                const adjustment = centAdjustmentFromRow(payload.new);
                if (adjustment) setCentAdjustment(adjustment);
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
        // paid is not client-writable (B.3): host-only RPC.
        await expectRows(
          "dashboard: mark paid",
          supabase.rpc("set_participant_paid", { p_session_id: session.id, p_user_id: userId, p_paid: paid })
        );
      } catch (err) {
        // Undo the optimistic mark so the screen shows what the server has.
        if (isReadOnly) markViewingPaid(userId, !paid);
        else markPaid(userId, !paid);
        showWriteError(err, t);
      }
    }
  };

  // C.3 — everyone in the frozen split at once (host-only RPC, one
  // transaction). true when the server confirmed it (or nothing was left).
  const handleMarkAllPaid = async (): Promise<boolean> => {
    if (!session || !isCreator) return false;
    const ids = sortedParticipants.filter((p) => !p.paid).map((p) => p.userId);
    if (ids.length === 0) return true;
    const apply = (paid: boolean) => ids.forEach((uid) => (isReadOnly ? markViewingPaid(uid, paid) : markPaid(uid, paid)));
    apply(true);
    const isOffline = session.id.startsWith("session_") || session.id.startsWith("dev_session_");
    if (isOffline) return true;
    try {
      const [res] = await expectRows<{ changed?: number; split?: number }>(
        "dashboard: mark all paid",
        supabase.rpc("set_all_participants_paid", { p_session_id: session.id, p_paid: true })
      );
      console.log(`[dashboard] marked all paid: ${res?.changed ?? "?"} changed of ${res?.split ?? "?"} in the split`);
      return true;
    } catch (err) {
      apply(false);
      showWriteError(err, t);
      return false;
    }
  };

  const handleMarkCoveredBy = async (targetUserId: string, coveredByUserId: string | null) => {
    const isOffline = session?.id.startsWith("session_") || session?.id.startsWith("dev_session_");
    const previous = session?.participants.find((p) => p.userId === targetUserId)?.coveredByUserId ?? null;
    markCoveredBy(targetUserId, coveredByUserId);
    if (session && !isOffline) {
      try {
        // covered_by_user_id is not client-writable (B.3): host-only RPC.
        await expectRows(
          "dashboard: mark covered by",
          supabase.rpc("set_participant_covered_by", {
            p_session_id: session.id,
            p_user_id: targetUserId,
            p_covered_by: coveredByUserId,
          })
        );
      } catch (err) {
        markCoveredBy(targetUserId, previous);
        showWriteError(err, t);
      }
    }
  };

  // B.2 — the choice is saved on the session first; every device (host and
  // participants) applies it from there, so the shares add up to the bill.
  const saveCentAdjustment = async (adjustment: CentAdjustment): Promise<boolean> => {
    if (!session) return false;
    const isOffline = session.id.startsWith("session_") || session.id.startsWith("dev_session_");
    if (!isOffline) {
      try {
        await expectRows(
          "dashboard: assign rounding difference",
          supabase.rpc("set_cent_adjustment", {
            p_session_id: session.id,
            p_user_id: adjustment.assignedTo,
            p_cents: centDiffCents,
            p_method: adjustment.method,
          })
        );
      } catch (err) {
        showWriteError(err, t);
        return false;
      }
    }
    setCentAdjustment(adjustment);
    return true;
  };

  const handleCentAssign = (method: "creator" | "highest") => {
    if (!session) return;
    let assignedTo = profile?.id ?? "";
    if (method === "creator") assignedTo = session.creatorId;
    else { let max = 0; for (const p of session.participants) { if (p.totalOwed > max) { max = p.totalOwed; assignedTo = p.userId; } } }
    void saveCentAdjustment({ amount: centDiff, assignedTo, method });
  };

  const handleRouletteAccept = async (userId: string) => {
    const saved = await saveCentAdjustment({ amount: centDiff, assignedTo: userId, method: "roulette" });
    if (saved) setRouletteVisible(false);
  };

  const doClose = async () => {
    if (!session) return;
    setClosing(true);
    try {
      if (!session.id.startsWith("session_") && !session.id.startsWith("dev_session_")) {
        await endSession("dashboard: close bill", session.id);
      }
      setStatus("closed");
      maybeShowReviewPrompt();
      clearSession();
      router.replace("/(app)");
    } catch (err) {
      showEndSessionError(err, t);
    } finally { setClosing(false); }
  };

  const handleCloseBill = () => {
    if (!session) return;
    // The people in the split (R1), the same set "mark all paid" marks.
    const unpaid = sortedParticipants.filter((p) => !p.paid);
    if (unpaid.length === 0) { doClose(); return; }
    showDialog("⚠️ Unpaid participants",
      `${unpaid.length} ${unpaid.length === 1 ? "person hasn't" : "people haven't"} paid yet:\n\n${unpaid.map((p) => p.profile.name).join(", ")}\n\nClose bill anyway?`,
      [
        { text: t("cancel"), style: "cancel" },
        { text: t("dashboard_mark_all_paid_close"), onPress: async () => { if (await handleMarkAllPaid()) await doClose(); } },
        { text: t("dashboard_close_anyway"), style: "destructive", onPress: doClose },
      ]);
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
        <SessionMissing
          label="dashboard"
          sessionId={sessionId ? String(sessionId) : undefined}
          textColor={MUTED}
          accentColor={C.primary}
        />
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
        {/* R6b — the money changes hands outside the app; this screen only records it, and never expires. */}
        {!isReadOnly && (
          <View style={styles.payNote}>
            <Ionicons name="information-circle-outline" size={16} color={MUTED} />
            <Text style={styles.payNoteText}>{isCreator ? t("dashboard_pay_note_host") : t("dashboard_pay_note")}</Text>
          </View>
        )}

        {/* Total Bill Card */}
        <View style={styles.totalCard}>
          <Text style={styles.totalCardLabel}>Total bill</Text>
          <Text style={styles.totalCardAmount}>{formatCurrency(displayTotal, receipt.currency)}</Text>
          <View style={styles.totalDivider} />
          {/* R2 — each charge under its own name (the one the host gave a
              charge with no line); a discount shows as a minus. */}
          {receipt.globalCosts.length > 0 ? (
            receipt.globalCosts.map((cost) => (
              <View key={cost.id} style={styles.totalRow}>
                <Text style={styles.totalRowLabel}>{cost.name}</Text>
                <Text style={styles.totalRowValue}>
                  {cost.amount < 0 ? "−" : ""}{formatCurrency(Math.abs(cost.amount), receipt.currency)}
                </Text>
              </View>
            ))
          ) : (
            <View style={styles.totalRow}>
              <Text style={styles.totalRowLabel}>Service</Text>
              <Text style={[styles.totalRowValue, { color: MUTED }]}>{formatCurrency(globalCostsTotal, receipt.currency)}</Text>
            </View>
          )}
          <View style={styles.totalRow}>
            <Text style={styles.totalRowLabel}>Tip</Text>
            <Text style={[styles.totalRowValue, tipTotal === 0 ? { color: MUTED } : { color: C.success }]}>{formatCurrency(tipTotal, receipt.currency)}</Text>
          </View>
          <View style={[styles.totalRow, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: BORDER, paddingTop: 8, marginTop: 2 }]}>
            <Text style={[styles.totalRowLabel, { color: TEXT, fontWeight: "700" }]}>Total</Text>
            <Text style={[styles.totalRowValue, { color: TEXT, fontWeight: "800", fontSize: 16 }]}>{formatCurrency(displayTotal, receipt.currency)}</Text>
          </View>

          {hasCentDiff && !session.centAdjustment && (
            <>
              <View style={[styles.centAlert, { borderColor: C.warning }]}>
                <Ionicons name="warning-outline" size={16} color={C.warning} />
                <Text style={[styles.centAlertText, { color: C.warning }]}>
                  {formatCurrency(Math.abs(centDiff), receipt.currency)} {t("dashboard_rounding_diff")}
                </Text>
              </View>
              <Text style={styles.centHelperText}>{t("dashboard_someone_needs")}</Text>
              {isCreator && (
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
              )}
            </>
          )}
          {session.centAdjustment && (
            <View style={[styles.centResolved, { backgroundColor: C.success + "22" }]}>
              <Ionicons name="checkmark-circle" size={14} color={C.success} />
              <Text style={[styles.centResolvedText, { color: C.success }]}>
                {formatCurrency(Math.abs(session.centAdjustment.amount), receipt.currency)} {t("dashboard_assigned_to")}{" "}
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
                  {p.userId === session.originalHostId && p.userId !== session.creatorId && (
                    <View style={[styles.hostBadge, styles.originalHostBadge]}>
                      <Text style={[styles.hostBadgeText, styles.originalHostBadgeText]}>{t("session_original_host_badge")}</Text>
                    </View>
                  )}
                  <View style={styles.personCardContent}>
                    <Avatar name={enriched.profile.name} avatarIcon={enriched.profile.avatarIcon} avatarUrl={enriched.profile.avatarUrl} color={enriched.profile.color} color2={enriched.profile.color2} size={48} />
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
          {isCreator && sortedParticipants.some((p) => !p.paid) && (
            <TouchableOpacity style={[styles.closeBillBtn, styles.markAllPaidBtn]} onPress={() => void handleMarkAllPaid()}>
              <Ionicons name="checkmark-done-outline" size={18} color="#fff" />
              <Text style={styles.closeBillText}>{t("dashboard_mark_all_paid")}</Text>
            </TouchableOpacity>
          )}
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
                                    <Avatar name={u.profile.name} avatarIcon={u.profile.avatarIcon} avatarUrl={u.profile.avatarUrl} color={u.profile.color} color2={u.profile.color2} size={26} />
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
                  color={actionSheetP.profile.color} color2={actionSheetP.profile.color2}
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
                <Avatar name={viewItemsParticipant.profile.name} avatarIcon={viewItemsParticipant.profile.avatarIcon} avatarUrl={viewItemsParticipant.profile.avatarUrl} color={viewItemsParticipant.profile.color} color2={viewItemsParticipant.profile.color2} size={40} />
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
                      <Text style={styles.itemRowName} numberOfLines={3}>
                        {entry.itemName}
                        {/* R12 — "(partilhado com Bruno)" */}
                        {entry.sharedWith && entry.sharedWith.length > 0
                          ? ` (${t("split_shared_with").replace(
                              "{names}",
                              entry.sharedWith.map((uid) => session?.participants.find((p) => p.userId === uid)?.profile.name ?? "?").join(", ")
                            )})`
                          : ""}
                      </Text>
                      <View style={{ alignItems: "flex-end" }}>
                        <Text style={[styles.itemRowAmount, { color: viewItemsParticipant.profile.color ?? C.primary }]}>
                          {formatCurrency(entry.amount, receipt.currency)}
                        </Text>
                        {entry.splitCount > 1 ? (
                          <Text style={styles.itemRowSplit}>÷{entry.splitCount} of {formatCurrency(entry.itemTotal, receipt.currency)}</Text>
                        ) : (entry.units ?? 1) > 1 && entry.unitPrice !== undefined ? (
                          <Text style={styles.itemRowSplit}>{entry.units} × {formatCurrency(entry.unitPrice, receipt.currency)}</Text>
                        ) : null}
                      </View>
                    </View>
                  ))
                ) : (
                  <Text style={styles.itemRowEmpty}>No individual items — bill split equally</Text>
                )}
                {/* R2 — each charge under its own name; a discount shows as a minus. */}
                {(viewItemsSplitResult?.globalCostsShare ?? 0) !== 0 &&
                  (viewItemsSplitResult!.costBreakdown?.length ? (
                    viewItemsSplitResult!.costBreakdown.map((c) => (
                      <View key={c.costId} style={styles.itemRow}>
                        <Text style={styles.itemRowName}>{c.name}</Text>
                        <Text style={[styles.itemRowAmount, { color: MUTED }]}>
                          {c.amount < 0 ? "−" : "+"}{formatCurrency(Math.abs(c.amount), receipt.currency)}
                        </Text>
                      </View>
                    ))
                  ) : (
                    <View style={styles.itemRow}>
                      <Text style={styles.itemRowName}>Tax & fees share</Text>
                      <Text style={[styles.itemRowAmount, { color: MUTED }]}>+{formatCurrency(viewItemsSplitResult!.globalCostsShare, receipt.currency)}</Text>
                    </View>
                  ))}
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
  originalHostBadge: { backgroundColor: "transparent", borderWidth: 1, borderColor: BORDER },
  originalHostBadgeText: { color: MUTED },
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
  markAllPaidBtn: { flex: 0, marginTop: 12, backgroundColor: C.success },

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
  payNote: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: BORDER,
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
  },
  payNoteText: { flex: 1, fontSize: 12, lineHeight: 17, color: MUTED },
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
