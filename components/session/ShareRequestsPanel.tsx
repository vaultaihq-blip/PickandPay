import React, { useState } from "react";
import { Modal, View, Text, Pressable, ScrollView, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "@/constants/colors";
import type { TranslationKey } from "@/constants/translations";
import { answerShare, manageShareRequest, showUnitsError } from "@/lib/shareUnits";
import { itemKey, lineUnits } from "@/lib/units";
import { receiptLines } from "@/hooks/useShareRequests";
import { formatCurrency } from "@/utils/formatter";
import { useSessionStore } from "@/store/sessionStore";
import { pendingFor, ShareRequest, useShareRequestsStore } from "@/store/shareRequestsStore";

// R12 — share requests in the lobby: the banner for the person asked, the
// summary for everyone, the sheet to answer, and the list where the host
// reminds or cancels (and a requester cancels their own).

type T = (key: TranslationKey) => string;

const nameIn = (userId: string) =>
  useSessionStore.getState().currentSession?.participants.find((p) => p.userId === userId)?.profile.name ?? "?";

/** Banner + summary, inside the lobby's scroll. */
export function ShareRequestsPanel({ myId, t }: { myId: string | undefined; t: T }) {
  const requests = useShareRequestsStore((s) => s.requests);
  const mine = pendingFor(requests, myId);
  const pending = requests.filter((r) => r.status === "pending");
  if (pending.length === 0) return null;
  return (
    <View style={{ gap: 8 }}>
      {mine.length > 0 && (
        <Pressable style={styles.banner} onPress={() => useShareRequestsStore.getState().setSheetOpen(true)}>
          <Ionicons name="people" size={18} color="#F59E0B" />
          <Text style={styles.bannerText}>
            {mine.length === 1 ? t("share_req_banner_one") : t("share_req_banner_many").replace("{n}", String(mine.length))}
          </Text>
          <Ionicons name="chevron-forward" size={18} color="#F59E0B" />
        </Pressable>
      )}
      <Pressable style={styles.summary} onPress={() => useShareRequestsStore.getState().setListOpen(true)}>
        <Text style={styles.summaryText}>
          {pending.length === 1 ? t("share_pending_summary_one") : t("share_pending_summary_many").replace("{n}", String(pending.length))}
        </Text>
        <Ionicons name="chevron-forward" size={16} color="#9CA3AF" />
      </Pressable>
    </View>
  );
}

/** What accepting a request costs, and the sentence for it. */
function describe(r: ShareRequest, myId: string, t: T): string {
  const session = useSessionStore.getState().currentSession;
  const lines = receiptLines(session);
  const line = lines.find((i) => i.id === r.item_id);
  if (!session?.receipt || !line) return "";
  const curr = session.receipt.currency;
  const addons = (line.addOns ?? []).reduce((s, a) => s + a.totalPrice, 0);
  const unitPrice = (line.totalPrice + addons) / lineUnits(line);
  const reqSel = session.participants.find((p) => p.userId === r.from_user)?.selections.find((s) => s.itemId === r.item_id);
  const holders = reqSel?.unitSplits?.[0] ?? 1;
  const pay = unitPrice / (holders + 1);
  const key = itemKey(line);
  const keyLines = new Set(lines.filter((l) => itemKey(l) === key).map((l) => l.id));
  const mySels = session.participants.find((p) => p.userId === myId)?.selections ?? [];
  const hasOther = mySels.some((s) => keyLines.has(s.itemId));
  // Already has their own unit: "Já tens o teu Wisky Sour. O Bruno diz que
  // também bebeste metade do dele." — drank / ate by category, else neutral;
  // "metade" when it would be split in two, otherwise "parte".
  const kind = line.category === "drinks" ? "drink" : line.category === "others" ? "neutral" : "food";
  const portion = holders === 1 ? "half" : "part";
  const shared = t(`share_shared_${kind}_${portion}` as TranslationKey);
  const text = hasOther ? t("share_req_msg_other") : t("share_req_msg");
  return text
    .replace("{shared}", shared)
    .replace("{name}", nameIn(r.from_user))
    .replace("{item}", line.name)
    .replace("{price}", formatCurrency(unitPrice, curr))
    .replace("{amount}", formatCurrency(pay, curr));
}

/** The two windows. Rendered by the screen on top (lobby or selection). */
export function ShareRequestsModals({ sessionId, myId, hostId, t }: { sessionId: string; myId: string | undefined; hostId: string | undefined; t: T }) {
  const requests = useShareRequestsStore((s) => s.requests);
  const sheetOpen = useShareRequestsStore((s) => s.sheetOpen);
  const listOpen = useShareRequestsStore((s) => s.listOpen);
  // re-render when selections change: the amounts in the sheet depend on them
  const session = useSessionStore((s) => s.currentSession);
  const [busy, setBusy] = useState(false);
  if (!myId) return null;
  const mine = pendingFor(requests, myId);
  const pending = requests.filter((r) => r.status === "pending");
  const lines = receiptLines(session);
  const itemName = (id: string) => lines.find((i) => i.id === id)?.name ?? "";
  const isHost = myId === hostId;

  const answer = async (ids: number[], accept: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await answerShare(sessionId, ids, accept);
      useSessionStore.getState().updateSelections(myId, res.selections ?? []);
      for (const r of res.results) {
        const row = requests.find((x) => x.id === r.request_id);
        if (row && r.result !== "not_pending") {
          useShareRequestsStore.getState().upsert({ ...row, status: r.result as ShareRequest["status"] });
        }
      }
    } catch (err) {
      showUnitsError(err, t);
    } finally {
      setBusy(false);
    }
  };

  const manage = async (id: number, action: "cancel" | "remind") => {
    if (busy) return;
    setBusy(true);
    try {
      await manageShareRequest(id, action);
    } catch (err) {
      showUnitsError(err, t);
    } finally {
      setBusy(false);
    }
  };

  const closeSheet = () => useShareRequestsStore.getState().setSheetOpen(false);
  const closeList = () => useShareRequestsStore.getState().setListOpen(false);

  return (
    <>
      <Modal visible={sheetOpen && mine.length > 0} transparent animationType="fade" onRequestClose={closeSheet}>
        <View style={styles.backdrop}>
          <View style={styles.card}>
            <Text style={styles.title}>{t("share_req_title")}</Text>
            <ScrollView style={{ maxHeight: 420 }} contentContainerStyle={{ gap: 12 }}>
              {mine.map((r) => (
                <View key={r.id} style={styles.reqCard}>
                  <Text style={styles.reqText}>{describe(r, myId, t)}</Text>
                  <View style={styles.reqActions}>
                    <Pressable style={[styles.btn, styles.btnGhost]} onPress={() => answer([r.id], false)}>
                      <Text style={styles.btnGhostText}>{t("share_reject")}</Text>
                    </Pressable>
                    <Pressable style={[styles.btn, styles.btnPrimary, busy && { opacity: 0.5 }]} onPress={() => answer([r.id], true)}>
                      <Text style={styles.btnPrimaryText}>{t("share_accept")}</Text>
                    </Pressable>
                  </View>
                </View>
              ))}
            </ScrollView>
            <View style={styles.reqActions}>
              <Pressable style={[styles.btn, styles.btnGhost]} onPress={closeSheet}>
                <Text style={styles.btnGhostText}>{t("share_close")}</Text>
              </Pressable>
              {mine.length > 1 && (
                <Pressable style={[styles.btn, styles.btnPrimary, busy && { opacity: 0.5 }]} onPress={() => answer(mine.map((r) => r.id), true)}>
                  <Text style={styles.btnPrimaryText}>{t("share_accept_all")}</Text>
                </Pressable>
              )}
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={listOpen} transparent animationType="fade" onRequestClose={closeList}>
        <View style={styles.backdrop}>
          <View style={styles.card}>
            <Text style={styles.title}>{t("share_pending_list_title")}</Text>
            <ScrollView style={{ maxHeight: 420 }} contentContainerStyle={{ gap: 10 }}>
              {pending.length === 0 && <Text style={styles.reqText}>—</Text>}
              {pending.map((r) => (
                <View key={r.id} style={styles.reqCard}>
                  <Text style={styles.reqText}>
                    {itemName(r.item_id)} — {nameIn(r.to_user)}
                  </Text>
                  <Text style={styles.reqSub}>{t("share_asked_by").replace("{name}", nameIn(r.from_user))}</Text>
                  {(isHost || r.from_user === myId) && (
                    <View style={styles.reqActions}>
                      {isHost && (
                        <Pressable style={[styles.btn, styles.btnGhost]} onPress={() => manage(r.id, "remind")}>
                          <Text style={styles.btnGhostText}>{t("share_remind")}</Text>
                        </Pressable>
                      )}
                      <Pressable style={[styles.btn, styles.btnDanger]} onPress={() => manage(r.id, "cancel")}>
                        <Text style={styles.btnPrimaryText}>{t("share_cancel_request")}</Text>
                      </Pressable>
                    </View>
                  )}
                </View>
              ))}
            </ScrollView>
            <View style={styles.reqActions}>
              <Pressable style={[styles.btn, styles.btnGhost]} onPress={closeList}>
                <Text style={styles.btnGhostText}>{t("share_close")}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: "row", alignItems: "center", gap: 10, minHeight: 48, paddingHorizontal: 14,
    borderRadius: 12, backgroundColor: "rgba(245,158,11,0.15)", borderWidth: 1, borderColor: "rgba(245,158,11,0.5)",
  },
  bannerText: { flex: 1, color: "#F59E0B", fontSize: 15, fontWeight: "800" },
  summary: {
    flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44, paddingHorizontal: 14,
    borderRadius: 12, backgroundColor: "rgba(255,255,255,0.05)",
  },
  summaryText: { flex: 1, color: "#D1D5DB", fontSize: 14, fontWeight: "600" },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "center", padding: 20 },
  card: { backgroundColor: "#15181D", borderRadius: 16, padding: 18, gap: 12, borderWidth: 1, borderColor: "#252A32" },
  title: { color: "#F9FAFB", fontSize: 17, fontWeight: "800" },
  reqCard: { backgroundColor: "rgba(255,255,255,0.04)", borderRadius: 12, padding: 12, gap: 8 },
  reqText: { color: "#F9FAFB", fontSize: 15, lineHeight: 21 },
  reqSub: { color: "#9CA3AF", fontSize: 12 },
  reqActions: { flexDirection: "row", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" },
  btn: { minHeight: 44, paddingHorizontal: 16, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  btnGhost: { backgroundColor: "transparent" },
  btnGhostText: { color: "#D1D5DB", fontSize: 14, fontWeight: "700" },
  btnPrimary: { backgroundColor: Colors.primary },
  btnDanger: { backgroundColor: "#B91C1C" },
  btnPrimaryText: { color: "#FFFFFF", fontSize: 14, fontWeight: "800" },
});
