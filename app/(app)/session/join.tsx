import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  BackHandler,
  Platform,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
} from "react-native";
import { showDialog } from "@/lib/dialog";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";

const JOIN_THEME = {
  background: "#0A0A0F",
  card: "#1A1B26",
  border: "#252A32",
  text: "#F8FAFC",
  secondary: "#8B8FA3",
  muted: "#6B7280",
};
import { router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "@/constants/colors";
import { QRScanner } from "@/components/session/QRScanner";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { extractSessionIdFromQR } from "@/lib/deeplink";
import { useAuthStore } from "@/store/authStore";
import { useSessionStore } from "@/store/sessionStore";
import { supabase } from "@/lib/supabase";
import { expectRows, showWriteError, withTimeout, WriteError } from "@/lib/checkedWrite";
import { Session, SessionParticipant, UserProfile } from "@/types";
import { getColorForIndex } from "@/constants/colors";
import { getAvatarEmoji } from "@/constants/avatars";
import { useI18nStore } from "@/store/i18nStore";
import { fetchFreshCredits, isNoCreditsError } from "@/lib/credits";

// R7 — what join_preview answers. Before joining only the host's name and the
// number of people are shown: nothing of the bill.
type EntryKind = "rejoin" | "join" | "no_credits" | "closed" | "full" | "not_found" | "invalid";
interface JoinEntry {
  kind: EntryKind;
  id: string;
  hostName: string;
  people: number;
  maxPeople: number;
  myStatus: string | null;
}
interface PreviewRow {
  result?: string;
  host_name?: string | null;
  people?: number;
  max_people?: number;
  my_status?: string | null;
}

const isSessionFullError = (err: any) => err?.code === "PP409" || /SESSION_FULL/.test(String(err?.message ?? ""));

const toEntry = (sessionId: string, row: PreviewRow, kind?: EntryKind): JoinEntry => ({
  kind: kind ?? ((row.result ?? "not_found") as EntryKind),
  id: sessionId,
  hostName: row.host_name ?? "Host",
  people: row.people ?? 0,
  maxPeople: row.max_people ?? 26,
  myStatus: row.my_status ?? null,
});

async function readPreview(sessionId: string): Promise<PreviewRow> {
  const { data, error } = await withTimeout("join: join_preview", supabase.rpc("join_preview", { p_session_id: sessionId }));
  if (error) throw error;
  return (data ?? {}) as PreviewRow;
}

// Busca perfis reais de uma lista de user IDs
async function fetchProfiles(userIds: string[]): Promise<Map<string, UserProfile>> {
  if (userIds.length === 0) return new Map();
  const { data } = await supabase
    .from("profiles")
    .select("id, name, color, avatar_icon, avatar_url, bill_credits, referral_count, is_pro")
    .in("id", userIds);

  const map = new Map<string, UserProfile>();
  (data ?? []).forEach((p: any, idx: number) => {
    map.set(p.id, {
      id: p.id,
      name: p.name ?? "User",
      color: p.color ?? getColorForIndex(idx),
      avatarIcon: p.avatar_icon ?? undefined,
      avatarUrl: p.avatar_url ?? undefined,
      billCredits: p.bill_credits ?? 0,
      referralCount: p.referral_count ?? 0,
      isPro: p.is_pro ?? false,
    });
  });
  return map;
}

export default function JoinSessionScreen() {
  const { profile } = useAuthStore();
  const { setSession } = useSessionStore();
  const { t, language } = useI18nStore();
  void language;
  const { sessionId: linkSessionId } = useLocalSearchParams<{ sessionId?: string }>();
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<JoinEntry | null>(null);
  // Set when Buy credits opens the store: back on this screen, ask again.
  const recheckAfterPurchase = useRef<string | null>(null);

  const textColor = JOIN_THEME.text;
  const mutedColor = JOIN_THEME.secondary;
  const borderColor = JOIN_THEME.border;
  const cardColor = JOIN_THEME.card;

  const fetchSessionPreview = async (sessionId: string) => {
    if (!profile) {
      showDialog(t("join_sign_in_required"), t("join_sign_in_body"), [
        { text: t("cancel"), style: "cancel" },
        { text: t("join_setup_profile"), onPress: () => router.push("/(auth)/profile-setup") },
      ]);
      return;
    }

    setLoading(true);
    try {
      // R7: the server says which entry screen this is (the QR opens at any balance).
      const row = await readPreview(sessionId);
      const kind = (row.result ?? "not_found") as EntryKind;
      console.log(`[join] join_preview: ${kind} (my status ${row.my_status ?? "none"}, ${row.people ?? 0} people)`);

      if (kind === "join") {
        // The host's lobby shows "joining" from this row. (session_id, user_id)
        // is unique: someone who cancelled or left before paying reuses theirs.
        if (row.my_status === "cancelled" || row.my_status === "left") {
          await expectRows(
            `join: ${row.my_status} → pending`,
            supabase
              .from("session_participants")
              .update({ status: "pending" })
              .eq("session_id", sessionId)
              .eq("user_id", profile.id)
              .eq("status", row.my_status)
              .select("id")
          );
          console.log(`[join] Joining again after ${row.my_status} (row reused, pending)`);
        } else {
          const { error: insertError } = await withTimeout("join: insert pending row", supabase
            .from("session_participants")
            .insert({ session_id: sessionId, user_id: profile.id, role: "participant", status: "pending" }));
          if (insertError) throw insertError;
          console.log("[join] Participant inserted (pending)");
        }
      }
      setPreview(toEntry(sessionId, row, kind));
    } catch (err: any) {
      // The server still decides: balance or room changed after the preview.
      if (isNoCreditsError(err) || isSessionFullError(err)) {
        console.log(`[join] server refused the pending row: ${err?.code} ${err?.message}`);
        const kind: EntryKind = isNoCreditsError(err) ? "no_credits" : "full";
        const row = await readPreview(sessionId).catch(() => ({} as PreviewRow));
        setPreview(toEntry(sessionId, row, kind));
        return;
      }
      console.error("[join] fetchSessionPreview error:", err);
      if (err instanceof WriteError) showWriteError(err, t);
      else showDialog(t("error"), `${t("join_error_load")}\n\n${err?.message ?? ""}`.trim());
    } finally {
      setLoading(false);
    }
  };

  // A link (pickandpay://session/<id>) lands here with the id: no scan needed.
  const openedLink = useRef(false);
  useEffect(() => {
    if (!linkSessionId || openedLink.current || !profile) return;
    openedLink.current = true;
    void fetchSessionPreview(String(linkSessionId));
  }, [linkSessionId, profile?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Back from the store: the same entry screen again, without scanning the QR.
  useFocusEffect(
    useCallback(() => {
      const sid = recheckAfterPurchase.current;
      if (!sid || !profile) return;
      recheckAfterPurchase.current = null;
      console.log("[join] back from buying credits — asking the server again");
      void fetchFreshCredits(profile.id);
      void fetchSessionPreview(sid);
    }, [profile?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  );

  const handleBuyCredits = () => {
    if (!preview) return;
    recheckAfterPurchase.current = preview.id;
    router.push("/(app)/pricing");
  };

  const handleCancel = async () => {
    // A rejoin has no pending row to cancel (status is joined/left/…).
    // The row is marked cancelled, not deleted: Realtime does not deliver a
    // DELETE to a filtered subscription, so the host's lobby never heard of it
    // and kept showing "joining". The UPDATE reaches it like any other change.
    if (preview && profile && (preview.kind === "join" || (preview.kind === "rejoin" && preview.myStatus === "pending"))) {
      try {
        await expectRows(
          "join: cancel (pending → cancelled)",
          supabase
            .from("session_participants")
            .update({ status: "cancelled" })
            .eq("session_id", preview.id)
            .eq("user_id", profile.id)
            .eq("status", "pending")
            .select("id")
        );
        console.log("[join] Cancelled (pending → cancelled)");
      } catch (err) {
        showWriteError(err, t);
        return;
      }
    }
    setPreview(null);
  };

  // C3-fix1 — Android back on the confirmation screen used to leave it with
  // no write at all: the row stayed pending (the host kept seeing "joining")
  // and the next scan of the same QR found "Already pending", not cancelled.
  // Back now does exactly what Cancel does.
  const handleCancelRef = useRef(handleCancel);
  handleCancelRef.current = handleCancel;
  useEffect(() => {
    if (!preview || (preview.kind !== "join" && preview.kind !== "rejoin")) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      console.log("[join] Back pressed on the confirmation screen — same as Cancel");
      void handleCancelRef.current();
      return true;
    });
    return () => sub.remove();
  }, [preview]);

  const confirmJoin = async () => {
    if (!preview || !profile) return;

    if (preview.kind !== "join" && preview.kind !== "rejoin") return;
    // R7: join_preview already decided; the server checks again on the write.

    setLoading(true);
    try {
      const sessionId = preview.id;

      // Confirma participante: pending → joined
      await expectRows(
        "join: pending → joined",
        supabase
          .from("session_participants")
          .update({ status: "joined" })
          .eq("session_id", sessionId)
          .eq("user_id", profile.id)
          .select("id")
      );

      // Carrega sessão + participantes completos
      const { data: sessionData, error } = await supabase
        .from("sessions")
        .select(`*, session_participants(*)`)
        .eq("id", sessionId)
        .single();

      if (error || !sessionData) throw error ?? new Error("Session not found");
      console.log(`[join] Joined: session status=${sessionData.status} receipt=${!!sessionData.receipt_data}`);

      // Busca perfis reais de todos os participantes
      // Someone still pending (scanned, not confirmed) or cancelled is not a
      // participant, and must not count in the split's divisor (C.2).
      const participantRows: any[] = (sessionData.session_participants ?? []).filter(
        (sp: any) => sp.status !== "cancelled" && sp.status !== "pending"
      );
      const userIds = participantRows.map((sp: any) => sp.user_id as string);
      const profileMap = await fetchProfiles(userIds);

      const participants: SessionParticipant[] = participantRows.map((sp: any, idx: number) => {
        const p = profileMap.get(sp.user_id as string);
        return {
          userId: sp.user_id as string,
          profile: p ?? {
            id: sp.user_id as string,
            name: "User",
            color: getColorForIndex(idx),
            avatarIcon: undefined,
            billCredits: 0,
            referralCount: 0,
            isPro: false,
          },
          selections: [],
          totalOwed: 0,
          paid: false,
          confirmedByCreator: false,
        };
      });

      // Garante que o próprio user aparece (pode já estar no array)
      if (!participants.find((p) => p.userId === profile.id)) {
        participants.push({
          userId: profile.id,
          profile,
          selections: [],
          totalOwed: 0,
          paid: false,
          confirmedByCreator: false,
        });
      }

      const session: Session = {
        id: sessionData.id,
        creatorId: sessionData.host_id,
        receiptId: sessionData.id,
        receipt: sessionData.receipt_data,
        status: sessionData.status,
        createdAt: sessionData.created_at,
        confirmedBy: [],
        participants,
      };

      setSession(session);
      setPreview(null);
      router.replace(`/(app)/session-lobby/${sessionId}`);
    } catch (err: any) {
      console.error("[join] confirmJoin error:", err);
      if (isNoCreditsError(err)) void fetchSessionPreview(preview.id);   // shows the no-credits screen
      else if (err instanceof WriteError) showWriteError(err, t);
      else showDialog(t("error"), t("join_error_join"));
    } finally {
      setLoading(false);
    }
  };

  const handleScan = (data: string) => {
    const sessionId = extractSessionIdFromQR(data);
    if (sessionId) {
      fetchSessionPreview(sessionId);
    } else {
      console.log("[join] QR is not a Pick&Pay session");
      setPreview(toEntry("", {}, "invalid"));
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.safe}>
        <StatusBar style="light" backgroundColor={JOIN_THEME.background} translucent={false} />
        <LoadingSpinner fullScreen label={t("join_loading")} />
      </SafeAreaView>
    );
  }

  if (preview && preview.kind !== "join" && preview.kind !== "rejoin") {
    // These stay on screen until the person chooses what to do.
    const msg: Record<Exclude<EntryKind, "join" | "rejoin">, { icon: keyof typeof Ionicons.glyphMap; title: string; body: string }> = {
      no_credits: {
        icon: "wallet-outline",
        title: t("join_no_credits_title"),
        body: t("join_no_credits_host_msg").replace("{host}", preview.hostName) + (Platform.OS === "web" ? `\n\n${t("credits_install_app_msg")}` : ""),
      },
      closed: { icon: "checkmark-done-outline", title: t("join_closed_title"), body: t("join_closed_msg") },
      full: { icon: "people-outline", title: t("join_full_title"), body: t("join_full_msg").replace("{max}", String(preview.maxPeople)) },
      not_found: { icon: "help-circle-outline", title: t("join_not_found_title"), body: t("join_not_found_msg") },
      invalid: { icon: "qr-code-outline", title: t("join_invalid_qr_title"), body: t("join_invalid_qr_msg") },
    };
    const m = msg[preview.kind];
    const showHost = preview.kind === "no_credits" || preview.kind === "full" || preview.kind === "closed";
    const canBuy = preview.kind === "no_credits" && Platform.OS !== "web";
    const canRescan = preview.kind === "not_found" || preview.kind === "invalid" || preview.kind === "full";
    return (
      <SafeAreaView style={styles.safe}>
        <StatusBar style="light" backgroundColor={JOIN_THEME.background} translucent={false} />
        <View style={styles.previewContainer}>
          <Ionicons name={m.icon} size={40} color={Colors.primary} style={{ marginBottom: 8 }} />
          <Text style={[styles.previewTitle, { color: textColor }]}>{m.title}</Text>
          {showHost && (
            <View style={[styles.previewCard, { backgroundColor: cardColor, borderColor }]}>
              <View style={styles.previewRow}>
                <Text style={[styles.previewLabel, { color: mutedColor }]}>{t("join_session_host")}</Text>
                <Text style={[styles.previewValue, { color: textColor }]}>{preview.hostName}</Text>
              </View>
              <View style={[styles.previewDivider, { backgroundColor: borderColor }]} />
              <View style={styles.previewRow}>
                <Text style={[styles.previewLabel, { color: mutedColor }]}>{t("join_people")}</Text>
                <Text style={[styles.previewValue, { color: textColor }]}>{preview.people}</Text>
              </View>
            </View>
          )}
          <Text style={[styles.messageBody, { color: mutedColor }]}>{m.body}</Text>
          {canBuy && (
            <TouchableOpacity style={styles.joinBtn} onPress={handleBuyCredits} activeOpacity={0.85}>
              <Text style={styles.joinBtnText}>{t("credits_buy_btn")}</Text>
            </TouchableOpacity>
          )}
          {canRescan && (
            <TouchableOpacity style={styles.joinBtn} onPress={() => setPreview(null)} activeOpacity={0.85}>
              <Text style={styles.joinBtnText}>{t("join_scan_another_btn")}</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={[styles.cancelBtn, { borderColor }]} onPress={() => router.back()}>
            <Text style={[styles.cancelBtnText, { color: mutedColor }]}>{preview.kind === "no_credits" ? t("cancel") : t("back")}</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (preview) {
    const isRejoin = preview.kind === "rejoin";
    const needsCredit = !profile?.isPro && !isRejoin;

    return (
      <SafeAreaView style={styles.safe}>
        {/* No iOS swipe-back here either: leaving must go through Cancel (see BackHandler above). */}
        <Stack.Screen options={{ gestureEnabled: false }} />
        <StatusBar style="light" backgroundColor={JOIN_THEME.background} translucent={false} />
        <View style={styles.previewContainer}>
          <Ionicons name="qr-code-outline" size={40} color={Colors.primary} style={{ marginBottom: 8 }} />
          <Text style={[styles.previewTitle, { color: textColor }]}>
            {isRejoin ? t("join_rejoin_title") : t("join_title")}
          </Text>

          <View style={[styles.previewCard, { backgroundColor: cardColor, borderColor }]}>
            <View style={styles.previewRow}>
              <Text style={[styles.previewLabel, { color: mutedColor }]}>{t("join_session_host")}</Text>
              <Text style={[styles.previewValue, { color: textColor }]}>{preview.hostName}</Text>
            </View>
            <View style={[styles.previewDivider, { backgroundColor: borderColor }]} />
            <View style={styles.previewRow}>
              <Text style={[styles.previewLabel, { color: mutedColor }]}>{t("join_people")}</Text>
              <Text style={[styles.previewValue, { color: textColor }]}>{preview.people}</Text>
            </View>
          </View>

          {isRejoin ? (
            <View style={[styles.creditNotice, { borderColor: Colors.primary + "44", backgroundColor: Colors.primary + "12" }]}>
              <Ionicons name="return-down-forward-outline" size={18} color={Colors.primary} />
              <Text style={[styles.creditNoticeTitle, { color: Colors.primary, flex: 1 }]}>
                {preview.myStatus === "left" ? t("join_left_rejoin_notice") : t("join_rejoin_notice")}
              </Text>
            </View>
          ) : needsCredit && (
            <View style={[styles.creditNotice, { borderColor: Colors.primary + "44", backgroundColor: Colors.primary + "12" }]}>
              <Ionicons name="ellipse" size={18} color="#F59E0B" />
              <View style={{ flex: 1, gap: 6 }}>
                <Text style={[styles.creditNoticeTitle, { color: Colors.primary }]}>
                  {t("join_credit_notice")}
                </Text>
                <Text style={[styles.creditNoticeBody, { color: mutedColor }]}>
                  {t("join_you_have")}{" "}
                  <Text style={{ fontWeight: "700" }}>{profile?.billCredits ?? 0}</Text>{" "}
                  {(profile?.billCredits ?? 0) !== 1 ? t("paywall_credits") : t("paywall_credit")} {t("home_credits_remaining")}.
                </Text>
                <TouchableOpacity onPress={handleBuyCredits} activeOpacity={0.7}>
                  <Text style={[styles.buyCreditsLink, { color: Colors.primary }]}>
                    {t("join_buy_credits_link")}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          <TouchableOpacity style={styles.joinBtn} onPress={confirmJoin} activeOpacity={0.85}>
            <Text style={styles.joinBtnText}>{isRejoin ? t("join_rejoin_btn") : t("join_btn")}</Text>
          </TouchableOpacity>

          <TouchableOpacity style={[styles.cancelBtn, { borderColor }]} onPress={handleCancel}>
            <Text style={[styles.cancelBtnText, { color: mutedColor }]}>{t("cancel")}</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return <QRScanner onScan={handleScan} onClose={() => router.back()} />;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: JOIN_THEME.background },
  previewContainer: {
    flex: 1,
    padding: 24,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
  },
  previewTitle: { fontSize: 22, fontWeight: "700", marginBottom: 4, textAlign: "center" },
  messageBody: { fontSize: 15, lineHeight: 22, textAlign: "center" },
  previewCard: {
    width: "100%",
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  previewRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  previewLabel: { fontSize: 14 },
  previewValue: { fontSize: 15, fontWeight: "600" },
  previewDivider: { height: StyleSheet.hairlineWidth, marginHorizontal: 16 },
  creditNotice: {
    width: "100%",
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
  },
  creditNoticeTitle: { fontSize: 14, fontWeight: "700" },
  creditNoticeBody: { fontSize: 13, lineHeight: 19 },
  buyCreditsLink: { fontSize: 13, fontWeight: "600" },
  joinBtn: {
    width: "100%",
    backgroundColor: Colors.primary,
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: "center",
  },
  joinBtnText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  cancelBtn: {
    width: "100%",
    paddingVertical: 14,
    borderRadius: 14,
    borderWidth: 1.5,
    alignItems: "center",
  },
  cancelBtnText: { fontSize: 15, fontWeight: "600" },
});
