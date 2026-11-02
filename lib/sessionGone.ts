import { router } from "expo-router";
import type { TranslationKey } from "@/constants/translations";
import { showDialog } from "@/lib/dialog";
import { supabase } from "@/lib/supabase";
import { withTimeout } from "@/lib/checkedWrite";
import { isOfflineSessionId } from "@/constants/dev";
import { useSessionStore } from "@/store/sessionStore";

// D.7 (owner, 02-11-2026) — a session that has ended, or does not exist,
// never leaves a screen without a way out: the app goes straight home and
// says why, with OK only. The reason comes from join_preview's
// 'closed_reason' (session_closures is server only).
export type SessionState = "open" | "closed_host" | "closed_inactive" | "closed" | "not_found";

// Throws on a failed or late read (10 s): the caller decides what to show.
export async function readSessionState(label: string, sessionId: string): Promise<SessionState> {
  const { data, error } = await withTimeout(
    `${label}: session state`,
    supabase.rpc("join_preview", { p_session_id: sessionId })
  );
  if (error) {
    if (error.code === "22P02") return "not_found"; // not a session id at all
    throw error;
  }
  const p = (data ?? null) as { result?: string; closed_reason?: string } | null;
  if (!p || p.result === "not_found") return "not_found";
  if (p.result !== "closed") return "open";
  if (p.closed_reason === "host") return "closed_host";
  if (p.closed_reason === "inactive") return "closed_inactive";
  return "closed";
}

// Sessions this phone ended itself (end_session): coming back to them is not
// a surprise, so no notice.
const endedHere = new Set<string>();
export function markEndedHere(sessionId: string): void {
  endedHere.add(sessionId);
}

// One notice per session, however many screens notice it at once (the
// monitor, the 2 s status read and the screen itself may all see it).
const NOTICE_WINDOW_MS = 5000;
const noticeShownAt = new Map<string, number>();

export function leaveGoneSession(
  label: string,
  sessionId: string,
  state: Exclude<SessionState, "open">,
  t: (key: TranslationKey) => string
): void {
  const last = noticeShownAt.get(sessionId);
  if (last && Date.now() - last < NOTICE_WINDOW_MS) return;
  noticeShownAt.set(sessionId, Date.now());
  console.log(`[session-gone] ${label}: ${sessionId} is ${state} — going home`);
  const store = useSessionStore.getState();
  if (!store.currentSession || store.currentSession.id === sessionId) store.clearSession();
  router.replace("/(app)");
  if (endedHere.has(sessionId)) return;
  const message =
    state === "not_found" ? t("session_gone_not_found_msg")
    : state === "closed_host" ? t("session_gone_host_msg")
    : state === "closed_inactive" ? t("session_gone_inactive_msg")
    : t("join_closed_msg");
  showDialog(
    state === "not_found" ? t("join_not_found_title") : t("join_closed_title"),
    message,
    [{ text: t("ok") }],
    { cancelable: false }
  );
}

// Asks the server and, if the session is gone, leaves it. Returns the state,
// or null if the server could not be asked (no notice then: nothing is known).
export async function checkSessionGone(
  label: string,
  sessionId: string,
  t: (key: TranslationKey) => string
): Promise<SessionState | null> {
  if (isOfflineSessionId(sessionId)) return "open";
  try {
    const state = await readSessionState(label, sessionId);
    if (state !== "open") leaveGoneSession(label, sessionId, state, t);
    return state;
  } catch (err) {
    console.log(`[session-gone] ${label}: could not ask the server — ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
