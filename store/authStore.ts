import { create } from "zustand";
import { Session as SupabaseSession, User } from "@supabase/supabase-js";
import { UserProfile } from "@/types";
import { supabase, getProfile, upsertProfile } from "@/lib/supabase";
import { getAuthAvatarUrl, getAuthDisplayName } from "@/lib/authProfile";
import { getColorForIndex } from "@/constants/colors";

interface AuthState {
  user: User | null;
  profile: UserProfile | null;
  session: SupabaseSession | null;
  isLoading: boolean;
  isGuest: boolean;
  initialized: boolean;
  isAuthenticated: boolean;

  // Actions
  initialize: () => Promise<void>;
  setSession: (session: SupabaseSession | null) => void;
  setProfile: (profile: UserProfile | null) => void;
  loadProfile: (userId: string) => Promise<void>;
  updatePhone: (phone: string) => Promise<void>;
  signOut: () => Promise<void>;
  setGuest: (isGuest: boolean) => void;
  deductCredit: () => boolean;
  addCredits: (amount: number) => void;
  processReferral: (referrerId: string) => Promise<void>;
  updateAvatar: (avatarUrl?: string, avatarIcon?: string) => Promise<void>;
}

let _authSubscription: { unsubscribe: () => void } | null = null;

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  profile: null,
  session: null,
  isLoading: true,
  isGuest: false,
  initialized: false,
  isAuthenticated: false,

  initialize: async () => {
    set({ isLoading: true });
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (session?.user) {
        await get().loadProfile(session.user.id);
        set({ session, user: session.user, isAuthenticated: true });
      }

      // Listen for auth state changes
      if (_authSubscription) _authSubscription.unsubscribe();
      const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
        const authed = !!session?.user || get().isGuest;
        set({ session, user: session?.user ?? null, isAuthenticated: authed });
        setTimeout(() => {
          if (session?.user) {
            get().loadProfile(session.user.id);
          } else {
            set({ profile: null });
          }
        }, 0);
      });
      _authSubscription = subscription;
    } finally {
      set({ isLoading: false, initialized: true });
    }
  },

  setSession: (session) => {
    set({ session, user: session?.user ?? null });
  },

  setProfile: (profile) => {
    set({ profile });
  },

  loadProfile: async (userId: string) => {
    const mapProvider = (provider: unknown): UserProfile["provider"] => {
      if (provider === "azure") return "microsoft";
      if (
        provider === "google" ||
        provider === "apple" ||
        provider === "email" ||
        provider === "microsoft" ||
        provider === "facebook"
      ) {
        return provider;
      }
      return undefined;
    };

    const mapRow = (data: Record<string, unknown>) => ({
      id: data.id as string,
      name: data.name as string,
      email: data.email as string | undefined,
      phone: (data.phone as string | undefined) ?? undefined,
      avatarUrl: data.avatar_url as string | undefined,
      avatarIcon: data.avatar_icon as string | undefined,
      color: (data.color as string | undefined) ?? getColorForIndex(0),
      provider: mapProvider(data.provider),
      billCredits: (data.bill_credits as number | undefined) ?? 0,
      referredBy: (data.referred_by as string | undefined) ?? undefined,
      referralCount: (data.referral_count as number | undefined) ?? 0,
      isPro: (data.is_pro as boolean | undefined) ?? false,
      proExpiresAt: (data.pro_expires_at as string | undefined) ?? undefined,
    });

    try {
      const { data, error } = await getProfile(userId);
      if (!error && data) {
        if (!data.avatar_url) {
          const { data: { user } } = await supabase.auth.getUser();
          const authAvatarUrl = user ? getAuthAvatarUrl(user) : undefined;
          const authName = user ? getAuthDisplayName(user) : undefined;
          if (authAvatarUrl || (!data.name && authName)) {
            await upsertProfile({
              id: userId,
              name: data.name || authName || "User",
              email: (data.email as string | undefined) ?? user?.email,
              phone: data.phone as string | undefined,
              avatar_url: authAvatarUrl,
              avatar_icon: (data.avatar_icon as string | undefined) ?? undefined,
              color: (data.color as string | undefined) ?? getColorForIndex(0),
              provider: mapProvider(data.provider),
            });
            data.avatar_url = authAvatarUrl;
            if (!data.name && authName) data.name = authName;
          }
        }
        set({ profile: mapRow(data) });
        return;
      }

      // No profile row yet — create a minimal default so the app isn't stuck
      if ((error as { code?: string } | null)?.code === "PGRST116") {
        console.log("[AuthStore] No profile row found, creating default...");
        const { data: { user } } = await supabase.auth.getUser();
        const defaultName = user ? getAuthDisplayName(user) : "User";
        const avatarUrl = user ? getAuthAvatarUrl(user) : undefined;
        await upsertProfile({
          id: userId,
          email: user?.email ?? "",
          name: defaultName,
          avatar_url: avatarUrl,
          avatar_icon: avatarUrl ? undefined : "person",
          color: getColorForIndex(0),
          bill_credits: 3,
        } as any);
        const { data: created } = await getProfile(userId);
        if (created) set({ profile: mapRow(created) });
      }
    } catch (err) {
      console.error("[AuthStore] Failed to load profile:", err);
    }
  },

  updatePhone: async (phone: string) => {
    const profile = get().profile;
    if (!profile) return;
    const updated = { ...profile, phone: phone || undefined };
    set({ profile: updated });
    try {
      await upsertProfile({
        id: profile.id,
        name: profile.name,
        email: profile.email,
        phone: phone || undefined,
        avatar_url: profile.avatarUrl,
        avatar_icon: profile.avatarIcon,
        color: profile.color,
        provider: profile.provider,
      });
    } catch (err) {
      console.error("[AuthStore] Failed to save phone:", err);
    }
  },

  signOut: async () => {
    await supabase.auth.signOut();
    set({ user: null, profile: null, session: null, isGuest: false });
  },

  setGuest: (isGuest: boolean) => {
    set({ isGuest, isAuthenticated: isGuest });
    if (isGuest) {
      set({
        profile: {
          id: `guest_${Date.now()}`,
          name: "Guest",
          avatarIcon: "rocket",
          color: getColorForIndex(0),
          billCredits: 3,
          referralCount: 0,
          isPro: false,
        },
      });
    }
  },

  deductCredit: () => {
    const profile = get().profile;
    if (!profile) return false;
    if (profile.isPro) return true;
    if (profile.billCredits <= 0) return false;
    const updated = { ...profile, billCredits: profile.billCredits - 1 };
    set({ profile: updated });
    // Persist to Supabase (fire and forget)
    if (!get().isGuest) {
      upsertProfile({
        id: profile.id,
        name: profile.name,
        email: profile.email,
        phone: profile.phone,
        avatar_url: profile.avatarUrl,
        avatar_icon: profile.avatarIcon,
        color: profile.color,
        provider: profile.provider,
        bill_credits: updated.billCredits,
      } as any).catch(() => {});
    }
    return true;
  },

  addCredits: (amount: number) => {
    const profile = get().profile;
    if (!profile) return;
    const updated = { ...profile, billCredits: profile.billCredits + amount };
    set({ profile: updated });
    if (!get().isGuest) {
      upsertProfile({
        id: profile.id,
        name: profile.name,
        email: profile.email,
        phone: profile.phone,
        avatar_url: profile.avatarUrl,
        avatar_icon: profile.avatarIcon,
        color: profile.color,
        provider: profile.provider,
        bill_credits: updated.billCredits,
      } as any).catch(() => {});
    }
  },

  updateAvatar: async (avatarUrl?: string, avatarIcon?: string) => {
    const profile = get().profile;
    if (!profile) return;
    const updated = { ...profile, avatarUrl, avatarIcon };
    set({ profile: updated });
    if (!get().isGuest) {
      upsertProfile({
        id: profile.id,
        name: profile.name,
        email: profile.email,
        phone: profile.phone,
        avatar_url: avatarUrl,
        avatar_icon: avatarIcon,
        color: profile.color,
        provider: profile.provider,
      }).catch(() => {});
    }
  },

  processReferral: async (referrerId: string) => {
    const profile = get().profile;
    if (!profile || profile.referredBy || get().isGuest) return;
    // Mark this user as referred
    set({ profile: { ...profile, referredBy: referrerId, billCredits: profile.billCredits + 1 } });
    try {
      await upsertProfile({
        id: profile.id,
        name: profile.name,
        email: profile.email,
        phone: profile.phone,
        avatar_url: profile.avatarUrl,
        avatar_icon: profile.avatarIcon,
        color: profile.color,
        provider: profile.provider,
        referred_by: referrerId,
        bill_credits: profile.billCredits + 1,
      } as any);
    } catch (err) {
      console.error("[AuthStore] Failed to process referral:", err);
    }
  },
}));
