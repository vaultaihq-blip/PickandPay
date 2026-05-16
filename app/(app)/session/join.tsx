import React, { useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  useColorScheme,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "@/constants/colors";
import { QRScanner } from "@/components/session/QRScanner";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { extractSessionIdFromQR } from "@/lib/deeplink";
import { useAuthStore } from "@/store/authStore";
import { useSessionStore } from "@/store/sessionStore";
import { supabase } from "@/lib/supabase";
import { Session, SessionParticipant, UserProfile } from "@/types";
import { getColorForIndex } from "@/constants/colors";
import { getAvatarEmoji } from "@/constants/avatars";

interface SessionPreview {
  id: string;
  hostName: string;
  createdAt: string;
  isRejoin: boolean;
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
  const isDark = useColorScheme() === "dark";
  const { profile } = useAuthStore();
  const { setSession } = useSessionStore();
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<SessionPreview | null>(null);

  const textColor = isDark ? Colors.textPrimaryDark : Colors.textPrimaryLight;
  const mutedColor = isDark ? Colors.textMutedDark : Colors.textMutedLight;
  const bgColor = isDark ? Colors.bgDark : Colors.bgLight;
  const borderColor = isDark ? Colors.cardBorderDark : Colors.cardBorderLight;
  const cardColor = isDark ? Colors.cardDark : Colors.cardLight;

  const fetchSessionPreview = async (sessionId: string) => {
    if (!profile) {
      Alert.alert("Sign in required", "Please set up your profile to join a session.", [
        { text: "Cancel", style: "cancel" },
        { text: "Set up profile", onPress: () => router.push("/(auth)/profile-setup") },
      ]);
      return;
    }

    setLoading(true);
    try {
      // Inserir participante PRIMEIRO — sem onConflict (sem unique constraint ainda).
      // 23505 = já existe → OK, continua.
      console.log("[join] Inserting pending participant record...");
      const { error: participantError } = await supabase
        .from("session_participants")
        .insert({ session_id: sessionId, user_id: profile.id, role: "participant", status: "pending" });

      let isRejoin = false;
      if (participantError && participantError.code !== "23505") {
        console.warn("[join] Participant insert warning:", participantError.code, participantError.message);
      } else if (participantError?.code === "23505") {
        // Already a participant — check if this is a rejoin (previously joined/left)
        const { data: existingRow } = await supabase
          .from("session_participants")
          .select("status")
          .eq("session_id", sessionId)
          .eq("user_id", profile.id)
          .single();
        isRejoin = existingRow?.status === "joined" || existingRow?.status === "left";
        console.log("[join]", isRejoin ? "Rejoining session" : "Already pending");
      } else {
        console.log("[join] Participant inserted (pending)");
      }

      // Agora carrega a sessão — RLS permite porque o user é participante
      console.log("[join] Loading session...");
      const { data: sessionData, error } = await supabase
        .from("sessions")
        .select("id, host_id, created_at")
        .eq("id", sessionId)
        .single();

      if (error) {
        await supabase
          .from("session_participants")
          .delete()
          .eq("session_id", sessionId)
          .eq("user_id", profile.id)
          .eq("status", "pending");
        if (error.code === "PGRST116") {
          throw new Error("Session not found. Check that the RLS policy was updated in Supabase.");
        }
        throw error;
      }

      // Busca o nome do host
      const { data: hostProfile } = await supabase
        .from("profiles")
        .select("name")
        .eq("id", sessionData.host_id)
        .single();

      setPreview({
        id: sessionId,
        hostName: hostProfile?.name ?? "Host",
        createdAt: sessionData.created_at,
        isRejoin,
      });
    } catch (err: any) {
      console.error("[join] fetchSessionPreview error:", err);
      Alert.alert("Error", err?.message ?? "Could not load session. Please check the QR code.");
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = async () => {
    if (preview && profile) {
      await supabase
        .from("session_participants")
        .delete()
        .eq("session_id", preview.id)
        .eq("user_id", profile.id)
        .eq("status", "pending");
    }
    setPreview(null);
  };

  const confirmJoin = async () => {
    if (!preview || !profile) return;

    // Skip credit check when rejoining (user already paid for this session)
    if (!preview.isRejoin && !profile.isPro && (profile.billCredits ?? 0) <= 0) {
      Alert.alert(
        "No Credits Left",
        "You need 1 credit to join this split.",
        [
          { text: "Buy Credits", onPress: () => router.push("/(app)/paywall") },
          { text: "Cancel", style: "cancel" },
        ]
      );
      return;
    }

    setLoading(true);
    try {
      const sessionId = preview.id;

      // Confirma participante: pending → joined
      await supabase
        .from("session_participants")
        .update({ status: "joined" })
        .eq("session_id", sessionId)
        .eq("user_id", profile.id);

      // Carrega sessão + participantes completos
      const { data: sessionData, error } = await supabase
        .from("sessions")
        .select(`*, session_participants(*)`)
        .eq("id", sessionId)
        .single();

      if (error || !sessionData) throw error ?? new Error("Session not found");

      // Busca perfis reais de todos os participantes
      const participantRows: any[] = sessionData.session_participants ?? [];
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
      router.replace(`/(app)/session/${sessionId}`);
    } catch (err: any) {
      console.error("[join] confirmJoin error:", err);
      Alert.alert("Error", "Could not join session. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleScan = (data: string) => {
    const sessionId = extractSessionIdFromQR(data);
    if (sessionId) {
      fetchSessionPreview(sessionId);
    } else {
      Alert.alert("Invalid QR", "This QR code doesn't appear to be a Pick&Pay session.");
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: bgColor }]}>
        <LoadingSpinner fullScreen label="Loading session..." />
      </SafeAreaView>
    );
  }

  if (preview) {
    const needsCredit = !profile?.isPro && !preview.isRejoin;
    const dateStr = new Date(preview.createdAt).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });

    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: bgColor }]}>
        <View style={styles.previewContainer}>
          <Ionicons name="qr-code-outline" size={40} color={Colors.primary} style={{ marginBottom: 8 }} />
          <Text style={[styles.previewTitle, { color: textColor }]}>
            {preview.isRejoin ? "Rejoin Session" : "Join Split Session"}
          </Text>

          <View style={[styles.previewCard, { backgroundColor: cardColor, borderColor }]}>
            <View style={styles.previewRow}>
              <Text style={[styles.previewLabel, { color: mutedColor }]}>Session Host</Text>
              <Text style={[styles.previewValue, { color: textColor }]}>{preview.hostName}</Text>
            </View>
            <View style={[styles.previewDivider, { backgroundColor: borderColor }]} />
            <View style={styles.previewRow}>
              <Text style={[styles.previewLabel, { color: mutedColor }]}>Date</Text>
              <Text style={[styles.previewValue, { color: textColor }]}>{dateStr}</Text>
            </View>
          </View>

          {preview.isRejoin ? (
            <View style={[styles.creditNotice, { borderColor: Colors.primary + "44", backgroundColor: Colors.primary + "12" }]}>
              <Ionicons name="return-down-forward-outline" size={18} color={Colors.primary} />
              <Text style={[styles.creditNoticeTitle, { color: Colors.primary, flex: 1 }]}>
                You're rejoining this session — no extra credits will be deducted.
              </Text>
            </View>
          ) : needsCredit && (
            <View style={[styles.creditNotice, { borderColor: Colors.primary + "44", backgroundColor: Colors.primary + "12" }]}>
              <Ionicons name="ellipse" size={18} color="#F59E0B" />
              <View style={{ flex: 1, gap: 6 }}>
                <Text style={[styles.creditNoticeTitle, { color: Colors.primary }]}>
                  1 credit will be deducted by the end of the session
                </Text>
                <Text style={[styles.creditNoticeBody, { color: mutedColor }]}>
                  You have{" "}
                  <Text style={{ fontWeight: "700" }}>{profile?.billCredits ?? 0}</Text> credit
                  {(profile?.billCredits ?? 0) !== 1 ? "s" : ""} remaining.
                </Text>
                <TouchableOpacity onPress={() => router.push("/(app)/paywall")} activeOpacity={0.7}>
                  <Text style={[styles.buyCreditsLink, { color: Colors.primary }]}>
                    Buy more credits →
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          <TouchableOpacity style={styles.joinBtn} onPress={confirmJoin} activeOpacity={0.85}>
            <Text style={styles.joinBtnText}>{preview.isRejoin ? "Rejoin →" : "Join Split →"}</Text>
          </TouchableOpacity>

          <TouchableOpacity style={[styles.cancelBtn, { borderColor }]} onPress={handleCancel}>
            <Text style={[styles.cancelBtnText, { color: mutedColor }]}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return <QRScanner onScan={handleScan} onClose={() => router.back()} />;
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  previewContainer: {
    flex: 1,
    padding: 24,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
  },
  previewTitle: { fontSize: 22, fontWeight: "700", marginBottom: 4 },
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
