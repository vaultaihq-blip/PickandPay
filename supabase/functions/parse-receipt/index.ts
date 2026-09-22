import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * parse-receipt — OCR-grounded receipt extraction.
 *
 * v1 of this pipeline (evidence-ledger-v1, deployed as v53) read every
 * monetary digit via TWO separate GPT-4o Vision calls (a transcription pass
 * and an independent witness pass) and cross-checked them. Real-device
 * testing showed the same receipt image producing different results between
 * runs — consistent with vision-model completions having genuine run-to-run
 * variance even at temperature 0, unlike text-only completions over a fixed
 * input. No amount of additional GPT re-reads removes a per-call source of
 * randomness; it only samples it more.
 *
 * This version (ocr-grounded-v1) changes the architecture instead: a
 * dedicated OCR engine (Google Cloud Vision, DOCUMENT_TEXT_DETECTION) is the
 * ONE source of truth for every printed character and monetary digit. It is
 * deterministic per input, not generative. The LLM never re-reads a digit on
 * the happy path — it only interprets STRUCTURE and RELATIONSHIPS over OCR's
 * evidence (item/modifier ownership, quantities, unit-vs-line-total,
 * subtotal/tax/service/tip/total classification), referencing monetary
 * values exclusively by OCR-token-derived amountId. The Structured Outputs
 * schema makes it schema-impossible for this call to return a bare
 * `basePrice: number` — see schema.ts.
 *
 * Flow:
 *   image
 *     -> OCR PASS: Google Cloud Vision DOCUMENT_TEXT_DETECTION (1 request)
 *        returns words with bounding boxes + confidence; ocr.ts
 *        reconstructs printed lines from word geometry (deterministic, not
 *        a generative "transcribe this" step).
 *     -> buildLedgerFromOcr(): every OCR word that money-pattern-matches
 *        becomes ONE ledger entry, anchored to that physical OCR token.
 *        Never deduped by value. No cross-read alignment needed or done —
 *        there's exactly one OCR read to trust in the first place.
 *     -> ONE semantic pass (structure + price assignment together): text
 *        only, over OCR's lines + the full monetary ledger. Structured
 *        Outputs' amountId enum is a fabrication-prevention SAFETY LAYER
 *        only, never the source of truth.
 *     -> deterministic validation: existence, then OWNERSHIP (the chosen ID
 *        was actually near the claiming block's own lines), then evidence
 *        strength (OCR's own confidence for that word — never blindly
 *        trusted; see OCR_CONFIDENCE_THRESHOLD in validate.ts).
 *     -> targeted verification (fallback only, batched): fires for an
 *        ownership failure, a low-confidence load-bearing value, or a
 *        reconciliation failure that survives round 1. This is the ONLY
 *        place a vision model re-reads a digit, only for the few
 *        occurrences actually in doubt, describing the flagged location
 *        over the full image rather than a second primary read.
 *     -> reconcile() (existing lightweight check) — a supporting signal
 *        only, never proof two OCR/semantic errors didn't cancel out.
 *     -> RawPayload, same public shape the client has always consumed.
 *
 * Auth and rate limiting below are unchanged from the previous pipeline.
 */

import {
  STRUCTURE_AND_ASSIGNMENT_SYSTEM_PROMPT,
  TARGETED_VERIFICATION_SYSTEM_PROMPT,
} from "./prompts.ts";
import { callGoogleVision, normalizeVisionResponse, OcrError } from "./ocr.ts";
import { buildLedgerFromOcr, type LedgerEntry } from "./ledger.ts";
import {
  buildStructureSchema,
  describeLedgerForPrompt,
  assignmentsFromBlocks,
  type StructureBlock,
  type Assignment,
} from "./schema.ts";
import {
  validateAssignments,
  findSuspiciousEvidence,
  findOwnershipAmbiguous,
  findReconciliationSuspects,
  findArithmeticContradictions,
  buildFinalPayload,
  OCR_CONFIDENCE_THRESHOLD,
  type SuspiciousEvidence,
} from "./validate.ts";
import { computeGeometricOwnership, detectConstantOffsetRuns, type PriceBlockInput } from "./ownership.ts";
import { resolveTotalWitness } from "./totalWitness.ts";
import { filterToAuthoritativeColumn, detectAuthoritativeColumn, computeReadingAngle, detectColumnRoles } from "./columns.ts";
import {
  computeItemsRegionEnd,
  findStructuralGaps,
  classifyCoverage,
  findDuplicateOwnership,
  determineValidity,
  classifySummaryCoverage,
  findSummaryDuplicateRoles,
  determineSummaryValidity,
  applyProvenNonAdditive,
  applyProvenAdditiveCharge,
  applyItemsRegionSaturation,
} from "./coverage.ts";
import { reconcile, toMajor, toMinor } from "./reconcile.ts";

const PARSER_VERSION = "ocr-grounded-v1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RATE_LIMIT_MAX = 20;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const GOOGLE_CLOUD_API_KEY = Deno.env.get("GOOGLE_CLOUD_API_KEY") ?? "";
// Pinned to a dated snapshot, not the "gpt-4o" alias: OpenAI documents that
// model behavior can shift between snapshots served under the same alias,
// and recommends pinning a specific snapshot for reproducible results
// (https://platform.openai.com/docs/models/gpt-4o). gpt-4o-2024-08-06 is the
// snapshot "gpt-4o" currently resolves to.
const MODEL = "gpt-4o-2024-08-06";
const OCR_LANGUAGE_HINTS = ["pt", "en", "es", "fr", "zh"];
// FIX 22 — measured against all 72 saved structuring runs across the FIX
// 19/20/21 diagnostic corpora (temperature=0, same image, same prompt):
// structuralGapCount was 0-2 in 69 of them and 27/32/32 in exactly 3 (all
// the same Ramires image on a bad run). No value in between was ever
// observed — a clean, wide gap, not a tuned cutoff. 5 sits well above every
// good run and well below every bad one; any value from 3 to 26 would have
// drawn the same line on this data.
const STRUCTURAL_GAP_RETRY_THRESHOLD = 5;
// FIX 17 Part 2 tried adding the receipt image to the structuring call
// alongside OCR text (same prompt, same amountId-only schema). Measured
// against the pre-registered criteria: structure-pass block-count stability
// got WORSE on 3 of 7 real receipts (Ramires, Pai, Mad God — including Mad
// God, the specific worst-case the experiment targeted), token cost roughly
// tripled and latency roughly quadrupled, with unresolvedLoadBearingCount
// unchanged on 5 of 7. Zero new FALSE_VALID, but that alone doesn't clear
// the pre-registered bar. REJECTED and reverted — see this session's FIX 17
// Part 2 report for the full measurement if this is ever revisited.

// ─── OpenAI calls ─────────────────────────────────────────────────────────────

interface OpenAIMessageContent {
  type: string;
  [key: string]: unknown;
}

type ResponseFormat =
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: Record<string, unknown> };

