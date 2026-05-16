import { Platform } from "react-native";
import * as WebBrowser from "expo-web-browser";
import * as Linking from "expo-linking";
import { AuthError, Provider, Session, createClient } from "@supabase/supabase-js";
import AsyncStorage from "@react-native-async-storage/async-storage";

WebBrowser.maybeCompleteAuthSession();

// URL polyfill is only needed on native — browsers already have URL natively,
// and importing it on web during SSR crashes because `window` doesn't exist yet.
if (Platform.OS !== "web") {
  require("react-native-url-polyfill/auto");
}

const supabaseUrl =
  process.env.EXPO_PUBLIC_SUPABASE_URL ??
  "https://eoevulbjtpidskzoyfno.supabase.co";
const supabaseAnonKey =
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??
  "";

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn(
    "[Supabase] Missing environment variables. " +
      "Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY."
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    // On web, Supabase uses localStorage internally — passing AsyncStorage here
    // causes a crash because AsyncStorage isn't available in the browser.
    storage: Platform.OS !== "web" ? AsyncStorage : undefined,
    autoRefreshToken: true,
    persistSession: true,
    // Deep-link OAuth callback handling: native uses a custom scheme, web uses the URL.
    detectSessionInUrl: Platform.OS === "web",
  },
  realtime: {
    params: {
      eventsPerSecond: 10,
    },
  },
});

// ─── Auth Helpers ──────────────────────────────────────────────────────────────

export function getAuthRedirectUrl() {
  if (Platform.OS === "web") {
    if (typeof window !== "undefined" && window.location?.origin) {
      return `${window.location.origin}/auth/callback`;
    }
    return "http://localhost:5173/auth/callback";
  }

  // Expo Go resolves this to exp://.../--/auth/callback. A dev/production
  // build with the configured scheme resolves to pickandpay://auth/callback.
  return Linking.createURL("auth/callback");
}

type AuthResult = {
  data: { session: Session | null } | null;
  error: AuthError | Error | null;
};

export type SocialAuthProvider = "google" | "apple" | "microsoft" | "facebook";

const SUPABASE_OAUTH_PROVIDERS: Record<SocialAuthProvider, Provider> = {
  google: "google",
  apple: "apple",
  microsoft: "azure",
  facebook: "facebook",
};

const handledAuthCallbackUrls = new Set<string>();

function readCallbackParams(url: string) {
  const queryPart = url.split("?")[1]?.split("#")[0] ?? "";
  const hashPart = url.split("#")[1] ?? "";
  const params = new URLSearchParams(queryPart);
  const hashParams = new URLSearchParams(hashPart);

  hashParams.forEach((value, key) => {
    if (!params.has(key)) params.set(key, value);
  });

  return params;
}

export function isAuthCallbackUrl(url: string) {
  return (
    url.includes("auth/callback") ||
    url.includes("access_token=") ||
    url.includes("refresh_token=") ||
    url.includes("code=") ||
    url.includes("token_hash=")
  );
}

export async function completeAuthSessionFromUrl(url: string) {
  if (!isAuthCallbackUrl(url)) return null;
  if (handledAuthCallbackUrls.has(url)) {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    return session;
  }
  handledAuthCallbackUrls.add(url);

  const params = readCallbackParams(url);
  const errorCode = params.get("error_code") ?? params.get("error");
  if (errorCode) {
    throw new Error(params.get("error_description") ?? errorCode);
  }

  const code = params.get("code");
  if (code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) throw error;
    return data.session;
  }

  const accessToken = params.get("access_token");
  const refreshToken = params.get("refresh_token");
  if (accessToken && refreshToken) {
    const { data, error } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    if (error) throw error;
    return data.session;
  }

  const tokenHash = params.get("token_hash");
  const type = params.get("type");
  if (tokenHash && type === "recovery") {
    const { data, error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: "recovery",
    });
    if (error) throw error;
    return data.session;
  }

  return null;
}

export async function signInWithSocialProvider(
  provider: SocialAuthProvider
): Promise<AuthResult> {
  const supabaseProvider = SUPABASE_OAUTH_PROVIDERS[provider];
  const redirectTo = getAuthRedirectUrl();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: supabaseProvider,
    options: {
      redirectTo,
      scopes: provider === "microsoft" ? "email" : undefined,
      queryParams:
        provider === "microsoft" ? { prompt: "select_account" } : undefined,
      skipBrowserRedirect: Platform.OS !== "web",
    },
  });

  if (error) return { data: null, error };

  if (Platform.OS !== "web" && data.url) {
    console.log("[auth] Opening OAuth session:", { provider, redirectTo });
    const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
    console.log("[auth] OAuth browser result:", result.type);

    if (result.type === "success") {
      const session = await completeAuthSessionFromUrl(result.url);
      return { data: { session }, error: null };
    }

    if (result.type === "cancel" || result.type === "dismiss") {
      return { data: { session: null }, error: null };
    }
  }

  return { data: { session: null }, error: null };
}

export async function signInWithGoogle() {
  return signInWithSocialProvider("google");
}

export async function signInWithApple() {
  return signInWithSocialProvider("apple");
}

export async function signInWithMicrosoft() {
  return signInWithSocialProvider("microsoft");
}

export async function signInWithFacebook() {
  return signInWithSocialProvider("facebook");
}

export async function signInWithEmail(email: string, password: string) {
  return supabase.auth.signInWithPassword({ email, password });
}

export async function signUpWithEmail(email: string, password: string) {
  return supabase.auth.signUp({ email, password });
}

export async function signOut() {
  return supabase.auth.signOut();
}

export async function getCurrentUser() {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

// ─── Profile Helpers ───────────────────────────────────────────────────────────

export async function getProfile(userId: string) {
  return supabase.from("profiles").select("*").eq("id", userId).single();
}

export async function upsertProfile(profile: {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  avatar_url?: string;
  avatar_icon?: string;
  color: string;
  provider?: string;
}) {
  return supabase.from("profiles").upsert(profile);
}

// ─── Session Helpers ───────────────────────────────────────────────────────────

export async function createSession(hostId: string, receiptData: object) {
  return supabase
    .from("sessions")
    .insert({
      host_id: hostId,
      receipt_data: receiptData,
      status: "waiting_participants",
    })
    .select()
    .single();
}

export async function getSession(sessionId: string) {
  return supabase
    .from("sessions")
    .select(`*, session_participants(*)`)
    .eq("id", sessionId)
    .single();
}

export async function updateSessionStatus(sessionId: string, status: string) {
  return supabase.from("sessions").update({ status }).eq("id", sessionId);
}

export async function joinSession(
  sessionId: string,
  userId: string,
  profile: object
) {
  return supabase.from("session_participants").upsert({
    session_id: sessionId,
    user_id: userId,
    selections: [],
    total_owed: 0,
    paid: false,
    confirmed_by_creator: false,
  });
}

export async function updateParticipantSelections(
  sessionId: string,
  userId: string,
  selections: object[],
  totalOwed: number
) {
  return supabase
    .from("session_participants")
    .update({ selections, total_owed: totalOwed })
    .eq("session_id", sessionId)
    .eq("user_id", userId);
}

export async function markParticipantPaid(
  sessionId: string,
  userId: string,
  paid: boolean
) {
  return supabase
    .from("session_participants")
    .update({ paid })
    .eq("session_id", sessionId)
    .eq("user_id", userId);
}

// ─── Receipt Parsing via Edge Function ────────────────────────────────────────

export async function parseReceiptImage(base64Image: string) {
  const { data, error } = await supabase.functions.invoke("parse-receipt", {
    body: { image: base64Image },
  });
  return { data, error };
}
