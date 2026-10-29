import * as Linking from "expo-linking";
import { router } from "expo-router";
import { completeAuthSessionFromUrl, isAuthCallbackUrl } from "@/lib/supabase";

export const DEEP_LINK_SCHEME = "pickandpay";

export const DEEP_LINK_PATHS = {
  session: (id: string) => `${DEEP_LINK_SCHEME}://session/${id}`,
  profile: (id: string) => `${DEEP_LINK_SCHEME}://profile/${id}`,
  joinSession: (id: string) => `https://pickandpay.app/session/${id}`,
  referral: (userId: string) => `${DEEP_LINK_SCHEME}://join?ref=${userId}`,
} as const;

export function buildSessionLink(sessionId: string): string {
  return DEEP_LINK_PATHS.session(sessionId);
}

export function buildSessionShareText(
  sessionId: string,
  restaurant: string
): string {
  return `Join my Pick&Pay session for ${restaurant}!\n${buildSessionLink(sessionId)}`;
}

export function parseDeepLink(url: string): {
  type: "session" | "profile" | "referral" | "unknown";
  id?: string;
  ref?: string;
} {
  try {
    const refMatch = url.match(/join\?ref=([a-zA-Z0-9_-]+)/);
    if (refMatch) {
      return { type: "referral", ref: refMatch[1] };
    }

    const sessionMatch = url.match(/session\/([a-zA-Z0-9-]+)/);
    if (sessionMatch && sessionMatch[1] !== "join") {
      const refInSession = url.match(/[?&]ref=([a-zA-Z0-9_-]+)/);
      return { type: "session", id: sessionMatch[1], ref: refInSession?.[1] };
    }

    const profileMatch = url.match(/profile\/([a-zA-Z0-9-]+)/);
    if (profileMatch) {
      return { type: "profile", id: profileMatch[1] };
    }

    return { type: "unknown" };
  } catch {
    return { type: "unknown" };
  }
}

async function handleAuthCallback(url: string): Promise<boolean> {
  if (!isAuthCallbackUrl(url)) return false;

  console.log("[DeepLink] Auth callback received");
  try {
    await completeAuthSessionFromUrl(url);
    if (url.includes("type=recovery")) {
      router.replace("/(auth)/reset-password");
    }
    // Email confirmation (type=email or type=signup) — SIGNED_IN fires automatically,
    // _layout.tsx listener handles navigation to /(app)
  } catch (error) {
    console.error(
      "[DeepLink] Auth callback failed:",
      error instanceof Error ? error.message : error
    );
  }

  return true;
}

export async function handleDeepLink(
  url: string,
  onReferral?: (ref: string) => void
): Promise<void> {
  const wasAuth = await handleAuthCallback(url);
  if (wasAuth) return;

  const parsed = parseDeepLink(url);

  if (parsed.type === "session" && parsed.id) {
    // The router already opened the entry screen for it (app/+native-intent.tsx);
    // pushing it here too would stack a second one.
    if (parsed.ref) onReferral?.(parsed.ref);
  } else if (parsed.type === "referral" && parsed.ref) {
    onReferral?.(parsed.ref);
    router.push("/(auth)" as any);
  } else if (parsed.type === "profile" && parsed.id) {
    console.log("[DeepLink] Profile:", parsed.id);
  }
}

export function createURL(path: string): string {
  return Linking.createURL(path);
}

export function extractSessionIdFromQR(qrData: string): string | null {
  const parsed = parseDeepLink(qrData);
  return parsed.type === "session" ? (parsed.id ?? null) : null;
}
