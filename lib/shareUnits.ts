import type { TranslationKey } from "@/constants/translations";
import { showDialog } from "@/lib/dialog";
import { supabase } from "@/lib/supabase";
import { withTimeout, writeErrorMessage } from "@/lib/checkedWrite";
import type { ItemSelection } from "@/types";

// R12 — every pick and every share goes through the server, which decides
// the units under a per-session lock (two taps at the same moment never get
// the same unit). Each call answers with this user's selections as the
// server now has them; the other devices get theirs through realtime.

export interface UnitHolder {
  user_id: string;
  name: string;
  units: number;
}

export interface PickResult {
  status: "ok" | "full";
  units: number;
  item_units: number;
  free_units: number;
  holders: UnitHolder[];
  selections: ItemSelection[];
}

export interface RequestResult {
  user_id: string;
  result: "requested" | "already" | "pending" | "limit" | "not_present";
  request_id: number | null;
  has_other_unit: boolean;
}

async function call<T>(label: string, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await withTimeout(label, supabase.rpc(fn, args));
  if (error) {
    console.log(`[units] ${label}: refused — ${error.code ?? "?"}: ${error.message}${error.hint ? ` (${error.hint})` : ""}`);
    throw new UnitsError(error.message, error.hint ?? undefined);
  }
  return data as T;
}

export class UnitsError extends Error {
  constructor(readonly code: string, readonly hint?: string) {
    super(code);
    this.name = "UnitsError";
  }
}

export async function pickUnits(sessionId: string, itemId: string, units: number): Promise<PickResult> {
  const res = await call<PickResult>("selection: pick units", "pick_units", {
    p_session_id: sessionId, p_item_id: itemId, p_units: units,
  });
  console.log(`[units] pick ${itemId} → want ${units}: ${res.status}, have ${res.units} of ${res.item_units}, ${res.free_units} free`);
  return res;
}

export async function shareUnit(sessionId: string, itemId: string, holderId: string) {
  const res = await call<{ result: string; item_id?: string; unit?: number; selections?: ItemSelection[] }>(
    "selection: share a unit", "share_unit", { p_session_id: sessionId, p_item_id: itemId, p_holder: holderId }
  );
  console.log(`[units] share ${itemId} with ${holderId}: ${res.result}${res.unit ? ` (${res.item_id}#${res.unit})` : ""}`);
  return res;
}

export async function requestShare(sessionId: string, itemId: string, userIds: string[]) {
  const res = await call<{ item_id: string; unit: number; results: RequestResult[] }>(
    "selection: ask to share", "request_share", { p_session_id: sessionId, p_item_id: itemId, p_to: userIds }
  );
  console.log(`[units] request ${res.item_id}#${res.unit}: ${res.results.map((r) => `${r.user_id.slice(0, 8)} ${r.result}`).join(", ")}`);
  return res;
}

export async function answerShare(sessionId: string, requestIds: number[], accept: boolean) {
  const res = await call<{ results: { request_id: number; result: string }[]; selections: ItemSelection[] }>(
    "share requests: answer", "answer_share", { p_session_id: sessionId, p_request_ids: requestIds, p_accept: accept }
  );
  console.log(`[units] answer ${accept ? "accept" : "reject"}: ${res.results.map((r) => `${r.request_id} ${r.result}`).join(", ")}`);
  return res;
}

export async function manageShareRequest(requestId: number, action: "cancel" | "remind" | "dismiss") {
  const res = await call<{ result: string }>(`share requests: ${action}`, "manage_share_request", {
    p_request_id: requestId, p_action: action,
  });
  console.log(`[units] ${action} request ${requestId}: ${res.result}`);
  return res;
}

const MESSAGES: Record<string, TranslationKey> = {
  SESSION_FINALIZED: "units_err_finalized",
  NOT_IN_SESSION: "units_err_not_in_session",
  UNITS_TAKEN: "units_err_taken",
  PICK_FIRST: "units_err_pick_first",
  ITEM_NOT_FOUND: "units_err_item_missing",
};

/** The server's reason, in words; stays on screen until closed. */
export function showUnitsError(err: unknown, t: (key: TranslationKey) => string): void {
  if (err instanceof UnitsError && MESSAGES[err.code]) {
    showDialog(t("error"), t(MESSAGES[err.code]));
    return;
  }
  showDialog(t("error"), writeErrorMessage(err, t));
}