class OpenAIError extends Error {
  readonly status: number;
  constructor(status: number, detail: string) {
    super(`OpenAI ${status}: ${detail.slice(0, 300)}`);
    this.name = "OpenAIError";
    this.status = status;
  }
}

async function callOpenAI(
  systemPrompt: string,
  userContent: OpenAIMessageContent[],
  maxTokens: number,
  responseFormat: ResponseFormat = { type: "json_object" }
): Promise<string> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      max_tokens: maxTokens,
      temperature: 0,
      response_format: responseFormat,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new OpenAIError(response.status, detail);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new Error("EMPTY_MODEL_RESPONSE");
  }
  return content;
}

async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = Date.now();
  const result = await fn();
  return { result, ms: Date.now() - start };
}

/**
 * FIX 22 — the Vision call failed intermittently and transiently during the
 * FIX 20/21 diagnostic corpus runs (~half the runs hit "fetch failed" at
 * least once, recovering on a bare retry with no other change). Diagnosed
 * as a network-layer failure, not an API error: `callGoogleVision` throws
 * `OcrError` for a real API response (bad key, quota, malformed image) —
 * those fail identically on retry and are never retried here. A DIFFERENT
 * thrown error (fetch itself never got a response — a dropped connection,
 * DNS hiccup) is the one this retries, exactly once, matching the
 * diagnostic script's own manual retry loop that resolved it there.
 */
async function callGoogleVisionWithRetry(apiKey: string, base64Content: string, languageHints: string[]): Promise<unknown> {
  try {
    return await callGoogleVision(apiKey, base64Content, languageHints);
  } catch (err) {
    if (err instanceof OcrError) throw err; // a real API response — retrying changes nothing
    console.warn("[parse-receipt] Vision call failed with a transient (non-API) error, retrying once:", err instanceof Error ? err.message : err);
    return await callGoogleVision(apiKey, base64Content, languageHints);
  }
}

// ─── Targeted verification (fallback only) ─────────────────────────────────

interface VerificationReading {
  rawText: string | null;
  value: number | null;
  confident: boolean;
}

async function runTargetedVerification(
  imageUrl: string,
  suspicious: SuspiciousEvidence[],
  ledger: LedgerEntry[],
  lines: string[]
): Promise<VerificationReading[]> {
  const ledgerById = new Map(ledger.map((e) => [e.amountId, e]));
  const locations = suspicious
    .map((s, i) => {
      const entry = s.amountId ? ledgerById.get(s.amountId) : undefined;
      const lineText = s.lineIndex !== undefined ? lines[s.lineIndex] : entry?.rawText ?? "";
      return `${i + 1}. near line ${s.lineIndex ?? "unknown"}: "${lineText}"`;
    })
    .join("\n");

  const content = await callOpenAI(
    TARGETED_VERIFICATION_SYSTEM_PROMPT,
    [
      { type: "image_url", image_url: { url: imageUrl, detail: "high" } },
      { type: "text", text: `Locations to re-read:\n${locations}` },
    ],
    1000
  );

  try {
    const parsed = JSON.parse(content);
    const readings = Array.isArray(parsed?.readings) ? parsed.readings : [];
    return readings.map((r: Record<string, unknown>) => ({
      rawText: typeof r?.rawText === "string" ? r.rawText : null,
      value: typeof r?.value === "number" ? r.value : null,
      confident: r?.confident === true,
    }));
  } catch {
    return [];
  }
}

/**
 * Applies verification readings back onto the ledger/assignments. A
 * confident independent re-read is treated as resolving the occurrence
 * (strong evidence — framed as such in comments and logs, never as proof).
 * An unresolved one is never guessed at: the assignment is cleared so the
 * item ends up with no price, which the existing client-side review flow
 * already surfaces for manual correction rather than shipping a silent
 * wrong number.
 */
