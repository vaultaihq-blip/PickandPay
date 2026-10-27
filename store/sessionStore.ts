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

export const useSessionStore = create<SessionState>((set, get) => ({
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
      set({ viewingSession: { ...session, participants }, viewingSplitResults: results });
    } catch {
      set({ viewingSession: session, viewingSplitResults: new Map() });
    }
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
        currentSession: {
          ...session,
          participants: applySessionParticipantColors(session.id, mergedParticipants),
        },
      });
    } else {
      set({
        currentSession: {
          ...session,
          participants: applySessionParticipantColors(session.id, session.participants),
        },
      });
    }
    get().recalculateSplit();
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
    const participants = applySessionParticipantColors(session.id, [
      ...session.participants,
      participant,
    ]);
    set({ currentSession: { ...session, participants } });
    get().recalculateSplit();
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
      const splitResults = calculateSplit(session as Session & { receipt: NonNullable<Session["receipt"]> });
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
}));
