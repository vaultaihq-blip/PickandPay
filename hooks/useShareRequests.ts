import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import { supabase } from "@/lib/supabase";
import { showDialog } from "@/lib/dialog";
import { selectionAmount } from "@/lib/units";
import { formatCurrency } from "@/utils/formatter";
import { useSessionStore } from "@/store/sessionStore";
import { ShareRequest, useShareRequestsStore } from "@/store/shareRequestsStore";
import type { TranslationKey } from "@/constants/translations";
import type { ItemSelection, ReceiptItem, Session } from "@/types";

type T = (key: TranslationKey) => string;

export function receiptLines(session: Session | null | undefined): ReceiptItem[] {
  const c = session?.receipt?.categories;
  return c ? [...c.starters, ...c.mains, ...c.drinks, ...c.desserts, ...c.others] : [];
}

const nameOf = (session: Session | null | undefined, userId: string, fallback: string) =>
  session?.participants.find((p) => p.userId === userId)?.profile.name ?? fallback;

/**
 * R12 — keeps the session's share requests live (fetch + realtime + a reread
 * when the app comes back), opens "requests for me" when one arrives or the
 * host reminds, and tells a requester when a request was rejected.
 * Mounted once, in the lobby (it stays mounted under the selection screen).
 */
export function useShareRequests(sessionId: string | undefined, myId: string | undefined, t: T) {
  const seenRef = useRef<Map<number, string>>(new Map());

  useEffect(() => {
    if (!sessionId || !myId || sessionId.startsWith("session_") || sessionId.startsWith("dev_session_")) return;
    const store = useShareRequestsStore.getState();
    if (store.sessionId !== sessionId) store.reset();
    seenRef.current = new Map();

    const react = (row: ShareRequest, live: boolean) => {
      const stamp = `${row.status}|${row.reminded_at ?? ""}`;
      const before = seenRef.current.get(row.id);
      seenRef.current.set(row.id, stamp);
      if (!live || before === stamp) return;
      const session = useSessionStore.getState().currentSession;
      const item = receiptLines(session).find((i) => i.id === row.item_id)?.name ?? "";
      if (row.status === "pending" && row.to_user === myId) {
        console.log(`[share-requests] ${before ? "reminded" : "new"} request ${row.id} for me (${item})`);
        useShareRequestsStore.getState().setSheetOpen(true);
      }
      if (row.status === "rejected" && row.from_user === myId && !row.dismissed_at && !before?.startsWith("rejected")) {
        console.log(`[share-requests] request ${row.id} rejected (${item})`);
        showDialog(
          t("share_rejected_title"),
          t("share_rejected_msg").replace("{name}", nameOf(session, row.to_user, "?")).replace("{item}", item)
        );
      }
    };

    const fetchAll = async () => {
      const { data, error } = await supabase.from("session_share_requests").select("*").eq("session_id", sessionId);
      if (error) {
        console.log(`[share-requests] read failed: ${error.code ?? "?"}: ${error.message}`);
        return;
      }
      const rows = (data ?? []) as ShareRequest[];
      const first = seenRef.current.size === 0;
      useShareRequestsStore.getState().setAll(sessionId, rows);
      for (const r of rows) react(r, !first);
      console.log(`[share-requests] read: ${rows.filter((r) => r.status === "pending").length} pending`);
    };
    void fetchAll();

    const ch = supabase
      .channel(`share-requests:${sessionId}:${Date.now()}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "session_share_requests", filter: `session_id=eq.${sessionId}` },
        (payload) => {
          const row = payload.new as ShareRequest | undefined;
          if (!row?.id) return;
          useShareRequestsStore.getState().upsert(row);
          react(row, true);
        })
      .subscribe((status, err) => {
        if (status !== "SUBSCRIBED") console.log(`[share-requests] realtime: ${status}${err ? ` (${err.message})` : ""}`);
      });
    const appSub = AppState.addEventListener("change", (s) => {
      if (s === "active") void fetchAll();
    });
    return () => {
      appSub.remove();
      supabase.removeChannel(ch);
    };
  }, [sessionId, myId]); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * R12 — someone stopped sharing a unit with me: I now pay all of it. No
 * question for them, a notice for me: "<nome> deixou de partilhar o <item>.
 * Agora pagas X em vez de Y."
 */
export function useShareNotices(myId: string | undefined, t: T) {
  useEffect(() => {
    if (!myId) return;
    return useSessionStore.subscribe((state, prev) => {
      const now = state.currentSession;
      const before = prev.currentSession;
      if (!now?.receipt || !before || now.id !== before.id) return;
      const mineNow = now.participants.find((p) => p.userId === myId)?.selections ?? [];
      const mineBefore = before.participants.find((p) => p.userId === myId)?.selections ?? [];
      if (mineNow === mineBefore) return;
      const lines = receiptLines(now);
      for (const sel of mineNow) {
        const old = mineBefore.find((s) => s.itemId === sel.itemId);
        if (!old?.unitSplits || !sel.unitSplits) continue;
        const gone = (old.sharedWith ?? []).filter((u) => u !== myId && !(sel.sharedWith ?? []).includes(u));
        const item = lines.find((i) => i.id === sel.itemId);
        if (!item || gone.length === 0) continue;
        const was = selectionAmount(item, old as ItemSelection);
        const is = selectionAmount(item, sel);
        if (is <= was + 0.004) continue;
        const curr = now.receipt.currency;
        const names = gone.map((u) => nameOf(now, u, "?")).join(", ");
        console.log(`[share-requests] ${names} stopped sharing ${item.name}: ${was.toFixed(2)} → ${is.toFixed(2)}`);
        showDialog(
          t("share_stopped_title"),
          t("share_stopped_msg")
            .replace("{name}", names)
            .replace("{item}", item.name)
            .replace("{now}", formatCurrency(is, curr))
            .replace("{was}", formatCurrency(was, curr))
        );
      }
    });
  }, [myId, t]);
}
