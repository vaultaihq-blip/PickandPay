import { create } from "zustand";
import {
  Session,
  SessionParticipant,
  ItemSelection,
  SessionStatus,
  CentAdjustment,
  SplitResult,
  PaymentReminder,
} from "@/types";
import { calculateSplit } from "@/utils/splitter";
import { applySessionParticipantColors } from "@/constants/colors";
import { isOfflineSessionId } from "@/constants/dev";
import { fetchParticipantMeta, NEUTRAL_PARTICIPANT_COLOR, type ParticipantMeta } from "@/lib/sessionColors";

// R4 — colours (and join order) as the server gave them, per session id.
// Participants get them here, whichever screen built the session object.
const metaBySession: Record<string, Record<string, ParticipantMeta>> = {};
const metaInFlight = new Set<string>();
const metaLastFetch: Record<string, number> = {};

function withServerColors(session: Session): Session {
  // Offline/dev sessions never reach the server: keep the local palette.
  if (isOfflineSessionId(session.id)) {
    return { ...session, participants: applySessionParticipantColors(session.id, session.participants) };
  }
  const meta = metaBySession[session.id];
  return {
    ...session,
    participants: session.participants.map((p) => {
      const m = meta?.[p.userId];
      return {
        ...p,
        joinedAt: m?.joinedAt ?? p.joinedAt,
        profile: { ...p.profile, color: m?.color ?? NEUTRAL_PARTICIPANT_COLOR },
      };
    }),
  };
}

function missingMeta(session: Session): boolean {
  if (isOfflineSessionId(session.id)) return false;
  const meta = metaBySession[session.id];
  return !meta || session.participants.some((p) => !meta[p.userId]);
}

interface SessionState {
  currentSession: Session | null;
  splitResults: Map<string, SplitResult>;
  isLoading: boolean;
  error: string | null;
  recentSessions: Session[];
  completedSessions: Session[];
  // Sessão de histórico aberta em modo só-leitura (não sobrescreve currentSession)
  viewingSession: Session | null;
  viewingSplitResults: Map<string, SplitResult>;
  countdownActive: boolean;

  // Actions
  setSession: (session: Session) => void;
  setViewingSession: (session: Session | null) => void;
  setCountdownActive: (active: boolean) => void;
  markViewingPaid: (userId: string, paid: boolean) => void;
  updateParticipant: (userId: string, updates: Partial<SessionParticipant>) => void;
  addParticipant: (participant: SessionParticipant) => void;
  removeParticipant: (userId: string) => void;
  updateSelections: (userId: string, selections: ItemSelection[], tipContribution?: number) => void;
  setStatus: (status: SessionStatus) => void;
  setCentAdjustment: (adjustment: CentAdjustment) => void;
  setSplitUserIds: (userIds: string[]) => void;
  markPaid: (userId: string, paid: boolean) => void;
  markCoveredBy: (userId: string, coveredByUserId: string | null) => void;
  recalculateSplit: () => void;
  setLoading: (isLoading: boolean) => void;
  setError: (error: string | null) => void;
  clearSession: () => void;
  setRecentSessions: (sessions: Session[]) => void;
  addCompletedSession: (session: Session) => void;
  removeCompletedSession: (sessionId: string) => void;
  addReminder: (reminder: PaymentReminder) => void;
}

