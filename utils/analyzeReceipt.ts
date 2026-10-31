import { ParsedReceipt } from "@/types";
import {
  type RawReceiptPayload,
  evaluateReceipt,
  moneyToMajorNumber,
  normalizeRawReceipt,
} from "@/lib/receipt";
import { toParsedReceipt } from "@/lib/receipt/adapter";
import { useCanonicalReceiptStore } from "@/store/canonicalReceiptStore";
import { parseReceiptImage } from "@/lib/supabase";
import { normalizeReceipt } from "@/utils/parser";

// The call to the parse-receipt edge function. A normal import of
// lib/supabase, not a dynamic one: in Expo Go the dynamic import made the
// phone fetch a separate lib/supabase bundle from Metro on "Scan receipt",
// and the app restarted right after (logs/metro.log, 2026-10-30). The pure
// normalisation helpers stay in utils/parser.ts, which Node tests load.

// ─── Receipt Analyzer ────────────────────────────────────────────────────────

interface ParseReceiptResponse {
  schemaVersion?: number;
  receipt?: RawReceiptPayload;
}

export async function analyzeReceipt(
  imageUri: string,
  // C.3 — the session this scan is for: the scan's credit pays it (host).
  sessionId?: string
): Promise<{ receipt: ParsedReceipt; rawText: string }> {
  // A new scan means a new receipt identity — any canonical receipt/issues
  // left over from a previous scan must not survive into this one, even if
  // this particular call ends up on the legacy (non-v2) branch below and
  // never repopulates the store itself.
  useCanonicalReceiptStore.getState().clear();

  console.log("📸 [parser] Starting edge function OCR:", imageUri.substring(0, 40));
  const { data, error, code } = await parseReceiptImage(imageUri, sessionId);
  if (error) {
    throw Object.assign(
      new Error(`OCR edge function failed: ${(error as { message?: string }).message ?? "Unknown error"}`),
      { code }
    );
  }
  if (!data) {
    throw new Error("OCR edge function returned no data");
  }

  const response = data as ParseReceiptResponse;

  let receipt: ParsedReceipt;
  if (response.schemaVersion === 2 && response.receipt !== undefined) {
    // Structural v2 envelope: run it through the canonical pipeline (exact
    // money, reconciliation, diagnostics), then bridge to the legacy shape so
    // normalizeReceipt's tax-mode reconciliation below still applies.
    const canonical = evaluateReceipt(normalizeRawReceipt(response.receipt));
    const legacy = toParsedReceipt(canonical);

    useCanonicalReceiptStore.getState().setReceipt(canonical);

    receipt = normalizeReceipt({
      ...legacy,
      printed_total:
        canonical.printedTotal !== undefined
          ? moneyToMajorNumber(canonical.printedTotal)
          : undefined,
    });
  } else {
    // Legacy category-based payload — kept so an older deployed function
    // keeps working while the new one rolls out.
    receipt = normalizeReceipt(data as Partial<ParsedReceipt>);
  }

  console.log("✅ [parser] OCR complete:", receipt.restaurant);
  return { receipt, rawText: "" };
}
