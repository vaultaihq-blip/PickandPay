import React, { useMemo, useState } from "react";
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { BottomNavBar } from "@/components/ui/BottomNavBar";
import { useSessionStore } from "@/store/sessionStore";
import { useAuthStore } from "@/store/authStore";
import { formatCurrency, formatDate } from "@/utils/formatter";
import { Session } from "@/types";
import { useI18nStore } from "@/store/i18nStore";
import { showDialog } from "@/lib/dialog";

const THEME = {
  background: "#0A0A0F",
  card: "#1A1B26",
  border: "#252A32",
  primary: "#5B68F4",
  success: "#10B981",
  warning: "#F59E0B",
  danger: "#EF4444",
  text: "#FFFFFF",
  secondary: "#8B8FA3",
  muted: "#6B7280",
};

function getSessionTotal(session: Session) {
  return (
    Object.values(session.receipt?.categories ?? {})
      .flat()
      .reduce((sum, item) => sum + item.totalPrice, 0) +
    (session.receipt?.globalCosts ?? []).reduce((sum, cost) => sum + cost.amount, 0) +
    (session.receipt?.selectedTip ?? 0)
  );
}

export default function HistoryScreen() {
  const { completedSessions, setViewingSession, removeCompletedSession } = useSessionStore();
  const { profile } = useAuthStore();
  const { t, language } = useI18nStore();
  void language;
  const [actionTarget, setActionTarget] = useState<Session | null>(null);

  const insights = useMemo(() => {
    const sessions = completedSessions;

    const currencyCounts: Record<string, number> = {};
    for (const s of sessions) {
      const c = s.receipt?.currency ?? "EUR";
      currencyCounts[c] = (currencyCounts[c] || 0) + 1;
    }
    const dominantCurrency = (Object.entries(currencyCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "EUR") as "EUR" | "USD" | "GBP" | "CAD";

    const totals = sessions.map(getSessionTotal);
    const totalSpent = totals.reduce((sum, total) => sum + total, 0);
    const average = sessions.length > 0 ? totalSpent / sessions.length : 0;
    const mostExpensive = sessions.reduce<Session | null>((best, session) => {
      if (!best) return session;
      return getSessionTotal(session) > getSessionTotal(best) ? session : best;
    }, null);

    const totalSaved = sessions.reduce((sum, session) => {
      const participantCount = session.participants.length || 1;
      const mine = session.participants.find((p) => p.userId === profile?.id);
      if (!mine) return sum;
      const equalShare = getSessionTotal(session) / participantCount;
      return sum + Math.max(0, equalShare - (mine.totalOwed ?? 0));
    }, 0);

    const groupCounts = new Map<string, { label: string; count: number }>();
    for (const session of sessions) {
      const names = session.participants
        .filter((p) => p.userId !== profile?.id)
        .map((p) => p.profile.name)
        .sort();
      if (names.length === 0) continue;
      const key = names.join("|");
      const label = names.slice(0, 3).join(", ") + (names.length > 3 ? ` +${names.length - 3}` : "");
      groupCounts.set(key, { label, count: (groupCounts.get(key)?.count ?? 0) + 1 });
    }
    const frequentGroup = [...groupCounts.values()].sort((a, b) => b.count - a.count)[0];

    const fairnessScore =
      sessions.length === 0
        ? 0
        : Math.round(
            sessions.reduce((sum, session) => {
              const total = getSessionTotal(session);
              const participantCount = session.participants.length || 1;
              const equalShare = total / participantCount;
              const deviation =
                session.participants.reduce(
                  (acc, p) => acc + Math.abs((p.totalOwed ?? 0) - equalShare),
                  0
                ) / Math.max(total, 1);
              return sum + Math.max(0, 100 - deviation * 100);
            }, 0) / sessions.length
          );

    return [
      { emoji: "€", label: t("history_insight_saved"), value: formatCurrency(totalSaved, dominantCurrency) },
      {
        emoji: "$",
        label: t("history_insight_expensive"),
        value: mostExpensive
          ? `${mostExpensive.receipt?.restaurant ?? t("home_bill_fallback")} - ${formatCurrency(getSessionTotal(mostExpensive), mostExpensive.receipt?.currency ?? dominantCurrency)}`
          : t("history_no_data"),
      },
      { emoji: "#", label: t("history_insight_group"), value: frequentGroup ? `${frequentGroup.label} (${frequentGroup.count}x)` : t("history_no_group") },
      { emoji: "/", label: t("history_insight_average"), value: sessions.length > 0 ? formatCurrency(average, dominantCurrency) : formatCurrency(0, dominantCurrency) },
      { emoji: "%", label: t("history_insight_fairness"), value: sessions.length > 0 ? `${fairnessScore}${t("history_fairness_suffix")}` : t("history_no_data") },
    ];
  }, [completedSessions, profile?.id, language]); // eslint-disable-line react-hooks/exhaustive-deps

  const openSplit = (session: Session) => {
    setActionTarget(null);
    setViewingSession(session);
    router.push(`/(app)/dashboard/${session.id}?readOnly=true`);
  };

  const deleteSplit = (session: Session) => {
    showDialog(t("home_delete_title"), t("home_delete_confirm"), [
      { text: t("cancel"), style: "cancel" },
      {
        text: t("delete"),
        style: "destructive",
        onPress: () => {
          removeCompletedSession(session.id);
          setActionTarget(null);
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" backgroundColor={THEME.background} translucent={false} />

      <View style={styles.header}>
        <Text style={styles.headerTitle}>{t("history_title")}</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>{t("history_bill_section")}</Text>

          {completedSessions.length === 0 ? (
            <View style={styles.emptyCard}>
              <Ionicons name="receipt-outline" size={32} color={THEME.muted} />
              <Text style={styles.emptyTitle}>{t("history_no_splits")}</Text>
              <Text style={styles.emptyText}>{t("history_no_splits_sub")}</Text>
            </View>
          ) : (
            <View style={styles.card}>
              {completedSessions.map((session, idx, arr) => {
                const total = getSessionTotal(session);
                const unpaid = session.participants.some((p) => !p.paid);
                return (
                  <TouchableOpacity
                    key={session.id}
                    style={[styles.splitRow, idx < arr.length - 1 && styles.splitRowBorder]}
                    onPress={() => setActionTarget(session)}
                    activeOpacity={0.75}
                  >
                    <Ionicons name="document-text-outline" size={20} color={THEME.secondary} />
                    <View style={styles.splitInfo}>
                      <View style={styles.splitNameRow}>
                        <Text style={styles.splitName} numberOfLines={1}>
                          {session.receipt?.restaurant ?? t("home_bill_fallback")}
                        </Text>
                        {unpaid && <View style={styles.unpaidDot} />}
                      </View>
                      <Text style={styles.splitMeta}>
                        {session.participants.length} {t("history_people_meta")} - {formatDate(session.createdAt)}
                        {unpaid ? ` - ${t("breakdown_unpaid")}` : ""}
                      </Text>
                    </View>
                    <Text style={styles.splitTotal}>
                      {formatCurrency(total, session.receipt?.currency ?? "EUR")}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}
        </View>

        <View style={styles.section}>
          <View style={styles.insightHeader}>
            <Text style={styles.sectionLabel}>{t("history_premium_insights")}</Text>
            <View style={styles.premiumBadge}>
              <Text style={styles.premiumBadgeText}>{t("history_premium")}</Text>
            </View>
          </View>

          <View style={styles.card}>
            {insights.map((ins, i) => (
              <View key={i} style={[styles.insightRow, i < insights.length - 1 && styles.insightRowBorder]}>
                <Text style={styles.insightEmoji}>{ins.emoji}</Text>
                <View style={styles.insightContent}>
                  <Text style={styles.insightLabel}>{ins.label}</Text>
                  <Text style={styles.insightValue}>{ins.value}</Text>
                </View>
              </View>
            ))}
          </View>

          <Text style={styles.insightsNote}>{t("history_insights_note")}</Text>
        </View>
      </ScrollView>

      <BottomNavBar activeTab="history" />

      {actionTarget && (
        <Modal transparent animationType="slide" visible onRequestClose={() => setActionTarget(null)}>
          <TouchableOpacity style={styles.sheetOverlay} activeOpacity={1} onPress={() => setActionTarget(null)} />
          <View style={styles.actionSheet}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle} numberOfLines={1}>
              {actionTarget.receipt?.restaurant ?? t("home_bill_fallback")} - {formatCurrency(getSessionTotal(actionTarget), actionTarget.receipt?.currency ?? "EUR")}
            </Text>

            <TouchableOpacity style={[styles.sheetOption, { backgroundColor: THEME.primary }]} onPress={() => openSplit(actionTarget)}>
              <Text style={styles.sheetOptionText}>{t("home_view_split")}</Text>
            </TouchableOpacity>

            <TouchableOpacity style={[styles.sheetOption, { backgroundColor: THEME.danger }]} onPress={() => deleteSplit(actionTarget)}>
              <Text style={styles.sheetOptionText}>{t("home_delete_history")}</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.sheetCancel} onPress={() => setActionTarget(null)}>
              <Text style={styles.sheetOptionText}>{t("cancel")}</Text>
            </TouchableOpacity>
          </View>
        </Modal>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: THEME.background },
  header: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 },
  headerTitle: { fontSize: 24, fontWeight: "800", color: THEME.text },
  scroll: { paddingHorizontal: 20, paddingBottom: 100, gap: 24, paddingTop: 8 },
  section: { gap: 10 },
  sectionLabel: { fontSize: 11, fontWeight: "700", letterSpacing: 0.8, color: THEME.muted },
  emptyCard: {
    backgroundColor: THEME.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: THEME.border,
    alignItems: "center",
    paddingVertical: 36,
    gap: 8,
  },
  emptyTitle: { fontSize: 15, fontWeight: "700", color: THEME.text },
  emptyText: { fontSize: 13, color: THEME.secondary, textAlign: "center", paddingHorizontal: 24, lineHeight: 18 },
  card: { backgroundColor: THEME.card, borderRadius: 16, borderWidth: 1, borderColor: THEME.border, overflow: "hidden" },
  splitRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 14, gap: 12 },
  splitRowBorder: { borderBottomWidth: 1, borderBottomColor: THEME.border },
  splitInfo: { flex: 1 },
  splitNameRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  splitName: { fontSize: 14, fontWeight: "600", color: THEME.text, flexShrink: 1 },
  splitMeta: { fontSize: 12, color: THEME.secondary, marginTop: 2 },
  splitTotal: { fontSize: 14, fontWeight: "700", color: THEME.text },
  unpaidDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: THEME.warning },
  insightHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  premiumBadge: { backgroundColor: "#6366F133", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6 },
  premiumBadgeText: { fontSize: 10, fontWeight: "700", color: "#6366F1" },
  insightRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 14, gap: 12 },
  insightRowBorder: { borderBottomWidth: 1, borderBottomColor: THEME.border },
  insightEmoji: { fontSize: 18, width: 28, textAlign: "center", color: THEME.text, fontWeight: "800" },
  insightContent: { flex: 1 },
  insightLabel: { fontSize: 12, color: THEME.secondary, fontWeight: "500" },
  insightValue: { fontSize: 14, fontWeight: "600", color: THEME.text, marginTop: 2 },
  insightsNote: { fontSize: 12, color: THEME.muted, textAlign: "center", lineHeight: 17 },
  sheetOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)" },
  actionSheet: { backgroundColor: THEME.card, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 18, gap: 10 },
  sheetHandle: { alignSelf: "center", width: 42, height: 4, borderRadius: 2, backgroundColor: THEME.border, marginBottom: 6 },
  sheetTitle: { color: THEME.text, fontSize: 15, fontWeight: "700", marginBottom: 4 },
  sheetOption: { borderRadius: 12, paddingVertical: 14, alignItems: "center" },
  sheetCancel: { borderRadius: 12, paddingVertical: 14, alignItems: "center", backgroundColor: THEME.muted },
  sheetOptionText: { color: "#fff", fontSize: 15, fontWeight: "700" },
});
