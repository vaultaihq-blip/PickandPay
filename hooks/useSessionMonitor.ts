import { useEffect } from "react";
import { AppState } from "react-native";
import { router } from "expo-router";
import { supabase } from "@/lib/supabase";
import { checkSessionGone } from "@/lib/sessionGone";
import { isOfflineSessionId } from "@/constants/dev";
import { useSessionStore } from "@/store/sessionStore";
import { useI18nStore } from "@/store/i18nStore";

// D.7 — watches the session this screen is about. When it has ended (host,
// expiry, clean-up) or does not exist, the app goes straight home and says
// why, with OK only (lib/sessionGone.ts). Checked on the realtime close, when
// the screen opens, and every time the app comes back to the foreground —
// a phone in the background misses the realtime event, and Android may even
// restart the app on this screen with nothing in memory (02-11-2026, test 1).
export function useSessionMonitor(routeSessionId?: string) {
  const currentSession = useSessionStore((s) => s.currentSession);
  const storeId = currentSession?.id;
  const sid = storeId ?? routeSessionId;

  useEffect(() => {
    if (!sid || isOfflineSessionId(sid)) return;
    const t = useI18nStore.getState().t;
    let alive = true;

    const check = async (why: string) => {
      const state = await checkSessionGone(`monitor (${why})`, sid, t);
      // Open, but this phone has nothing of it in memory (app restarted on
      // this screen): home, where the rejoin notice offers it again.
      if (alive && state === "open" && !useSessionStore.getState().currentSession) {
        console.log(`[session-gone] monitor (${why}): ${sid} is open but not in memory — home, to rejoin from there`);
        router.replace("/(app)");
      }
    };

    void check("screen open");
    const appSub = AppState.addEventListener("change", (s) => {
      if (s === "active") void check("foreground");
    });
    const ch = supabase
      .channel(`monitor:${sid}:${Date.now()}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "sessions", filter: `id=eq.${sid}` },
        (payload) => {
          if ((payload.new?.status as string | undefined) === "closed") void check("realtime close");
        }
      )
      .subscribe();

    return () => {
      alive = false;
      appSub.remove();
      supabase.removeChannel(ch);
    };
  }, [sid]);
}
