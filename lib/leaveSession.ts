import { supabase } from "@/lib/supabase";
import { withTimeout } from "@/lib/checkedWrite";

// A1 — a participant leaves only through the server (leave_session): the Sair
// button is the one thing that marks someone "left". Closing the app, losing
// the network or going to the background is "disconnected" and writes
// nothing. The server refuses any other write of "left" (LEAVE_VIA_RPC) and
// records every status change. The host uses leave_as_host or endSession.
// Resolves once the server says this user is out of the session (or the
// session already ended); throws otherwise, so callers leave only after that.
const OUT = new Set(["left", "already_left", "closed", "not_in_session"]);

export async function leaveSession(label: string, sessionId: string): Promise<void> {
  console.log(`[leave-session] ${label}: leaving ${sessionId}`);
  const { data, error } = await withTimeout(
    label,
    supabase.rpc("leave_session", { p_session_id: sessionId })
  );
  if (error) {
    console.log(`[leave-session] ${label}: refused — ${error.code ?? "?"}: ${error.message}`);
    throw error;
  }
  const row = (data ?? null) as { result?: string; previous?: string } | null;
  if (!row?.result || !OUT.has(row.result)) {
    throw new Error(`leave_session answered ${row?.result ?? "nothing"}`);
  }
  console.log(`[leave-session] ${label}: ${row.result}${row.previous ? ` (was ${row.previous})` : ""}`);
}
