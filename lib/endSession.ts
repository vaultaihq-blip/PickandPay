import { supabase } from "@/lib/supabase";
import { showDialog } from "@/lib/dialog";
import { withTimeout, writeErrorMessage } from "@/lib/checkedWrite";
import type { TranslationKey } from "@/constants/translations";

// D.5 — the host ends a session through the server (end_session, D.1): only
// the current host may, every close is recorded in session_closures, and the
// saved status comes back. Resolves only once the server says "closed";
// throws otherwise, so callers clear local state and leave only after that.
export async function endSession(label: string, sessionId: string): Promise<void> {
  console.log(`[end-session] ${label}: ending ${sessionId}`);
  const { data, error } = await withTimeout(
    label,
    supabase.rpc("end_session", { p_session_id: sessionId })
  );
  if (error) {
    console.log(`[end-session] ${label}: refused — ${error.code ?? "?"}: ${error.message}`);
    throw error;
  }
  const row = (data ?? null) as { result?: string; status?: string } | null;
  if (row?.status !== "closed") {
    throw new Error(`session ${sessionId} is ${row?.status ?? "unknown"}, not closed`);
  }
  console.log(`[end-session] ${label}: ${sessionId} ${row.result} (verified)`);
}

// The session is still open on the server: say so, and stay where we are.
// The dialog stays until it is closed.
export function showEndSessionError(err: unknown, t: (key: TranslationKey) => string): void {
  showDialog(t("error"), `${t("lobby_end_failed")}\n\n${writeErrorMessage(err, t)}`);
}
