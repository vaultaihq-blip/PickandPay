import { useCallback, useEffect, useRef } from "react";
import { supabase } from "@/lib/supabase";
import { expectRows } from "@/lib/checkedWrite";
import { isOfflineSessionId } from "@/constants/dev";
import { useSessionStore } from "@/store/sessionStore";
import { useAuthStore } from "@/store/authStore";

// R6 — after the host finalizes, a host who drops off hands the role to the
// first person of the split still here, by order of arrival. The server
// decides (transfer_host, one transfer however many devices ask): every device
// on the lobby or the dashboard sends a heartbeat, so the database knows who
// is present. Realtime presence only lives in the app, where the server can't
// check it — the lobby uses a presence leave just to ask sooner.
//
// Every device also takes who is host from the heartbeat answer, so a host who
// comes back reads that someone else has the role (never two hosts).

export const HOST_HEARTBEAT_MS = 3000;
// Mirrors host_away_tolerance_ms() on the server, which is what decides.
export const HOST_AWAY_TOLERANCE_MS = 10_000;

export interface HostChange {
  fromId: string;
  toId: string;
  mine: boolean;
}

interface HostRow {
  result?: string;
  status?: string;
  host_id?: string;
  original_host_id?: string | null;
  host_away_ms?: number | null;
  tolerance_ms?: number;
  from_user_id?: string;
  to_user_id?: string;
}

export function useHostTransfer(sessionId: string | undefined, onHostChanged: (change: HostChange) => void) {
  const onChangeRef = useRef(onHostChanged);
  onChangeRef.current = onHostChanged;
  const beatInFlight = useRef(false);
  const transferInFlight = useRef(false);
  const lastLog = useRef<string | null>(null);
  const logOnce = (key: string, msg: string) => {
    if (lastLog.current === key) return;
    lastLog.current = key;
    console.log(msg);
  };

  // The store follows the server's host_id; a change this device hadn't seen
  // is announced (to the new host, to everyone else, and to a host who comes back).
  const applyHost = useCallback((row: HostRow) => {
    const sess = useSessionStore.getState().currentSession;
    if (!sess || sess.id !== sessionId || !row.host_id) return;
    const originalHostId = row.original_host_id ?? sess.originalHostId;
    if (sess.creatorId === row.host_id && sess.originalHostId === originalHostId) return;
    const fromId = sess.creatorId;
    useSessionStore.getState().setSession({ ...sess, creatorId: row.host_id, originalHostId: originalHostId ?? undefined });
    if (fromId && fromId !== row.host_id) {
      const me = useAuthStore.getState().profile?.id;
      console.log(`[host] host is now ${row.host_id} (this device had ${fromId})`);
      onChangeRef.current({ fromId, toId: row.host_id, mine: row.host_id === me });
    }
  }, [sessionId]);

  const requestTransfer = useCallback(async (expectedHostId: string) => {
    if (!sessionId || transferInFlight.current) return;
    transferInFlight.current = true;
    try {
      const [res] = await expectRows<HostRow>(
        "host: transfer_host",
        supabase.rpc("transfer_host", { p_session_id: sessionId, p_expected_host_id: expectedHostId })
      );
      if (res?.result === "transferred") {
        // Verified: the row the server wrote names the person it chose.
        if (res.host_id !== res.to_user_id) throw new Error(`host_id ${res.host_id} ≠ chosen ${res.to_user_id}`);
        console.log(`[host] transferred from ${res.from_user_id} to ${res.to_user_id}`);
      } else {
        logOnce(`transfer:${res?.result}`, `[host] transfer_host: ${res?.result} (host ${res?.host_id})`);
      }
      if (res) applyHost(res);
    } catch (err) {
      // Background work: no dialog; the next heartbeat asks again.
      console.log(`[host] transfer_host failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      transferInFlight.current = false;
    }
  }, [sessionId, applyHost]); // eslint-disable-line react-hooks/exhaustive-deps

  const beat = useCallback(async () => {
    if (!sessionId || beatInFlight.current) return;
    beatInFlight.current = true;
    try {
      const { data, error } = await supabase.rpc("session_heartbeat", { p_session_id: sessionId });
      if (error) {
        logOnce(`hb-error:${error.code}`, `[host] heartbeat failed: ${error.code ?? "?"}: ${error.message}`);
        return;
      }
      const row = data as HostRow | null;
      if (!row) return;
      logOnce("hb-ok", `[host] heartbeat ok (host ${row.host_id}, status ${row.status})`);
      applyHost(row);
      const me = useAuthStore.getState().profile?.id;
      const tolerance = row.tolerance_ms ?? HOST_AWAY_TOLERANCE_MS;
      if (
        row.status === "awaiting_payment" && row.host_id && row.host_id !== me &&
        row.host_away_ms != null && row.host_away_ms >= tolerance
      ) {
        console.log(`[host] host ${row.host_id} silent for ${row.host_away_ms} ms — asking the server for a new host`);
        await requestTransfer(row.host_id);
      }
    } finally {
      beatInFlight.current = false;
    }
  }, [sessionId, applyHost, requestTransfer]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!sessionId || isOfflineSessionId(sessionId)) return;
    void beat();
    const timer = setInterval(() => void beat(), HOST_HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [sessionId, beat]);

  return { checkHostNow: beat };
}
