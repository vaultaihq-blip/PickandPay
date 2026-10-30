import type { TranslationKey } from "@/constants/translations";
import { showDialog } from "@/lib/dialog";

// PostgREST answers an UPDATE/DELETE that RLS filters out (or that matches
// nothing) with success and zero rows. Every write in the session flow goes
// through expectRows so that case is an error the user sees, not a silent
// "saved". The query must end in `.select(...)` so the affected rows come back.
//
// Every write also has a time limit. Without network the request (or the
// token refresh supabase-js runs before it) can hang with no error at all, so
// the screen just did nothing. A timed-out write may still have reached the
// server; the session writes are idempotent, so the user can simply retry.

export const WRITE_TIMEOUT_MS = 10_000;

export class WriteError extends Error {
  constructor(
    readonly label: string,
    readonly kind: "failed" | "no_rows" | "timeout",
    readonly detail?: string
  ) {
    super(
      kind === "no_rows" ? `${label}: 0 rows affected`
        : kind === "timeout" ? `${label}: timed out`
        : `${label}: ${detail ?? "failed"}`
    );
    this.name = "WriteError";
  }
}

type WriteResult = {
  data: unknown;
  error: { message: string; code?: string } | null;
};

// Rejects with WriteError("timeout") if `promise` has not settled after `ms`.
// Also for reads the user is waiting on before a write (e.g. finalize).
export function withTimeout<T>(
  label: string,
  promise: PromiseLike<T>,
  ms: number = WRITE_TIMEOUT_MS,
  onTimeout?: () => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      console.error(`[write] ${label}: no answer after ${ms / 1000}s`);
      onTimeout?.();
      reject(new WriteError(label, "timeout"));
    }, ms);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

type AbortableQuery = PromiseLike<WriteResult> & {
  abortSignal?: (signal: AbortSignal) => PromiseLike<WriteResult>;
};

export async function expectRows<T = unknown>(
  label: string,
  query: AbortableQuery
): Promise<T[]> {
  // PostgREST builders take an AbortSignal; abort the fetch when the limit passes
  // so a late answer can't land after the user was told it failed.
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const request =
    controller && typeof query.abortSignal === "function" ? query.abortSignal(controller.signal) : query;
  const { data, error } = await withTimeout(label, request, WRITE_TIMEOUT_MS, () => controller?.abort());
  if (error) {
    console.error(`[write] ${label} failed:`, error);
    throw new WriteError(label, "failed", error.message);
  }
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  if (rows.length === 0) {
    console.error(`[write] ${label}: 0 rows affected`);
    throw new WriteError(label, "no_rows");
  }
  return rows as T[];
}

export function writeErrorMessage(err: unknown, t: (key: TranslationKey) => string): string {
  if (err instanceof WriteError) {
    if (err.kind === "timeout") return t("write_timeout_msg");
    return err.kind === "no_rows" ? t("write_no_rows_msg") : t("write_failed_msg");
  }
  return err instanceof Error ? err.message : t("write_failed_msg");
}

export function showWriteError(err: unknown, t: (key: TranslationKey) => string): void {
  showDialog(t("error"), writeErrorMessage(err, t));
}

// For exits (leave / end session): the write failed, so the server still
// counts the user as present. Let them stay and retry, or leave knowingly.
export function showLeaveWriteError(
  err: unknown,
  t: (key: TranslationKey) => string,
  leaveAnyway: () => void
): void {
  showDialog(t("error"), writeErrorMessage(err, t), [
    { text: t("lobby_stay"), style: "cancel" },
    { text: t("leave_anyway"), style: "destructive", onPress: leaveAnyway },
  ]);
}
