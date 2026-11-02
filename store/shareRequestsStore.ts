import { create } from "zustand";

// R12 — the session's share requests (session_share_requests), kept live by
// useShareRequests in the lobby, read by the lobby and the selection screen.

export interface ShareRequest {
  id: number;
  session_id: string;
  item_id: string;
  unit_no: number;
  from_user: string;
  to_user: string;
  status: "pending" | "accepted" | "rejected" | "cancelled" | "dropped";
  resolved_via: string | null;
  created_at: string;
  resolved_at: string | null;
  reminded_at: string | null;
  dismissed_at: string | null;
}

interface ShareRequestsState {
  sessionId: string | null;
  requests: ShareRequest[];
  /** the "requests for me" sheet */
  sheetOpen: boolean;
  /** the host's / requester's list of pending requests */
  listOpen: boolean;
  setAll: (sessionId: string, rows: ShareRequest[]) => void;
  upsert: (row: ShareRequest) => void;
  setSheetOpen: (open: boolean) => void;
  setListOpen: (open: boolean) => void;
  reset: () => void;
}

export const useShareRequestsStore = create<ShareRequestsState>((set) => ({
  sessionId: null,
  requests: [],
  sheetOpen: false,
  listOpen: false,
  setAll: (sessionId, rows) => set({ sessionId, requests: rows }),
  upsert: (row) =>
    set((s) => {
      if (s.sessionId && row.session_id !== s.sessionId) return s;
      const i = s.requests.findIndex((r) => r.id === row.id);
      if (i < 0) return { requests: [...s.requests, row] };
      const next = s.requests.slice();
      next[i] = row;
      return { requests: next };
    }),
  setSheetOpen: (open) => set({ sheetOpen: open }),
  setListOpen: (open) => set({ listOpen: open }),
  reset: () => set({ sessionId: null, requests: [], sheetOpen: false, listOpen: false }),
}));

export const pendingFor = (rows: ShareRequest[], userId: string | undefined) =>
  rows.filter((r) => r.status === "pending" && r.to_user === userId);
