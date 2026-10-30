// R8 — the session code: 6 characters with no look-alikes (no 0/O, 1/I/L),
// shown as ABC-234. The server makes it and decides what it opens
// (resolve_join_code → join_preview); this only formats what people type.
// No URL carries it under a `code` parameter: isAuthCallbackUrl treats any
// URL with code= as a login callback.

export const JOIN_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const JOIN_CODE_LENGTH = 6;

/** Upper case, no spaces or hyphens — what the server compares. */
export function normalizeJoinCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, "");
}

/** ABC234 → ABC-234 (anything else is returned as typed). */
export function formatJoinCode(code: string | null | undefined): string {
  const c = normalizeJoinCode(code ?? "");
  return c.length === JOIN_CODE_LENGTH ? `${c.slice(0, 3)}-${c.slice(3)}` : c;
}

/** Six characters from the alphabet: worth asking the server about. */
export function looksLikeJoinCode(input: string): boolean {
  const c = normalizeJoinCode(input);
  return c.length === JOIN_CODE_LENGTH && [...c].every((ch) => JOIN_CODE_ALPHABET.includes(ch));
}