export const useSessionStore = create<SessionState>((set, get) => {
  // Loads the server's colours for a session the store holds and re-applies
  // them. Throttled: a participant whose row isn't readable yet doesn't make
  // every store update refetch.
  const ensureServerColors = (session: Session) => {
    const id = session.id;
    if (!missingMeta(session) || metaInFlight.has(id)) return;
    if (Date.now() - (metaLastFetch[id] ?? 0) < 2000) return;
    metaInFlight.add(id);
    metaLastFetch[id] = Date.now();
    void fetchParticipantMeta(id).then((meta) => {
      metaInFlight.delete(id);
      if (!meta) return;
      metaBySession[id] = meta;
      console.log(`[colors] session ${id}: ${Object.keys(meta).length} colour(s) from the server`);
      const cur = get().currentSession;
      if (cur?.id === id) set({ currentSession: withServerColors(cur) });
      const viewing = get().viewingSession;
      if (viewing?.id === id) set({ viewingSession: withServerColors(viewing) });
    });
  };

  return {
  currentSession: null,
  splitResults: new Map(),
  isLoading: false,
  error: null,
  recentSessions: [],
  completedSessions: [],
  viewingSession: null,
  viewingSplitResults: new Map(),
  countdownActive: false,

  setCountdownActive: (active) => set({ countdownActive: active }),

  markViewingPaid: (userId, paid) => {
    const viewing = get().viewingSession;
    if (!viewing) return;
    const participants = viewing.participants.map((p) =>
      p.userId === userId ? { ...p, paid } : p
    );
    const updated = { ...viewing, participants };
    set({
      viewingSession: updated,
      completedSessions: get().completedSessions.map((s) =>
        s.id === viewing.id ? { ...s, participants } : s
      ),
    });
  },

  setViewingSession: (session) => {
    if (!session) {
      set({ viewingSession: null, viewingSplitResults: new Map() });
      return;
    }
    try {
      const results = calculateSplit(session as Session & { receipt: NonNullable<Session["receipt"]> });
      const participants = session.participants.map((p) => ({
        ...p,
        totalOwed: results.get(p.userId)?.amount ?? 0,
      }));
      set({ viewingSession: withServerColors({ ...session, participants }), viewingSplitResults: results });
    } catch {
      set({ viewingSession: withServerColors(session), viewingSplitResults: new Map() });
    }
    ensureServerColors(session);
  },

  setSession: (session) => {
    const existing = get().currentSession;
    // If re-setting the same session (e.g. user goes back to review and confirms again),
    // preserve participant selections so they aren't wiped.
    if (existing?.id === session.id && existing.participants.length > 0) {
      const mergedParticipants = session.participants.map((p) => {
        const ep = existing.participants.find((e) => e.userId === p.userId);
        return ep
          ? { ...p, selections: ep.selections, tipContribution: ep.tipContribution }
          : p;
      });
      set({
        currentSession: withServerColors({
          ...session,
          splitUserIds: session.splitUserIds ?? existing.splitUserIds,
          participants: mergedParticipants,
        }),
      });
    } else {
      set({ currentSession: withServerColors(session) });
    }
    get().recalculateSplit();
    ensureServerColors(session);
  },

  updateParticipant: (userId, updates) => {
    const session = get().currentSession;
    if (!session) return;
    const participants = session.participants.map((p) =>
      p.userId === userId ? { ...p, ...updates } : p
    );
    set({ currentSession: { ...session, participants } });
    get().recalculateSplit();
  },

  addParticipant: (participant) => {
    const session = get().currentSession;
    if (!session) return;
    const existing = session.participants.find(
      (p) => p.userId === participant.userId
    );
    if (existing) return;
    const updated = withServerColors({ ...session, participants: [...session.participants, participant] });
    set({ currentSession: updated });
    get().recalculateSplit();
    ensureServerColors(updated);
  },

  removeParticipant: (userId) => {
    const session = get().currentSession;
    if (!session) return;
    const participants = session.participants.filter((p) => p.userId !== userId);
    set({ currentSession: { ...session, participants } });
    get().recalculateSplit();
  },

  updateSelections: (userId, selections, tipContribution) => {
    const session = get().currentSession;
    if (!session) return;
    const participants = session.participants.map((p) =>
      p.userId === userId
        ? { ...p, selections, ...(tipContribution !== undefined && { tipContribution }) }
        : p
    );
    set({ currentSession: { ...session, participants } });
    get().recalculateSplit();
  },

  setStatus: (status) => {
    const session = get().currentSession;
    if (!session) return;
    const updated = { ...session, status };
    set({ currentSession: updated });
    if (status === "closed") {
      const existing = get().completedSessions;
      if (!existing.some((s) => s.id === session.id)) {
        set({ completedSessions: [updated, ...existing].slice(0, 20) });
      }
    }
  },

  setCentAdjustment: (centAdjustment) => {
    const session = get().currentSession;
    if (!session) return;
    set({ currentSession: { ...session, centAdjustment } });
    // The adjustment changes the assigned person's share (calculateSplit).
    get().recalculateSplit();
  },

  setSplitUserIds: (splitUserIds) => {
    const session = get().currentSession;
    if (!session) return;
    set({ currentSession: { ...session, splitUserIds } });
    get().recalculateSplit();
  },

  markPaid: (userId, paid) => {
    const session = get().currentSession;
    if (!session) return;
    const participants = session.participants.map((p) =>
      p.userId === userId ? { ...p, paid } : p
    );
    set({ currentSession: { ...session, participants } });
  },

  markCoveredBy: (userId, coveredByUserId) => {
    const session = get().currentSession;
    if (!session) return;
    const participants = session.participants.map((p) =>
      p.userId === userId ? { ...p, coveredByUserId: coveredByUserId ?? undefined } : p
    );
    set({ currentSession: { ...session, participants } });
  },

  recalculateSplit: () => {
    const session = get().currentSession;
    if (!session || !session.receipt || session.participants.length === 0) {
      set({ splitResults: new Map() });
      return;
    }
    try {
      // Once the server froze who is in the split (R1), divide between exactly
      // those people on every device, whoever else this store still lists.
      const frozen = session.splitUserIds ? new Set(session.splitUserIds) : null;
      const splitSession = frozen
        ? { ...session, participants: session.participants.filter((p) => frozen.has(p.userId)) }
        : session;
      const splitResults = calculateSplit(splitSession as Session & { receipt: NonNullable<Session["receipt"]> });
      // Update totalOwed on each participant
      const participants = session.participants.map((p) => ({
        ...p,
        totalOwed: splitResults.get(p.userId)?.amount ?? 0,
      }));
      set({
        splitResults,
        currentSession: { ...session, participants },
      });
    } catch (err) {
      console.error("[SessionStore] Split calculation failed:", err);
    }
  },

  setLoading: (isLoading) => set({ isLoading }),

  setError: (error) => set({ error }),

  clearSession: () =>
    set({
      currentSession: null,
      splitResults: new Map(),
      isLoading: false,
      error: null,
    }),

  setRecentSessions: (recentSessions) => set({ recentSessions }),

  addCompletedSession: (session) => {
    const existing = get().completedSessions;
    if (!existing.some((s) => s.id === session.id)) {
      set({ completedSessions: [session, ...existing].slice(0, 20) });
    }
  },

  removeCompletedSession: (sessionId) => {
    set({
      completedSessions: get().completedSessions.filter((s) => s.id !== sessionId),
    });
  },

  addReminder: (reminder) => {
    const session = get().currentSession;
    if (!session) return;
    const reminders = [...(session.reminders ?? []), reminder];
    const updated = { ...session, reminders };
    set({ currentSession: updated });
    set({
      completedSessions: get().completedSessions.map((s) =>
        s.id === session.id ? { ...s, reminders } : s
      ),
    });
  },
  };
});
