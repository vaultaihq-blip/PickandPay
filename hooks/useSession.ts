import { useEffect, useCallback, useRef } from "react";
import { useSessionStore } from "@/store/sessionStore";
import { supabase } from "@/lib/supabase";
import { Session, SessionParticipant } from "@/types";
import { useAuthStore } from "@/store/authStore";
import { getColorForIndex } from "@/constants/colors";

export function useSession(sessionId?: string) {
  const {
    currentSession,
    splitResults,
    isLoading,
    error,
    setSession,
    setLoading,
    setError,
    addParticipant,
    updateParticipant,
    markPaid,
    setStatus,
    clearSession,
  } = useSessionStore();

  const { profile } = useAuthStore();
  const subscriptionRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  // Load session from Supabase
  const loadSession = useCallback(
    async (id: string) => {
      setLoading(true);
      setError(null);
      try {
        const { data, error } = await supabase
          .from("sessions")
          .select(`*, session_participants(*)`)
          .eq("id", id)
          .single();

        if (error) throw error;
        if (data) {
          const session: Session = {
            id: data.id,
            creatorId: data.host_id,
            receiptId: data.id,
            receipt: data.receipt_data,
            status: data.status,
            createdAt: data.created_at,
            closedAt: data.closed_at,
            participants: (data.session_participants ?? []).map(
              (sp: Record<string, unknown>, idx: number) => ({
                userId: sp.user_id as string,
                profile: {
                  id: sp.user_id as string,
                  name: "Participant",
                  color: getColorForIndex(idx),
                  avatarIcon: "star",
                },
                selections: (sp.selections as SessionParticipant["selections"]) ?? [],
                totalOwed: (sp.total_owed as number) ?? 0,
                paid: (sp.paid as boolean) ?? false,
                confirmedByCreator: (sp.confirmed_by_creator as boolean) ?? false,
              })
            ),
          };
          setSession(session);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load session");
      } finally {
        setLoading(false);
      }
    },
    [setLoading, setError, setSession]
  );

  // Subscribe to realtime updates
  const subscribeToSession = useCallback(
    (id: string) => {
      subscriptionRef.current = supabase
        .channel(`session:${id}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "sessions",
            filter: `id=eq.${id}`,
          },
          (payload) => {
            if (payload.new && "status" in payload.new) {
              setStatus(payload.new.status as Session["status"]);
            }
          }
        )
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "session_participants",
            filter: `session_id=eq.${id}`,
          },
          () => {
            // Reload session on participant changes
            loadSession(id);
          }
        )
        .subscribe();
    },
    [loadSession, setStatus]
  );

  useEffect(() => {
    if (sessionId) {
      loadSession(sessionId);
      subscribeToSession(sessionId);
    }

    return () => {
      if (subscriptionRef.current) {
        subscriptionRef.current.unsubscribe();
        subscriptionRef.current = null;
      }
    };
  }, [sessionId, loadSession, subscribeToSession]);

  const joinSession = useCallback(async () => {
    if (!currentSession || !profile) return;

    try {
      await supabase.from("session_participants").upsert({
        session_id: currentSession.id,
        user_id: profile.id,
        total_owed: 0,
        paid: false,
        confirmed_by_creator: false,
      });

      addParticipant({
        userId: profile.id,
        profile,
        selections: [],
        totalOwed: 0,
        paid: false,
        confirmedByCreator: false,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to join session");
    }
  }, [currentSession, profile, addParticipant, setError]);

  return {
    session: currentSession,
    splitResults,
    isLoading,
    error,
    loadSession,
    joinSession,
    markPaid,
    setStatus,
    clearSession,
  };
}
