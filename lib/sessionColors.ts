import { supabase } from "@/lib/supabase";
import type { SessionParticipant } from "@/types";

// R4 — a person's colour in a session comes from the server
// (session_participants.color, given once when their row is created: the host
// green, the others the first free colour of the palette). No device works a
// colour out on its own, so everyone sees the same one, from the lobby to the
// history.

// Shown while the colours load, and for anyone past the end of the palette
// (the server leaves their colour NULL).
export const NEUTRAL_PARTICIPANT_COLOR = "#6B7280";

export interface ParticipantMeta {
  color: string | null;
  joinedAt: string;
}

export async function fetchParticipantMeta(sessionId: string): Promise<Record<string, ParticipantMeta> | null> {
  const { data, error } = await supabase
    .from("session_participants")
    .select("user_id, color, created_at")
    .eq("session_id", sessionId);
  if (error) {
    console.log(`[colors] session colours read failed (${sessionId}): ${error.message}`);
    return null;
  }
  const byUser: Record<string, ParticipantMeta> = {};
  for (const row of data ?? []) {
    byUser[row.user_id as string] = { color: (row.color as string | null) ?? null, joinedAt: row.created_at as string };
  }
  return byUser;
}

// R4 order: the host first, then this device's own user, then everyone else
// by when their row was created (ties by user id, so it never reshuffles).
export function orderParticipants<T extends Pick<SessionParticipant, "userId" | "joinedAt">>(
  participants: T[],
  hostId: string | undefined,
  myId: string | undefined
): T[] {
  const rank = (p: T) => (p.userId === hostId ? 0 : p.userId === myId ? 1 : 2);
  return [...participants].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    const ja = a.joinedAt ?? "";
    const jb = b.joinedAt ?? "";
    if (ja !== jb) return ja < jb ? -1 : 1;
    return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
  });
}
