import type { TranslationKey } from "@/constants/translations";
import { showDialog } from "@/lib/dialog";

// PostgREST answers an UPDATE/DELETE that RLS filters out (or that matches
// nothing) with success and zero rows. Every write in the session flow goes
// through expectRows so that case is an error the user sees, not a silent
// "saved". The query must end in `.select(...)` so the affected rows come back.

export class WriteError extends Error {
  constructor(
    readonly label: string,
    readonly kind: "failed" | "no_rows",
    readonly detail?: string
  ) {
    super(kind === "no_rows" ? `${label}: 0 rows affected` : `${label}: ${detail ?? "failed"}`);
    this.name = "WriteError";
  }
}

type WriteResult = {
  data: unknown;
  error: { message: string; code?: string } | null;
};

export async function expectRows<T = unknown>(
  label: string,
  query: PromiseLike<WriteResult>
): Promise<T[]> {
  const { data, error } = await query;
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
