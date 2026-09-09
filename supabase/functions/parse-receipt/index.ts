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
  buildFinalPayload,
  OCR_CONFIDENCE_THRESHOLD,
  type SuspiciousEvidence,
} from "./validate.ts";
import { computeGeometricOwnership, type PriceBlockInput } from "./ownership.ts";
import { filterToAuthoritativeColumn } from "./columns.ts";
import {
  computeItemsRegionEnd,
  findStructuralGaps,
  classifyCoverage,
  findDuplicateOwnership,
  determineValidity,
} from "./coverage.ts";
import { reconcile, toMajor } from "./reconcile.ts";

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
    const ocrPass = await timed(() => callGoogleVision(GOOGLE_CLOUD_API_KEY, base64Content, OCR_LANGUAGE_HINTS));
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
    const passStructure = await timed(() =>
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

    let merchant: string | null = null;
    let date: string | null = null;
    let currency = "EUR";
    let blocks: StructureBlock[] = [];
    try {
      const parsedStructure = JSON.parse(passStructure.result);
      merchant = typeof parsedStructure?.merchant === "string" ? parsedStructure.merchant : null;
      date = typeof parsedStructure?.date === "string" ? parsedStructure.date : null;
      currency =
        typeof parsedStructure?.currency === "string" && parsedStructure.currency.trim().length > 0
          ? parsedStructure.currency.trim().toUpperCase()
          : "EUR";
      blocks = Array.isArray(parsedStructure?.blocks) ? parsedStructure.blocks : [];
    } catch {
      return errorResponse("UNREADABLE_RECEIPT", 422);
    }
    if (blocks.length === 0) {
      return errorResponse("UNREADABLE_RECEIPT", 422);
    }

    // Defense in depth: the schema enum should already make an out-of-range
    // lineIndex impossible, but a provider guarantee is never trusted
    // blindly — drop anything outside the real document instead of letting
    // it corrupt downstream geometry lookups.
    for (const block of blocks) {
      block.lineIndices = block.lineIndices.filter((i) => i >= 0 && i < ocr.lines.length);
    }

    // ── Structural coverage audit (pre-ownership) — a line in the items
    // region carrying a monetary token that no block claims at all must
    // never be silently treated as if it didn't exist. This is checked
    // BEFORE price ownership runs, so ownership never gets a chance to
    // paper over a gap the semantic pass left. ──────────────────────────────
    const itemsRegionEnd = computeItemsRegionEnd(blocks);
    const structuralGaps = findStructuralGaps(blocks, ledger, itemsRegionEnd);

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
    const ownershipResults = computeGeometricOwnership(ownershipInputs, matchingLedger, ocr.lines);
    const ownershipByBlock = new Map(ownershipResults.map((r) => [r.blockId, r]));
    for (const block of blocks) {
      const owned = ownershipByBlock.get(block.blockId);
      if (owned) block.amountId = owned.amountId;
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
    const suspiciousByBlock = new Map<string, SuspiciousEvidence>();
    for (const s of [...findSuspiciousEvidence(blocks, validations), ...findOwnershipAmbiguous(ownershipResults)]) {
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
    let assembled = buildFinalPayload(merchant, currency, lines, blocks, validations, ledger);
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
        assembled = buildFinalPayload(merchant, currency, lines, blocks, validations, ledger);
        reconciliation = reconcile(assembled.payload);
      }
    }

    const { payload, orphanCount } = assembled;
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
    const coverage = classifyCoverage(blocks, assignments, ledger, itemsRegionEnd);
    const duplicateOwnership = findDuplicateOwnership(assignments);
    const validity = determineValidity(structuralGaps, coverage, duplicateOwnership, validations, reconciliation.reconciles);

    const lowConfidenceCount = ledger.filter((e) => e.ocrConfidence < OCR_CONFIDENCE_THRESHOLD).length;

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
        // arithmetic agreement, not a claim that every value was verified.
        validationStatus: reconciliation.reconciles ? "reconciled" : "needs_review",
        // VALID requires coverage + exclusive ownership + reconciliation
        // ALL together — never reconciliation alone. See coverage.ts.
        valid: validity.valid,
        structuralGapCount: validity.structuralGapCount,
        unresolvedLoadBearingCount: validity.unresolvedLoadBearingCount,
        duplicateOwnershipCount: validity.duplicateOwnershipCount,
        ownershipInvalidCount: validity.ownershipInvalidCount,
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
        reconciliationFailures: reconciliation.reconciles ? 0 : 1,
        // Performance telemetry.
        ocrTimeMs: ocrPass.ms,
        structureTimeMs: passStructure.ms,
        verificationTimeMs,
        totalParserTimeMs: Date.now() - startedAt,
        // Total external API calls: 1 OCR + 1 semantic on the happy path,
        // plus 1 per verification round actually triggered.
        modelCallCount: 2 + (suspicious.length > 0 ? 1 : 0) + (reconciliationRetried ? 1 : 0),
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
        reconciles: reconciliation.reconciles,
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
