import { useEffect } from "react";
import { AppState } from "react-native";
import { supabase } from "@/lib/supabase";
import { fetchFreshCredits } from "@/lib/credits";
import { useAuthStore } from "@/store/authStore";

// Scan fixes, point 3 — the balance on screen follows the server: a change to
// the user's own profile row arrives in real time (SQL, the RevenueCat
// webhook, a scan charge or refund), and the balance is read again whenever
// the app comes back to the foreground. Mounted once, in app/_layout.tsx.
export function useLiveCredits() {
  const userId = useAuthStore((s) => s.profile?.id);

  useEffect(() => {
    if (!userId) return;
    void fetchFreshCredits(userId);

    let lastStatus: string | null = null;
    const channel = supabase
      .channel(`profile-credits:${userId}:${Date.now()}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "profiles", filter: `id=eq.${userId}` },
        (payload) => {
          const row = payload.new as { bill_credits?: number | null; is_pro?: boolean | null };
          const profile = useAuthStore.getState().profile;
          if (!profile || profile.id !== userId) return;
          const credits = row.bill_credits ?? profile.billCredits;
          const isPro = row.is_pro ?? profile.isPro;
          if (credits === profile.billCredits && isPro === profile.isPro) return;
          console.log(`[credits] live update: ${profile.billCredits} → ${credits}${isPro !== profile.isPro ? ` (pro ${isPro})` : ""}`);
          useAuthStore.setState({ profile: { ...profile, billCredits: credits, isPro } });
        }
      )
      .subscribe((status) => {
        if (status === lastStatus) return;
        lastStatus = status;
        console.log(`[credits] live balance channel: ${status}`);
      });

    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void fetchFreshCredits(userId);
    });

    return () => {
      sub.remove();
      void supabase.removeChannel(channel);
    };
  }, [userId]);
}
