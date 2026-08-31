import { create } from "zustand";
import { Session as SupabaseSession, User } from "@supabase/supabase-js";
import { UserProfile } from "@/types";
import { supabase, getProfile, upsertProfile } from "@/lib/supabase";
import { getAuthAvatarUrl, getAuthDisplayName } from "@/lib/authProfile";
import { uploadAvatarToStorage } from "@/lib/avatarStorage";
import { getColorForIndex } from "@/constants/colors";

interface AuthState {
  user: User | null;
  profile: UserProfile | null;
  session: SupabaseSession | null;
  isLoading: boolean;
  initialized: boolean;
  isAuthenticated: boolean;

  // Actions
  initialize: () => Promise<void>;
  setSession: (session: SupabaseSession | null) => void;
  setProfile: (profile: UserProfile | null) => void;
  loadProfile: (userId: string) => Promise<void>;
  updatePhone: (phone: string) => Promise<void>;
  signOut: () => Promise<void>;
  deductCredit: () => boolean;
  processReferral: (referrerId: string) => Promise<void>;
  updateAvatar: (avatarUrl?: string, avatarIcon?: string) => Promise<void>;
  isEmailVerified: () => boolean;
}

let _authSubscription: { unsubscribe: () => void } | null = null;

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  profile: null,
  session: null,
  isLoading: true,
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
        const authed = !!session?.user;
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
    const isRemoteAvatarUrl = (url: unknown) =>
      typeof url === "string" && /^https?:\/\//i.test(url);

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
        const storedAvatarUrl = data.avatar_url as string | undefined;
        if (storedAvatarUrl && !isRemoteAvatarUrl(storedAvatarUrl)) {
          try {
            const publicAvatarUrl = await uploadAvatarToStorage(storedAvatarUrl, userId);
            await upsertProfile({
              id: userId,
              name: (data.name as string | undefined) || "User",
              email: data.email as string | undefined,
              phone: data.phone as string | undefined,
              avatar_url: publicAvatarUrl,
              avatar_icon: undefined,
              color: (data.color as string | undefined) ?? getColorForIndex(0),
              provider: mapProvider(data.provider),
            });
            data.avatar_url = publicAvatarUrl;
            data.avatar_icon = undefined;
          } catch (err) {
            console.warn("[AuthStore] Could not migrate local avatar to storage:", err);
          }
        }

        if (!data.avatar_url && !data.avatar_icon) {
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

      // No profile row yet — the server trigger should have created it.
      // Create a fallback without bill_credits (server trigger sets that).
      if ((error as { code?: string } | null)?.code === "PGRST116") {
        if (__DEV__) console.log("[AuthStore] No profile row found, creating default...");
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
          // bill_credits intentionally omitted — server trigger sets initial value
        });
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
    set({ user: null, profile: null, session: null });
  },

  isEmailVerified: () => {
    const user = get().user;
    if (!user) return false;
    const provider = user.app_metadata?.provider as string | undefined;
    // Social logins are always pre-verified by the provider
    if (provider && ["google", "apple", "azure", "facebook", "twitter"].includes(provider)) {
      return true;
    }
    return !!user.email_confirmed_at;
  },

  deductCredit: () => {
    const profile = get().profile;
    if (!profile) return false;
    // Block unverified email accounts from using credits
    if (!get().isEmailVerified()) return false;
    // Optimistic check — server RPC is the authoritative gate
    if (!profile.isPro && profile.billCredits <= 0) return false;
    // Optimistic UI update
    const updated = { ...profile, billCredits: Math.max(0, profile.billCredits - 1) };
    set({ profile: updated });
    // Server-side atomic deduction — if it returns false, revert local state
    supabase.rpc("deduct_credit").then(({ data, error }) => {
      if (error || data === false) {
        // Server rejected — revert optimistic update and reload
        set({ profile });
        get().loadProfile(profile.id);
      }
    });
    return true;
  },

  updateAvatar: async (avatarUrl?: string, avatarIcon?: string) => {
    const profile = get().profile;
    if (!profile) return;
    const updated = { ...profile, avatarUrl, avatarIcon };
    set({ profile: updated });
    const { error } = await upsertProfile({
      id: profile.id,
      name: profile.name,
      email: profile.email,
      phone: profile.phone,
      avatar_url: avatarUrl ?? null,
      avatar_icon: avatarIcon ?? null,
      color: profile.color,
      provider: profile.provider,
    });
    if (error) {
      set({ profile });
      throw error;
    }
  },

  processReferral: async (referrerId: string) => {
    const profile = get().profile;
    if (!profile || profile.referredBy) return;
    try {
      const { error } = await supabase.rpc("process_referral", { referrer_id: referrerId, referred_id: profile.id });
      if (error) throw error;
      // Reload profile so local state reflects the DB (referred_by set, no credit change)
      await get().loadProfile(profile.id);
    } catch (err) {
      console.error("[AuthStore] Failed to process referral:", err);
    }
  },
}));