function applyVerificationResults(
  ledger: LedgerEntry[],
  assignments: Assignment[],
  suspicious: SuspiciousEvidence[],
  readings: VerificationReading[]
): { resolvedCount: number; unresolvedCount: number } {
  let resolvedCount = 0;
  let unresolvedCount = 0;

  suspicious.forEach((s, i) => {
    const reading = readings[i];
    const resolved = reading !== undefined && reading.confident && reading.value !== null;

    if (resolved) {
      resolvedCount += 1;
      if (s.amountId) {
        const entry = ledger.find((e) => e.amountId === s.amountId);
        if (entry) {
          entry.value = reading.value as number;
          if (reading.rawText !== null) entry.rawText = reading.rawText;
          // A confident targeted re-read resolves the doubt this entry was
          // flagged for — its effective confidence going forward reflects
          // that, not literally OCR's original (possibly low) score.
          entry.ocrConfidence = Math.max(entry.ocrConfidence, 0.95);
        }
      }
    } else {
      unresolvedCount += 1;
      const assignment = assignments.find((a) => a.blockId === s.blockId);
      if (assignment) assignment.amountId = null;
    }
  });

  return { resolvedCount, unresolvedCount };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

/**
 * Error codes returned to the client. The client maps these to user-facing
 * copy; raw provider errors are never surfaced to end users.
 */
type ErrorCode =
  | "UNAUTHORIZED"
  | "MISSING_IMAGE"
  | "NOT_CONFIGURED"
  | "RATE_LIMITED"
  | "PROVIDER_ERROR"
  | "UNREADABLE_RECEIPT"
  | "INTERNAL_ERROR";

function errorResponse(code: ErrorCode, status: number): Response {
  return jsonResponse({ error: code }, status);
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return errorResponse("UNAUTHORIZED", 401);
  }

  const token = authHeader.slice(7);
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { data: { user }, error: authError } = await anonClient.auth.getUser(token);
  if (authError || !user) {
    return errorResponse("UNAUTHORIZED", 401);
  }

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count, error: rateError } = await admin
    .from("ocr_requests")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .gte("created_at", oneHourAgo);

  if (rateError) {
    console.error("[parse-receipt] rate limit lookup failed:", rateError.message);
  } else if ((count ?? 0) >= RATE_LIMIT_MAX) {
    return errorResponse("RATE_LIMITED", 429);
  }

  const { error: insertRateError } = await admin.from("ocr_requests").insert({ user_id: user.id });
  if (insertRateError) {
    console.error("[parse-receipt] rate limit insert failed:", insertRateError.message);
  }

  const startedAt = Date.now();

  try {
    const body = (await req.json()) as { image?: string; imageBase64?: string };
    const image = body.image ?? body.imageBase64;

    if (typeof image !== "string" || image.length === 0) {
      return errorResponse("MISSING_IMAGE", 400);
    }
    if (OPENAI_API_KEY.length === 0 || GOOGLE_CLOUD_API_KEY.length === 0) {
      console.error("[parse-receipt] OPENAI_API_KEY or GOOGLE_CLOUD_API_KEY is not configured");
      return errorResponse("NOT_CONFIGURED", 500);
    }

    const base64Content = image.startsWith("data:") ? image.split(",")[1] ?? "" : image;
    const imageUrl = image.startsWith("data:") ? image : `data:image/jpeg;base64,${image}`;

    // ── OCR pass — the ONE source of truth for every printed character and
    // monetary digit. Deterministic per input, not a generative read. ──────
    const ocrPass = await timed(() => callGoogleVisionWithRetry(GOOGLE_CLOUD_API_KEY, base64Content, OCR_LANGUAGE_HINTS));
    const ocr = normalizeVisionResponse(ocrPass.result);
    if (ocr.lines.length === 0) {
      return errorResponse("UNREADABLE_RECEIPT", 422);
    }
    const lines = ocr.lines.map((l) => l.text);

    // ── Monetary Evidence Ledger — built directly from OCR tokens ───────────
    const ledger = buildLedgerFromOcr(ocr.lines);
    if (ledger.length === 0) {
      return errorResponse("UNREADABLE_RECEIPT", 422);
    }

    // FIX 11 (Group 1) — computed BEFORE the semantic pass, not just before
    // the geometric matcher. A first version filtered only the matcher's own
    // candidate pool and left GPT's schema/evidence list on the full ledger
    // — Ramires proved that insufficient: GPT could still PROPOSE a
    // wrong-column value (a "Preco: X/Uni" annotation) for a modifier block,
    // the matcher correctly refused to confidently match it, and FIX 8.1's
    // ambiguous-fallback then accepted GPT's own proposal anyway (nothing
    // else had claimed it — the fallback is untouched and correct to do
    // this; the value it was handed was the problem). Structured Outputs'
    // amountId enum makes this the actual fix: a value outside the
    // authoritative column is never offered to GPT as an option at all, so
    // there is nothing left for the fallback to accept. No exemption for
    // summary lines here — line-based exemption isn't knowable before GPT's
    // response exists, and it proved unnecessary: every one of the six real
    // fixtures kept its real subtotal/tax/total values in-band anyway, and
    // FIX 10's own total-closure search runs over the FULL, unfiltered
    // ledger regardless of what GPT could or couldn't propose here.
    const matchingLedger = filterToAuthoritativeColumn(ledger, ocr.lines, new Set());

    // ── ONE semantic pass — structure + price assignment together, text
    // only, over OCR's own deterministic output. ────────────────────────────
    const numberedLines = ocr.lines.map((l) => `${l.lineIndex}: ${l.text}`).join("\n");
    // Tried and reverted (see git history / conversation record): showing
    // GPT the FULL ledger in this description while keeping the schema enum
    // column-restricted was hypothesized to fix a Toronto structural
    // misclassification (a modifier's price split across two printed lines
    // lost its pairing once the off-column half was hidden from GPT
    // entirely). Tested live against all six real fixtures instead of just
    // Toronto: it made Toronto WORSE (339.50 vs 363.75, further from
    // 374.25) and broke Quebra Mar, which had been reconciling exactly
    // (300.25 -> 137.25). The extra off-column noise in the description
    // measurably degrades GPT's structural reasoning across the board, not
    // just for the one line it was meant to help. Reverted to matchingLedger
    // here; the Toronto modifier-splitting bug is still open.
    const ledgerDescription = describeLedgerForPrompt(matchingLedger);

    interface StructurePassResult {
      merchant: string | null;
      date: string | null;
      currency: string;
      blocks: StructureBlock[];
      ms: number;
    }

    // Extracted so FIX 22's retry (below) can run the IDENTICAL call a
    // second time — same prompt, same schema, nothing altered — and only
    // ever choose between the two results by structuralGapCount, never by
    // which one lands closer to any expected total (that signal does not
    // exist in production, and using it here would be optimizing against
    // the answer).
    async function runStructurePass(): Promise<StructurePassResult | null> {
      const pass = await timed(() =>
        callOpenAI(
          STRUCTURE_AND_ASSIGNMENT_SYSTEM_PROMPT,
          [
            {
              type: "text",
              text: `OCR lines (index: text):\n\n${numberedLines}\n\nMonetary amounts detected by OCR:\n\n${ledgerDescription}`,
            },
          ],
          // 6000, not 3000: a long real receipt (Mad God, 65 blocks) truncated
          // mid-JSON against the old cap. Safe to raise — truncation is caught
          // below (JSON.parse throws -> UNREADABLE_RECEIPT, never a silent
          // partial-structure acceptance) — verified before raising this, per
          // FIX 11. Kept in sync with scripts/debug-parse-receipt.ts's own
          // call so the diagnostic tool and production behave identically.
          6000,
          { type: "json_schema", json_schema: buildStructureSchema(matchingLedger, ocr.lines.length) }
        )
      );
      try {
        const parsedStructure = JSON.parse(pass.result);
        const merchant = typeof parsedStructure?.merchant === "string" ? parsedStructure.merchant : null;
        const date = typeof parsedStructure?.date === "string" ? parsedStructure.date : null;
        const currency =
          typeof parsedStructure?.currency === "string" && parsedStructure.currency.trim().length > 0
            ? parsedStructure.currency.trim().toUpperCase()
            : "EUR";
        const blocks: StructureBlock[] = Array.isArray(parsedStructure?.blocks) ? parsedStructure.blocks : [];
        // Defense in depth: the schema enum should already make an
        // out-of-range lineIndex impossible, but a provider guarantee is
        // never trusted blindly — drop anything outside the real document
        // instead of letting it corrupt downstream geometry lookups.
        for (const block of blocks) {
          block.lineIndices = block.lineIndices.filter((i) => i >= 0 && i < ocr.lines.length);
        }
        return { merchant, date, currency, blocks, ms: pass.ms };
      } catch {
        return null;
      }
    }

    let structurePass = await runStructurePass();
    if (structurePass === null || structurePass.blocks.length === 0) {
      return errorResponse("UNREADABLE_RECEIPT", 422);
    }
    let itemsRegionEnd = computeItemsRegionEnd(structurePass.blocks);
    let structuralGaps = findStructuralGaps(structurePass.blocks, ledger, itemsRegionEnd);
    let structureTimeMs = structurePass.ms;

    // FIX 22 Part 1 — structuralGapCount is a direct, deterministic-given-
    // the-blocks measure of segmentation quality, computed before ownership
    // ever runs. A bad structuring call (Ramires: 1 -> 27-32 on the exact
    // same image, same prompt) is retried ONCE — never more, per the
    // measured threshold above — and only replaced by the retry if the
    // retry's OWN structuralGapCount is strictly lower. If the retry is not
    // better (or the retry itself fails to parse), the first pass is kept;
    // a bad structuring pass is never silently discarded without a
    // like-for-like comparison.
    let structureRetryFired = false;
    let structuralGapCountBeforeRetry: number | null = null;
    if (structuralGaps.length > STRUCTURAL_GAP_RETRY_THRESHOLD) {
      structuralGapCountBeforeRetry = structuralGaps.length;
      structureRetryFired = true;
      const retryPass = await runStructurePass();
      if (retryPass !== null && retryPass.blocks.length > 0) {
        const retryItemsRegionEnd = computeItemsRegionEnd(retryPass.blocks);
        const retryStructuralGaps = findStructuralGaps(retryPass.blocks, ledger, retryItemsRegionEnd);
        structureTimeMs += retryPass.ms;
        if (retryStructuralGaps.length < structuralGaps.length) {
          structurePass = retryPass;
          itemsRegionEnd = retryItemsRegionEnd;
          structuralGaps = retryStructuralGaps;
        }
      }
    }

    const { merchant, date, currency, blocks } = structurePass;

    // ── Geometric price ownership — deterministic, not GPT's job. Proven
    // against the real rotated fixture that this receipt's name/price
    // vertical gap drifts progressively down the page; a fixed tolerance
    // calibrated from the top of the receipt silently mis-owns the tail.
    // GPT's own amountId proposal on each block is downgraded to a
    // free/paid hint for modifiers and a last-resort fallback only — never
    // the source of which specific value an item/summary block gets. ──────
    // Every block participates here, not just item/modifier/summary — a
    // "quantity" or "unclassified" block still territorially claims its own
    // lines, and that territory must still fence off a neighbour's search
    // even though it never needs a price itself (see ownership.ts).
    const ownershipInputs: PriceBlockInput[] = blocks.map((b) => ({
      blockId: b.blockId,
      kind: b.kind,
      lineIndices: b.lineIndices,
      name: b.name,
      parentBlockId: b.parentBlockId,
      proposedAmountId: b.amountId,
    }));
    // FIX 11 (Group 1) — reuses the SAME column-filtered ledger GPT itself
    // was restricted to above (computed once, before the semantic pass —
    // see the note there for why the filter has to apply that early).
    // Every OTHER use of `ledger` below (validation, final payload assembly)
    // still sees the FULL ledger — this filtering narrows what can become a
    // line PRICE, never removes evidence from the record.
    const ownershipResults = computeGeometricOwnership(ownershipInputs, matchingLedger, ocr.lines, itemsRegionEnd);
    const ownershipByBlock = new Map(ownershipResults.map((r) => [r.blockId, r]));
    for (const block of blocks) {
      const owned = ownershipByBlock.get(block.blockId);
      if (owned) block.amountId = owned.amountId;
    }

    // ── FIX 31 — independent evidence for the printed grand total (label in
    // the raw OCR text, then typographic emphasis — see totalWitness.ts's
    // own header for the full design and the corpus measurement behind it).
    // Computed once, from the real OCR lines and full ledger, and handed to
    // every buildFinalPayload call below unchanged.
    const totalWitness = resolveTotalWitness(ocr.lines, ledger, itemsRegionEnd);

    // ── FIX 27 — constant column offset, arbitrated by the printed subtotal.
    // Step 1 (detectConstantOffsetRuns, ownership.ts) finds the shape in the
    // raw OCR alone; it decides nothing on its own. Step 2 here builds
    // exactly two whole-receipt hypotheses (H0 = as already assigned above,
    // H1 = every detected run shifted back one position) and lets the
    // PRINTED subtotal — a named summary block's own geometrically-resolved
    // value, never the arithmetic-closure-derived printedSubtotal/
    // calculatedSubtotal — decide between them in exact minor-unit
    // arithmetic. No subtotal resolved this way, no arbitration: H0 stands.
    let offsetFormDetected = false;
    let offsetHypothesisAdopted: "H0" | "H1" | "AMBIGUOUS" = "H0";
    {
      const offsetRuns = detectConstantOffsetRuns(ownershipInputs, matchingLedger, ocr.lines, itemsRegionEnd);
      offsetFormDetected = offsetRuns.length > 0;
      const viableRuns = offsetRuns.filter((r) => r.h1AmountIds !== null);
      // Deliberately NOT validate.ts's own bare /subtotal/ regex (a
      // tie-breaker only there, never load-bearing) — "SUB-TOTAL" (a real,
      // common printed form, Hollywood Cafe included) fails it outright.
      // Punctuation/whitespace-stripped before matching here since this
      // check IS load-bearing (it gates whether Step 2 runs at all).
      const namedSubtotalBlock = blocks.find(
        (b) => b.kind === "summary" && /subtotal/.test((b.name ?? "").toLowerCase().replace(/[^a-z]/g, ""))
      );
      const namedSubtotalOwnership = namedSubtotalBlock ? ownershipByBlock.get(namedSubtotalBlock.blockId) : undefined;
      const printedSubtotalEntry =
        namedSubtotalOwnership?.confident && namedSubtotalOwnership.amountId
          ? ledger.find((e) => e.amountId === namedSubtotalOwnership.amountId) ?? null
          : null;
      const arbitrationTargetMinor = printedSubtotalEntry ? toMinor(printedSubtotalEntry.value, currency) : null;

      if (viableRuns.length > 0 && arbitrationTargetMinor !== null) {
        const affectedBlockIds = new Set(viableRuns.flatMap((r) => r.blockIds));
        const h1AmountIdByBlock = new Map<string, string | null>();
        for (const r of viableRuns) {
          for (const [blockId, amountId] of r.h1AmountIds!) h1AmountIdByBlock.set(blockId, amountId);
        }

        const h0Assignments = assignmentsFromBlocks(blocks);
        const h0Validations = validateAssignments(blocks, h0Assignments, ledger);
        const h0Assembled = buildFinalPayload(merchant, currency, lines, blocks, h0Validations, ledger, totalWitness);
        const h0SumMinor = reconcile(h0Assembled.payload).calculatedSubtotalMinor;

        const h1Blocks = blocks.map((b) =>
          affectedBlockIds.has(b.blockId) ? { ...b, amountId: h1AmountIdByBlock.get(b.blockId) ?? null } : b
        );
        const h1Assignments = assignmentsFromBlocks(h1Blocks);
        const h1Validations = validateAssignments(h1Blocks, h1Assignments, ledger);
        const h1Assembled = buildFinalPayload(merchant, currency, lines, h1Blocks, h1Validations, ledger, totalWitness);
        const h1SumMinor = reconcile(h1Assembled.payload).calculatedSubtotalMinor;

        const h0Closes = h0SumMinor === arbitrationTargetMinor;
        const h1Closes = h1SumMinor === arbitrationTargetMinor;

        if (h1Closes && !h0Closes) {
          offsetHypothesisAdopted = "H1";
          for (const block of blocks) {
            if (affectedBlockIds.has(block.blockId)) block.amountId = h1AmountIdByBlock.get(block.blockId) ?? null;
          }
        } else if (h0Closes && h1Closes) {
          // Both readings close on the same independent fact — neither is
          // preferred by a magnitude or name tie-break (see FIX 25.2's
          // detectCrossings for the same principle). Marked ambiguous and
          // left unresolved, never guessed.
          offsetHypothesisAdopted = "AMBIGUOUS";
          for (const block of blocks) {
            if (affectedBlockIds.has(block.blockId)) block.amountId = null;
          }
        }
        // Neither closes: H0 stands untouched, offsetHypothesisAdopted stays "H0".
      }
    }

    // ── Deterministic validation ─────────────────────────────────────────────
    let assignments = assignmentsFromBlocks(blocks);
    let validations = validateAssignments(blocks, assignments, ledger);
    // A confident geometric match is the authoritative ownership decision —
    // it supersedes the line-proximity radius check below, which predates
    // it and can reject a correct match that (legitimately, per the fitted
    // drift) spans more lines than the radius assumes. The radius check
    // still applies in full to anything geometric ownership didn't confidently
    // resolve (the "unclassified"/"quantity" kinds it never touches, and any
    // block that fell back to GPT's own hint).
    validations = validations.map((v) => {
      const owned = ownershipByBlock.get(v.blockId);
      if (owned?.confident && v.amountId === owned.amountId) {
        return { ...v, ownershipValid: true };
      }
      return v;
    });
    // FIX 35 — column roles (quantity/unit-price/total bands) in the items
    // region, reused below both for Part 4's arithmetic-contradiction
    // check (right here, round-1 suspicious evidence) and for Part 2/3's
    // row-proof and saturation (classifyCoverage/applyItemsRegionSaturation,
    // further down). Computed once, from the geometry alone — never
    // recomputed after verification, since a value's own content changing
    // never moves its bounding box.
    const columnRoles = detectColumnRoles(ledger, ocr.lines, itemsRegionEnd, new Set());

    const suspiciousByBlock = new Map<string, SuspiciousEvidence>();
    for (const s of [
      ...findSuspiciousEvidence(blocks, validations),
      ...findOwnershipAmbiguous(ownershipResults),
      ...findArithmeticContradictions(validations, columnRoles, ledger),
    ]) {
      if (s.blockId) suspiciousByBlock.set(s.blockId, s);
    }
    const suspicious = [...suspiciousByBlock.values()];

    // ── Targeted verification — only for flagged occurrences ────────────────
    let verificationTimeMs = 0;
    let verificationResolved = 0;
    let verificationUnresolved = 0;
    if (suspicious.length > 0) {
      const passVerification = await timed(() =>
        runTargetedVerification(imageUrl, suspicious, ledger, lines)
      );
      verificationTimeMs = passVerification.ms;
      const applied = applyVerificationResults(ledger, assignments, suspicious, passVerification.result);
      verificationResolved = applied.resolvedCount;
      verificationUnresolved = applied.unresolvedCount;
      validations = validateAssignments(blocks, assignments, ledger);
    }

    // ── Assemble a provisional payload and reconcile it. Reconciling
    // arithmetic never upgrades an unverified value, and FAILING arithmetic
    // must not be waved through just because each value looked fine in
    // isolation. ──────────────────────────────────────────────────────────────
    let assembled = buildFinalPayload(merchant, currency, lines, blocks, validations, ledger, totalWitness);
    let reconciliation = reconcile(assembled.payload);

    // ── Second-round escalation — reconciliation failure is itself a
    // targeted-verification trigger. Capped at one extra round. ─────────────
    let reconciliationRetried = false;
    if (!reconciliation.reconciles && reconciliation.printedSubtotalMinor !== null) {
      const alreadyChecked = new Set(
        suspicious.map((s) => s.amountId).filter((id): id is string => id !== undefined)
      );
      const reconSuspects = findReconciliationSuspects(blocks, validations, alreadyChecked);
      if (reconSuspects.length > 0) {
        reconciliationRetried = true;
        const passReconVerification = await timed(() =>
          runTargetedVerification(imageUrl, reconSuspects, ledger, lines)
        );
        verificationTimeMs += passReconVerification.ms;
        const applied = applyVerificationResults(ledger, assignments, reconSuspects, passReconVerification.result);
        verificationResolved += applied.resolvedCount;
        verificationUnresolved += applied.unresolvedCount;
        validations = validateAssignments(blocks, assignments, ledger);
        assembled = buildFinalPayload(merchant, currency, lines, blocks, validations, ledger, totalWitness);
        reconciliation = reconcile(assembled.payload);
      }
    }

    const { payload, orphanCount, summaryRoleAssignments, priceKindOverrides, totalWitness: appliedTotalWitness } = assembled;
    payload.date = date;

    // ── Second coverage audit (post-ownership) + final validity ─────────────
    // Reconciliation success is never sufficient on its own: a receipt
    // where a dropped modifier's amount was silently absorbed by a
    // neighbouring item can still reconcile by coincidental cancellation.
    // VALID requires structural coverage, exclusive ownership, and
    // ownership-validation to ALL hold in addition to reconciliation — any
    // one of them failing makes the receipt invalid regardless of the
    // others, and reconciliation is consulted only as one input among
    // several, never as a way to select or excuse an assignment.
    // FIX 33 — the same authoritative-column geometry FIX 11 already
    // computes for ownership matching (matchingLedger, above), handed to
    // coverage.ts so Regra A (descriptive numbers) can test a candidate
    // against the real column band instead of never seeing it at all —
    // the gap FIX 19's own header names as still open.
    const columnContext = { band: detectAuthoritativeColumn(ledger, ocr.lines, new Set()), angle: computeReadingAngle(ocr.lines) };
    let coverage = classifyCoverage(blocks, assignments, ledger, itemsRegionEnd, columnContext, validations, columnRoles);
    const duplicateOwnership = findDuplicateOwnership(assignments);

    // FIX 15 — summary coverage, the same invariant extended to the summary
    // region: a receipt whose item subtotal matches the printed subtotal
    // exactly can still hide an unexplained tax and a wrong grand total (see
    // coverage.ts's own header comment on the Mademoiselle case this fix
    // closes). `itemsRegionEnd` doubles as the summary region's start line —
    // the same boundary buildFinalPayload used internally to build
    // `summaryRoleAssignments`, so both sides agree on where "summary"
    // begins without recomputing the formula twice.
    let summaryCoverage = classifySummaryCoverage(ledger, itemsRegionEnd, summaryRoleAssignments);
    const summaryDuplicateRoles = findSummaryDuplicateRoles(summaryRoleAssignments);
    const ledgerByAmountIdForCharges = new Map(ledger.map((e) => [e.amountId, e]));

    // ── FIX 35 Part 3 — items-region saturation, the mirror of FIX 32
    // Part 2 one region over (see coverage.ts's applyItemsRegionSaturation
    // for the three guards). Runs FIRST, before FIX 34/32's own summary-
    // region rules — both of those gate on itemsRegionUnresolvedCount, and
    // if Part 3 ran after them they would see the STALE, pre-saturation
    // count and refuse even when the items region is now fully explained
    // (caught empirically against the real Sulbarreiro corpus run: items
    // region correctly reached 0 unresolved, but FIX 34/32 still reported
    // provenBlockedBy=items_region_unresolved because they'd already run).
    let itemsRegionSaturation: { applied: boolean; count: number; blockedBy: string | null } = {
      applied: false,
      count: 0,
      blockedBy: null,
    };
    {
      const grandTotalAssignment = summaryRoleAssignments.find((a) => a.role === "GRAND_TOTAL");
      const grandTotalEntry = grandTotalAssignment ? ledgerByAmountIdForCharges.get(grandTotalAssignment.amountId) : undefined;
      const totalValueMinor = grandTotalEntry ? toMinor(grandTotalEntry.value, currency) : null;
      const { coverage: adjustedCoverage, result } = applyItemsRegionSaturation(
        coverage,
        columnRoles,
        ledgerByAmountIdForCharges,
        appliedTotalWitness?.source ?? null,
        totalValueMinor,
        (value: number) => toMinor(value, currency)
      );
      coverage = adjustedCoverage;
      itemsRegionSaturation = result;
    }

    // ── FIX 34 — proven additive charge, the mirror of FIX 32 Part 2 (see
    // coverage.ts's applyProvenAdditiveCharge for the full six-guard
    // rationale). Runs BEFORE FIX 32's own saturation: once a genuine gap
    // between itemSum+charges and the witnessed total is filled by a proven
    // charge, the books may now balance exactly, and any VAT-rate leftovers
    // become FIX 32's job on the very next step ("first this rule, then the
    // other" — the two compose, never run in the other order).
    let itemSumPlusChargesMinorAfterAdditive = assembled.itemSumPlusChargesMinor;
    let provenAdditive: { applied: boolean; count: number; corroboratedByRate: boolean; blockedBy: string | null } = {
      applied: false,
      count: 0,
      corroboratedByRate: false,
      blockedBy: null,
    };
    {
      const grandTotalAssignment = summaryRoleAssignments.find((a) => a.role === "GRAND_TOTAL");
      const grandTotalEntry = grandTotalAssignment ? ledgerByAmountIdForCharges.get(grandTotalAssignment.amountId) : undefined;
      const totalValueMinor = grandTotalEntry ? toMinor(grandTotalEntry.value, currency) : null;
      const itemsRegionUnresolvedCount = coverage.filter((c) => c.state === "UNRESOLVED").length;
      const { coverage: adjustedSummaryCoverage, result } = applyProvenAdditiveCharge(
        summaryCoverage,
        ledgerByAmountIdForCharges,
        appliedTotalWitness?.source ?? null,
        totalValueMinor,
        assembled.itemSumPlusChargesMinor,
        assembled.itemSumMinor,
        itemsRegionUnresolvedCount,
        lines,
        (value: number) => toMinor(value, currency)
      );
      summaryCoverage = adjustedSummaryCoverage;
      provenAdditive = result;

      if (result.applied) {
        // FIX 34 — the proven charge must enter the envelope's own charges
        // sum (the bill-split math needs to know it's a charge to divide),
        // mapped onto the EXISTING RawCharge shape rather than a new
        // schema field. Sign, per the same ledger value's own printed sign,
        // decides fee vs. discount — the only two kinds chargesMinor's own
        // arithmetic (validate.ts) distinguishes by sign.
        const wonAmountIds = new Set(
          adjustedSummaryCoverage.filter((c) => c.role === "PROVEN_ADDITIVE_CHARGE").map((c) => c.amountId)
        );
        let addedMinor = 0;
        for (const amountId of wonAmountIds) {
          const e = ledgerByAmountIdForCharges.get(amountId);
          if (!e) continue;
          const block = blocks.find((b) => b.amountId === amountId);
          payload.charges.push({
            id: amountId,
            name: block?.name ?? "Additional Charge",
            amount: e.value,
            kind: e.value < 0 ? "discount" : "fee",
          });
          const m = toMinor(e.value, currency);
          if (m !== null) addedMinor += e.value < 0 ? -m : m;
        }
        itemSumPlusChargesMinorAfterAdditive = assembled.itemSumPlusChargesMinor + addedMinor;
      }
    }

    // ── FIX 32 Part 2 — arithmetic saturation, now with an independent
    // base (see coverage.ts's applyProvenNonAdditive for the full guard
    // rationale — this is FIX 29's own idea, safe now that FIX 31 gives
    // GRAND_TOTAL a source that never touches itemSum). Runs BEFORE
    // determineSummaryValidity so a receipt whose books already balance
    // against an independently-identified total never gets blocked by its
    // own VAT-rate disclosure table. Uses itemSumPlusChargesMinorAfterAdditive
    // (FIX 34's own updated figure, unchanged when FIX 34 never applied) so
    // a receipt FIX 34 just closed doesn't get refused here by guard 2's
    // now-stale sum.
    let provenNonAdditive: { applied: boolean; count: number; blockedBy: string | null } = {
      applied: false,
      count: 0,
      blockedBy: null,
    };
    {
      const grandTotalAssignment = summaryRoleAssignments.find((a) => a.role === "GRAND_TOTAL");
      const grandTotalEntry = grandTotalAssignment ? ledgerByAmountIdForCharges.get(grandTotalAssignment.amountId) : undefined;
      const totalValueMinor = grandTotalEntry ? toMinor(grandTotalEntry.value, currency) : null;
      const itemsRegionUnresolvedCount = coverage.filter((c) => c.state === "UNRESOLVED").length;
      const { coverage: adjustedSummaryCoverage, result } = applyProvenNonAdditive(
        summaryCoverage,
        ledgerByAmountIdForCharges,
        appliedTotalWitness?.source ?? null,
        totalValueMinor,
        itemSumPlusChargesMinorAfterAdditive,
        itemsRegionUnresolvedCount,
        (value: number) => toMinor(value, currency)
      );
      summaryCoverage = adjustedSummaryCoverage;
      provenNonAdditive = result;
    }

    const summaryValidity = determineSummaryValidity(summaryCoverage, summaryDuplicateRoles);

    // Arithmetic reconciliation AND summary coverage must both hold — this
    // is the single value the rest of the response/logging treats as "did
    // this receipt reconcile", replacing the old arithmetic-only signal.
    // Never compute these independently downstream; a caller checking only
    // reconciliation.reconciles would silently regress to the exact bug
    // this fix closes.
    const finalReconciles = reconciliation.reconciles && summaryValidity.valid;

    const validity = determineValidity(structuralGaps, coverage, duplicateOwnership, validations, finalReconciles);

    const lowConfidenceCount = ledger.filter((e) => e.ocrConfidence < OCR_CONFIDENCE_THRESHOLD).length;

    // FIX 25 — crossingsDetected: how many item/modifier blocks were
    // demoted by the post-hoc crossing check (ownership.ts's
    // detectCrossings). summaryBoundaryPenalties: how many item/modifier
    // blocks still ended up claiming a value at or past itemsRegionEnd
    // anyway — the penalty didn't wall it off because no in-region
    // alternative existed anywhere in the document (Mad God's shape).
    const crossingsDetected = ownershipResults.filter((r) => r.crossingDetected).length;
    const ledgerByAmountIdForDiag = new Map(ledger.map((e) => [e.amountId, e]));
    const summaryBoundaryPenalties = blocks.filter((b) => {
      if (b.kind !== "item" && b.kind !== "modifier") return false;
      if (!b.amountId) return false;
      const entry = ledgerByAmountIdForDiag.get(b.amountId);
      return entry !== undefined && entry.lineIndex >= itemsRegionEnd;
    }).length;

    // ── Structured logging — counts and timings only, never receipt content ─
    console.log(
      JSON.stringify({
        event: "parse_receipt_completed",
        parserVersion: PARSER_VERSION,
        currency: reconciliation.currency,
        itemCount: reconciliation.itemCount,
        unresolvedCount: reconciliation.unresolvedCount,
        printedSubtotal:
          reconciliation.printedSubtotalMinor === null
            ? null
            : toMajor(reconciliation.printedSubtotalMinor, reconciliation.currency),
        calculatedSubtotal: toMajor(
          reconciliation.calculatedSubtotalMinor,
          reconciliation.currency
        ),
        subtotalDelta:
          reconciliation.subtotalDeltaMinor === null
            ? null
            : toMajor(reconciliation.subtotalDeltaMinor, reconciliation.currency),
        printedTotal:
          reconciliation.printedTotalMinor === null
            ? null
            : toMajor(reconciliation.printedTotalMinor, reconciliation.currency),
        // Reconciliation is a supporting signal only — this status reflects
        // arithmetic agreement AND summary coverage, not a claim that every
        // value was verified.
        validationStatus: finalReconciles ? "reconciled" : "needs_review",
        // VALID requires coverage + exclusive ownership + reconciliation
        // ALL together — never reconciliation alone. See coverage.ts.
        valid: validity.valid,
        // FIX 18/19/20 — four numbers instead of one raw "unresolved" count:
        // structuralGapCount is the real health signal (a value outside
        // ANY block's territory at all); echoExactCount is a proven bare
        // duplicate of an already-claimed value; echoMultiplicativeCount is
        // a proven candidate*quantity=claimed relationship (FIX 11's own
        // excluded secondary column, now recognized rather than
        // miscounted, in both its quantity=1 and quantity>1 shapes);
        // genuineOwnershipMissCount (= unresolvedLoadBearingCount, kept
        // under its established name for continuity) is what's actually
        // left unexplained. See coverage.ts's ECHO_OF_CLAIMED_VALUE and
        // ECHO_MULTIPLICATIVE_OF_CLAIMED_VALUE comments.
        structuralGapCount: validity.structuralGapCount,
        // FIX 22 Part 1 — did the structuralGap-triggered retry fire, and
        // what was the gap count immediately before it (null when it never
        // fired). structuralGapCount above already reflects whichever pass
        // won, so this is purely diagnostic: how often retry fires in
        // practice, and by how much it moved the number when it did.
        structureRetryFired,
        structuralGapCountBeforeRetry,
        echoExactCount: validity.echoExactCount,
        echoMultiplicativeCount: validity.echoMultiplicativeCount,
        // FIX 23 — how many items had GPT's own priceKind overridden by the
        // deterministic unit-price-annotation rule (see validate.ts's
        // buildFinalPayload). Purely diagnostic: quantifies how often GPT's
        // signal disagreed with verified arithmetic on this run.
        priceKindOverrideCount: priceKindOverrides.length,
        priceKindOverrides: priceKindOverrides.map((o) => o.name),
        crossingsDetected,
        summaryBoundaryPenalties,
        // FIX 27 — did the raw-OCR constant-offset shape exist at all
        // (offsetFormDetected), and which hypothesis the printed subtotal
        // arbitrated (offsetHypothesisAdopted: H0/H1/AMBIGUOUS). Purely
        // diagnostic; the actual reassignment already happened above.
        offsetFormDetected,
        offsetHypothesisAdopted,
        // FIX 31 — which witness (if any) actually decided printedTotal this
        // run, and whether typography agreed with it. Null when neither
        // witness found a candidate (pre-FIX-31 closure-only path applied).
        totalWitness: appliedTotalWitness?.source ?? null,
        totalWitnessAgreement: appliedTotalWitness?.agreement ?? null,
        // FIX 32 Part 2 — how many summary-region UNRESOLVED values were
        // reclassified PROVEN_NON_ADDITIVE, and which guard refused when it
        // didn't apply. Purely diagnostic.
        provenNonAdditiveCount: provenNonAdditive.count,
        provenNonAdditiveBlockedBy: provenNonAdditive.blockedBy,
        // FIX 34 — how many summary-region UNRESOLVED values were
        // reclassified PROVEN_ADDITIVE_CHARGE, whether a corroborating
        // printed percentage backed it, and which guard refused when it
        // didn't apply. Purely diagnostic.
        provenAdditiveCount: provenAdditive.count,
        additiveCorroboratedByRate: provenAdditive.corroboratedByRate,
        provenAdditiveBlockedBy: provenAdditive.blockedBy,
        // FIX 35 — which items-region column bands were identified
        // (quantity/unit price/total), how many rows Part 2's arithmetic
        // proved, and whether Part 3's saturation applied. Purely diagnostic.
        columnRolesDetected: {
          quantity: columnRoles.quantity !== null,
          unitPrice: columnRoles.unitPrice !== null,
          total: columnRoles.total !== null,
        },
        rowsArithmeticallyProven: validity.rowQuantityProvenCount + validity.rowUnitPriceProvenCount,
        itemsRegionSaturated: itemsRegionSaturation.applied,
        itemsRegionSaturationCount: itemsRegionSaturation.count,
        itemsRegionSaturationBlockedBy: itemsRegionSaturation.blockedBy,
        unresolvedLoadBearingCount: validity.unresolvedLoadBearingCount,
        genuineOwnershipMissCount: validity.unresolvedLoadBearingCount,
        duplicateOwnershipCount: validity.duplicateOwnershipCount,
        ownershipInvalidCount: validity.ownershipInvalidCount,
        // FIX 15 — summary coverage diagnostics. No receipt content, counts
        // only, same discipline as every other field in this log line.
        summaryMonetaryObservationCount: summaryValidity.summaryMonetaryObservationCount,
        summaryClaimedAmountCount: summaryValidity.summaryClaimedAmountCount,
        summaryUnresolvedAmountCount: summaryValidity.summaryUnresolvedAmountCount,
        summaryDuplicateRoleAttemptCount: summaryValidity.summaryDuplicateRoleAttemptCount,
        summaryCoverageValid: summaryValidity.valid,
        // Measurable reliability signals — no fabricated/estimated rates.
        ocrWordCount: ocr.words.length,
        monetaryObservations: ledger.length,
        lowConfidenceObservations: lowConfidenceCount,
        targetedVerifications: suspicious.length,
        reconciliationTriggeredVerification: reconciliationRetried,
        verificationResolved,
        verificationUnresolved,
        unresolvedMonetaryValues: orphanCount,
        userConfirmationsRequired: verificationUnresolved,
        reconciliationFailures: finalReconciles ? 0 : 1,
        // Performance telemetry.
        ocrTimeMs: ocrPass.ms,
        structureTimeMs,
        verificationTimeMs,
        totalParserTimeMs: Date.now() - startedAt,
        // Total external API calls: 1 OCR + 1 semantic on the happy path,
        // plus 1 more if the FIX 22 structural-quality retry fired, plus 1
        // per verification round actually triggered.
        modelCallCount: 2 + (structureRetryFired ? 1 : 0) + (suspicious.length > 0 ? 1 : 0) + (reconciliationRetried ? 1 : 0),
        durationMs: Date.now() - startedAt,
      })
    );

    return jsonResponse({
      // Version marker so the client can tell the structural format from the
      // legacy category-based one during rollout.
      schemaVersion: 2,
      parserVersion: PARSER_VERSION,
      receipt: payload,
      serverReconciliation: {
        // FIX 15 — arithmetic reconciliation AND summary coverage, never
        // arithmetic alone. See coverage.ts's header comment.
        reconciles: finalReconciles,
        subtotalDelta:
          reconciliation.subtotalDeltaMinor === null
            ? null
            : toMajor(reconciliation.subtotalDeltaMinor, reconciliation.currency),
        unresolvedCount: reconciliation.unresolvedCount,
        // Coverage + exclusive ownership + reconciliation, all together —
        // never reconciliation alone. See coverage.ts.
        valid: validity.valid,
      },
    });
  } catch (error) {
    if (error instanceof OpenAIError) {
      console.error("[parse-receipt]", error.message);
      if (error.status === 429) return errorResponse("RATE_LIMITED", 429);
      return errorResponse("PROVIDER_ERROR", 502);
    }
    if (error instanceof OcrError) {
      console.error("[parse-receipt]", error.message);
      return errorResponse("PROVIDER_ERROR", 502);
    }
    console.error(
      "[parse-receipt]",
      error instanceof Error ? error.message : "unknown error"
    );
    return errorResponse("INTERNAL_ERROR", 500);
  }
});
