import { useEffect } from "react";
import { showDialog } from "@/lib/dialog";
import { router } from "expo-router";
import { supabase } from "@/lib/supabase";
import { useSessionStore } from "@/store/sessionStore";
import { useAuthStore } from "@/store/authStore";

// Globally monitors the active session for unexpected closure by the host.
// Participants are force-navigated home with a non-dismissible alert.
export function useSessionMonitor() {
  const currentSession = useSessionStore((s) => s.currentSession);
  const clearSession = useSessionStore((s) => s.clearSession);
  const profile = useAuthStore((s) => s.profile);

  useEffect(() => {
    const sid = currentSession?.id;
    if (!sid || sid.startsWith("session_") || sid.startsWith("dev_session_")) return;
    const isCreator = currentSession?.creatorId === profile?.id;
    // Host is the one closing — no need to watch for closure
    if (isCreator) return;

    const ch = supabase
      .channel(`monitor:${sid}:${Date.now()}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "sessions",
          filter: `id=eq.${sid}`,
        },
        (payload) => {
          const newStatus = payload.new?.status as string | undefined;
          if (newStatus === "closed") {
            clearSession();
            router.replace("/(app)");
            showDialog(
              "Session Ended",
              "The host has closed this session.",
              [{ text: "OK" }],
              { cancelable: false }
            );
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(ch);
    };
  }, [currentSession?.id, currentSession?.creatorId, profile?.id]); // eslint-disable-line react-hooks/exhaustive-deps
}
