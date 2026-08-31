export const DEV_EMAILS = ["vault.ai.hq@gmail.com"];
export const DEV_PIN = "2580";

declare const __DEV__: boolean;
export const DEV_MODE = typeof __DEV__ !== "undefined" ? __DEV__ : false;

export const LIMITS = {
  MAX_TEST_PARTICIPANTS: DEV_MODE ? 10 : 10,
} as const;

export function isDeveloperUser(email?: string): boolean {
  if (!__DEV__) return false;
  if (!email) return false;
  return DEV_EMAILS.includes(email.toLowerCase());
}

/**
 * Offline/dev sessions are never persisted to Supabase.
 * They are identified by well-known ID prefixes so all screens can skip DB operations.
 * - "session_"     → guest/unauthenticated local session (index.tsx, review.tsx)
 * - "dev_session_" → DevPanel quick-start session (DevPanel.tsx)
 */
export function isOfflineSessionId(id: string | null | undefined): boolean {
  if (!id) return false;
  return id.startsWith("session_") || id.startsWith("dev_session_");
}
