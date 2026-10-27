import { Platform } from "react-native";
import * as WebBrowser from "expo-web-browser";
import * as Linking from "expo-linking";
import { AuthError, Provider, Session, createClient } from "@supabase/supabase-js";
import AsyncStorage from "@react-native-async-storage/async-storage";

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
  if (tokenHash && type) {
    const otpType = type === "recovery" ? "recovery"
      : type === "email" || type === "signup" ? "email"
      : null;
    if (otpType) {
      const { data, error } = await supabase.auth.verifyOtp({
        token_hash: tokenHash,
        type: otpType as any,
      });
      if (error) throw error;
      return data.session;
    }
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
    if (__DEV__) console.log("[auth] Opening OAuth session:", { provider, redirectTo });
    const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
    if (__DEV__) console.log("[auth] OAuth browser result:", result.type);

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
  return supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: getAuthRedirectUrl() },
  });
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

// bill_credits is intentionally excluded — only server-side RPCs may modify it.
// Passing bill_credits here would be silently reverted by the protect_bill_credits trigger.
export async function upsertProfile(profile: {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  avatar_url?: string | null;
  avatar_icon?: string | null;
  color: string;
  // No `provider`: profiles has no such column in production, and PostgREST
  // rejects the whole upsert (PGRST204) when the payload carries it.
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
      status: "draft",
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

async function uriToBase64(image: string): Promise<string> {
  if (image.startsWith("data:")) return image.split(",")[1] ?? "";
  // file:// or http(s):// URI — fetch and read as base64
  const response = await fetch(image);
  const blob = await response.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve((reader.result as string).split(",")[1]);
    reader.onerror = () => reject(new Error("Failed to convert image to base64"));
    reader.readAsDataURL(blob);
  });
}

export async function deleteAccount() {
  const { data: { session } } = await supabase.auth.getSession();
  const { error } = await supabase.functions.invoke("delete-account", {
    headers: session?.access_token
      ? { Authorization: `Bearer ${session.access_token}` }
      : undefined,
  });
  return { error };
}

async function uploadReceiptImageToStorage(
  localUri: string,
  userId: string
): Promise<string | null> {
  try {
    const filename = `${userId}/${Date.now()}.jpg`;
    const response = await fetch(localUri);
    const blob = await response.blob();
    const { data, error } = await supabase.storage
      .from("ocr-receipt-images")
      .upload(filename, blob, { contentType: "image/jpeg", upsert: false });
    if (error) return null;
    return data.path;
  } catch {
    return null;
  }
}

export async function saveOCRCorrection(params: {
  sessionId: string | null;
  userId: string;
  receiptImagePath: string | null;
  originalOcrJson: unknown;
  userCorrectedJson: unknown;
  correctedItems: Array<{ item_id: string; field: string; before: unknown; after: unknown }>;
  correctionType: string[];
  ocrPasses: number;
}): Promise<void> {
  let storagePath = params.receiptImagePath;
  // Upload local device URI to Storage so it's available for fine-tuning export
  if (
    storagePath &&
    !storagePath.startsWith("http") &&
    !storagePath.startsWith("ocr-receipt-images/")
  ) {
    storagePath = await uploadReceiptImageToStorage(storagePath, params.userId);
  }

  await supabase.from("ocr_corrections").insert({
    session_id: params.sessionId,
    user_id: params.userId,
    receipt_image_path: storagePath,
    original_ocr_json: params.originalOcrJson,
    user_corrected_json: params.userCorrectedJson,
    corrected_items: params.correctedItems,
    correction_type: params.correctionType,
    ocr_passes: params.ocrPasses,
  });
}

export async function initializeUserCredits(): Promise<{
  freeCredits: number;
  alreadyGranted: boolean;
  isEstablished: boolean;
  balance: number;
} | null> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) return null;

  const { data, error } = await supabase.functions.invoke("initialize-user-credits", {
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  if (error) {
    console.warn("[initializeUserCredits] Edge function error:", error);
    return null;
  }
  return data as { freeCredits: number; alreadyGranted: boolean; isEstablished: boolean; balance: number };
}

export async function parseReceiptImage(image: string) {
  const base64 = await uriToBase64(image);

  // Explicitly pass the current session token so the edge function can verify the JWT.
  // supabase.functions.invoke() also injects it automatically, but being explicit
  // prevents silent failures when the session is refreshed mid-flight.
  const { data: { session } } = await supabase.auth.getSession();
  const authHeaders = session?.access_token
    ? { Authorization: `Bearer ${session.access_token}` }
    : undefined;

  const { data, error } = await supabase.functions.invoke("parse-receipt", {
    body: { imageBase64: base64 },
    headers: authHeaders,
  });
  return { data, error };
}
