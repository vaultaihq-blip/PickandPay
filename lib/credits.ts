import { Platform } from "react-native";
import { router } from "expo-router";
import type { TranslationKey } from "@/constants/translations";
import { showDialog } from "@/lib/dialog";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/store/authStore";

// R3 — with 0 credits (and not pro) nobody starts or enters a NEW session.
// The server enforces it (parse-receipt's ocr_gate, the enforce_session_credit
// trigger: SQLSTATE PP402 / NO_CREDITS); these helpers only decide when the
// app shows the no-credits dialog, always against the balance read fresh from
// the server so someone who just bought credits is not blocked by a stale value.

type T = (key: TranslationKey) => string;

export const NO_CREDITS_SQLSTATE = "PP402";

// Matches a PostgREST error, a WriteError wrapping one (detail = message), or
// a parse-receipt NO_CREDITS answer.
export function isNoCreditsError(err: unknown): boolean {
  const e = err as { code?: string; message?: string; detail?: string } | null;
  return (
    e?.code === NO_CREDITS_SQLSTATE ||
    e?.code === "NO_CREDITS" ||
    e?.message === "NO_CREDITS" ||
    e?.detail === "NO_CREDITS"
  );
}

// Reads bill_credits / is_pro from the server and refreshes the cached profile.
// null when the read fails: callers then let the action go ahead and the
// server decides.
export async function fetchFreshCredits(userId: string): Promise<{ credits: number; isPro: boolean } | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("bill_credits, is_pro")
    .eq("id", userId)
    .single();
  if (error || !data) {
    console.log(`[credits] fresh balance read failed: ${error?.message ?? "no row"}`);
    return null;
  }
  const credits = (data.bill_credits as number | null) ?? 0;
  const isPro = (data.is_pro as boolean | null) ?? false;
  const { profile } = useAuthStore.getState();
  if (profile && profile.id === userId && (profile.billCredits !== credits || profile.isPro !== isPro)) {
    useAuthStore.setState({ profile: { ...profile, billCredits: credits, isPro } });
  }
  return { credits, isPro };
}

// The app opens the credits screen on OK; the web client (no purchases) only
// says to install the app.
export function showNoCreditsDialog(t: T): void {
  if (Platform.OS === "web") {
    showDialog(t("scan_no_credits"), t("credits_install_app_msg"));
    return;
  }
  showDialog(t("scan_no_credits"), t("credits_needed_msg"), [
    { text: t("ok"), onPress: () => router.push("/(app)/pricing") },
  ]);
}

// R1 — shown on the device of someone present at 0 credits when the host's
// finalize was refused for it. The host tries again after the purchase.
export function showFinalizeNoCreditsDialog(t: T): void {
  if (Platform.OS === "web") {
    showDialog(t("scan_no_credits"), `${t("lobby_you_need_credit_msg")}\n\n${t("credits_install_app_msg")}`);
    return;
  }
  showDialog(t("scan_no_credits"), t("lobby_you_need_credit_msg"), [
    { text: t("cancel"), style: "cancel" },
    { text: t("credits_buy_btn"), onPress: () => router.push("/(app)/pricing") },
  ]);
}

// true = go ahead. Shows the dialog and returns false only when the server
// confirms 0 credits and not pro.
export async function ensureCreditsForNewSession(userId: string, t: T): Promise<boolean> {
  const fresh = await fetchFreshCredits(userId);
  if (fresh === null || fresh.isPro || fresh.credits >= 1) return true;
  console.log("[credits] 0 credits — new session blocked (R3)");
  showNoCreditsDialog(t);
  return false;
}

// R3 exception: the sessions this user may scan back into at 0 credits —
// defined on the server (my_returnable_sessions): created in the last 24 h,
// not closed, and still in progress with them in it, or already paid for by
// them before they left. Old sessions left open do not count.
export async function returnableSessionIds(): Promise<string[]> {
  const { data, error } = await supabase.rpc("my_returnable_sessions");
  if (error) {
    console.log(`[credits] returnable-sessions lookup failed: ${error.message}`);
    return [];
  }
  return Array.isArray(data) ? (data as string[]) : [];
}

// true = this user may enter this session now: pro, ≥ 1 credit, or the
// session is one they may return to at 0. Otherwise shows the dialog.
export async function ensureCreditsForSession(userId: string, sessionId: string, t: T): Promise<boolean> {
  const fresh = await fetchFreshCredits(userId);
  if (fresh === null || fresh.isPro || fresh.credits >= 1) return true;
  if ((await returnableSessionIds()).includes(sessionId)) {
    console.log("[credits] 0 credits — returning to a session I am still in (R3 exception)");
    return true;
  }
  console.log("[credits] 0 credits — this session's QR is not one I can return to (R3)");
  showNoCreditsDialog(t);
  return false;
}
