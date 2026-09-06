import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * parse-receipt — two-pass receipt extraction with transcript cross-checking.
 *
 * The vision model is used strictly as a *reader* of the image. It is never
 * asked to compute totals or to judge whether the receipt is valid: all
 * arithmetic and all validation happen deterministically, here and on the
 * client, in integer minor units.
 *
 * A single combined "read and structure" call let the model's structural
 * judgment quietly corrupt a number while it was reading it — the model has
 * no independent record of what it actually saw to check itself against.
 * Splitting the read from the interpretation gives us that independent
 * record for free, without external OCR:
 *
 * Flow:
 *   image -> pass 1 (pure transcription, no interpretation)
 *         -> pass 2 (structure the transcript text into items/charges/etc.)
 *         -> deterministic reconciliation
 *         -> deterministic transcript cross-check (every asserted amount must
 *            appear in pass 1's transcript; every transcribed amount must be
 *            claimed by something in pass 2's output, or it's injected into
 *            unresolvedLines) — this is the independent witness pass 1 buys us
 *         -> pass 3 (targeted corrective re-read of the image) only when
 *            reconciliation still fails after the cross-check
 *         -> structured payload for the client pipeline
 */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RATE_LIMIT_MAX = 20;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
// Pinned to a dated snapshot, not the "gpt-4o" alias: OpenAI documents that
// model behavior can shift between snapshots served under the same alias,
// and recommends pinning a specific snapshot for reproducible results
// (https://platform.openai.com/docs/models/gpt-4o — "Snapshots let you lock
// in a specific version of the model so that performance and behavior
// remain consistent"). gpt-4o-2024-08-06 is the snapshot "gpt-4o" currently
// resolves to (confirmed against OpenAI's model docs). Snapshot swaps
// (2024-11-20, 2024-05-13) were tried against the Khao Soi hallucination
// case and made no difference — reverted here, not worth carrying.
const MODEL = "gpt-4o-2024-08-06";

// ─── Prompts ──────────────────────────────────────────────────────────────────
//
// Deferred (single observed failure on one complex receipt doesn't justify
// this yet — revisit if the transcript cross-check below still lets things
// through more than rarely):
//   - Hybrid OCR (e.g. Tesseract as a second numeric witness) with
//     multi-call voting — infrastructure complexity disproportionate to the
//     problem observed so far, and pass 1's transcript already serves as an
//     independent witness without it.

const TRANSCRIPTION_SYSTEM_PROMPT = `Transcribe every line of this receipt, in order, exactly as printed.

One line per array entry. Include every line, even if it has no price, even if
it looks like a note, a modifier, a header, or unrelated text. Do not group,
merge, skip, reorder, categorize, or interpret anything. Do not add or remove
anything. If a line has an amount, keep the amount exactly as printed on that
same line, in its original format — do not normalize decimal separators,
currency symbols, or spacing.

Return ONLY this JSON object. No markdown, no commentary.
{ "lines": ["...", "...", ...] }`;

const STRUCTURE_SYSTEM_PROMPT = `You turn a plain-text transcription of a restaurant receipt into structured JSON.

You are a READER, not a calculator. Never compute or invent totals. Report only
what is present in the given lines. If a value is not present, omit the field.

## Input

You are given the receipt's lines, already transcribed and numbered starting
at 0 (index = position in the list). Use those exact indices for every
sourceEvidence.lineIndex — never invent a different numbering, and never
reference an index that wasn't given to you.

## Output shape

{
  "merchant": string | null,
  "date": "YYYY-MM-DD" | null,
  "currency": "ISO 4217 code",
  "items": [Item],
  "charges": [Charge],
  "unresolvedLines": [UnresolvedLine],
  "printedSubtotal": number | null,
  "printedServiceCharge": number | null,
  "printedTax": number | null,
  "printedTip": number | null,
  "printedDiscount": number | null,
  "printedTotal": number | null
}

Item {
  "id": string,
  "name": string,              // original language, as printed
  "quantity": integer,         // default 1
  "unitPrice": number | null,  // price of ONE unit, excluding modifiers
  "baseLineTotal": number|null,// printed line total, excluding modifiers
  "modifiers": [Modifier],
  "discount": number | null,
  "category": "starters"|"mains"|"drinks"|"desserts"|"others",
  "sourceEvidence": { "lineIndex": integer, "lineText": string },
  "confidence": 0..1
}

Modifier {
  "id": string,
  "name": string,
  "price": number | null,
  "kind": "paid" | "free",
  "sourceEvidence": { "lineIndex": integer, "lineText": string, "parentLineIndex": integer }
}

Charge { "id": string, "name": string, "amount": number,
         "kind": "service"|"tax"|"tip"|"discount"|"delivery"|"bag"|"other" }

UnresolvedLine { "id": string, "amount": number, "text": string,
                 "lineIndex": integer, "nearestItemLineIndex": integer|null }

## Rules

1. LINE REFERENCES. sourceEvidence.lineIndex must be one of the indices given
   to you. sourceEvidence.lineText must be copied EXACTLY, character for
   character, from the line at that index — never retype, paraphrase, or
   "correct" it, even if it looks wrong. This field is checked mechanically
   against the original transcript, not against your judgment.

2. ITEMS vs MODIFIERS. An indented or unnumbered line directly beneath an item
   line is a modifier of that item, not a new item.
     - Modifier WITH a price  -> kind "paid", set price.
     - Modifier WITHOUT price -> kind "free", price null.
   Set parentLineIndex to the line index of the item it belongs to.

3. PARENT LINE WITH NO PRICE. When an item line shows no price and the line
   below it carries one, the price belongs to the parent item: put it in the
   parent's unitPrice or baseLineTotal. Do not emit a separate item.
   Example:
       1 Pad Gra Prow
         PGP Chicken          23.00
   -> one item, name "Pad Gra Prow", unitPrice 23.00, with a free modifier
      "PGP Chicken".

4. NEVER DROP A PRICED LINE. Every line carrying an amount must appear in the
   output exactly once: as an item, a modifier, a charge, a printed total
   field, or an entry in unresolvedLines. If you cannot decide where a priced
   line belongs, put it in unresolvedLines with its lineIndex and the index of
   the item line above it. This is expected and useful — it is far better than
   guessing or omitting.
   This includes short or numeric-looking labels: a bare line such as
       10                     10.50
   is a priced line and must be reported.

5. QUANTITIES. "2 x Beer  18.00" means quantity 2 and unitPrice 9.00. When only
   a line total is printed, set baseLineTotal and leave unitPrice null rather
   than dividing it yourself.

6. TOTALS. Copy printedSubtotal, printedServiceCharge, printedTax, printedTip
   and printedTotal from the transcript verbatim. Do not derive one from
   another. Do not add them up. If not present, use null.

7. CHARGES. Service, tax, tip, delivery and bag fees are charges, never items.

8. CURRENCY. Return an ISO code. Use merchant name/address and explicit
   markers to disambiguate a bare currency symbol.

9. NUMBERS. Return JSON numbers, not strings, and never with thousands
   separators. Use a dot as the decimal separator, regardless of how the
   original line printed it.

10. UNCERTAINTY. Use the confidence field honestly. A low confidence on a
    correctly-flagged line is more useful than false certainty.

Return ONLY the JSON object. No markdown, no commentary.`;

// Naming note: this is "pass 3" in the module doc-comment's flow (transcribe
// -> structure -> reconcile+cross-check -> corrective re-read), but keeps its
// original "second pass" identifiers here since those names are also the
// response's field names (secondPassTriggered, secondPassCorrections).
const SECOND_PASS_SYSTEM_PROMPT = `You are re-examining ONE specific discrepancy on a receipt image.

A first reading of this receipt did not add up. You are given the first reading,
the printed subtotal, the calculated subtotal, and the exact difference.

Re-read ONLY the region of the receipt relevant to the discrepancy. Determine
which of the following explains it:
  - a missing item
  - a missing paid modifier
  - an incorrect price
  - an incorrect quantity
  - a line attributed to the wrong parent item
  - a duplicated line

Return JSON:

{
  "corrections": [
    {
      "type": "missing_paid_modifier" | "missing_item" | "incorrect_item_price"
            | "incorrect_quantity" | "wrong_parent_item" | "possible_duplicate",
      "itemId": string | null,
      "name": string | null,
      "amount": number | null,
      "quantity": integer | null,
      "lineText": string | null,
      "confidence": 0..1,
      "explanation": string
    }
  ]
}

Rules:
- Do not modify values unrelated to the discrepancy.
- Do not invent a correction to force the numbers to match. If you cannot see
  the cause, return an empty corrections array.
- Report confidence honestly; the app will not auto-apply a low-confidence
  correction.
- Return ONLY the JSON object.`;

// ─── Minimal exact money helpers ──────────────────────────────────────────────
// The client owns the full reconciliation engine. The server needs just enough
// exact arithmetic to decide whether a second pass is warranted and to log the
// outcome — done in integer minor units so the decision is never made on
// floating point noise.

const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "CLP", "ISK"]);

function scaleFor(currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 1 : 100;
}

function toMinor(value: unknown, currency: string): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const scaled = value * scaleFor(currency);
    const rounded = scaled < 0 ? -Math.round(Math.abs(scaled)) : Math.round(scaled);
    return Number.isSafeInteger(rounded) ? rounded : null;
  }
  if (typeof value === "string") {
    const cleaned = value.replace(/[^0-9.,-]/g, "").trim();
    if (cleaned.length === 0) return null;
    const normalized = cleaned.replace(",", ".");
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed)) return null;
    return toMinor(parsed, currency);
  }
  return null;
}

function toMajor(minor: number, currency: string): number {
  return minor / scaleFor(currency);
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface RawModifier {
  id?: string;
  name?: string;
  price?: unknown;
  kind?: string;
}

interface RawItem {
  id?: string;
  name?: string;
  quantity?: unknown;
  unitPrice?: unknown;
  baseLineTotal?: unknown;
  discount?: unknown;
  modifiers?: RawModifier[];
}

interface RawCharge {
  amount?: unknown;
  kind?: string;
}

interface RawUnresolvedLine {
  id?: unknown;
  amount?: unknown;
  text?: unknown;
  lineIndex?: unknown;
  nearestItemLineIndex?: unknown;
}

interface RawPayload {
  currency?: unknown;
  items?: RawItem[];
  charges?: RawCharge[];
  unresolvedLines?: RawUnresolvedLine[];
  printedSubtotal?: unknown;
  printedTotal?: unknown;
  [key: string]: unknown;
}

// ─── Transcript-based evidence validation ─────────────────────────────────────
//
// Pass 1's transcript is an independent witness: pass 2 never gets to
// "correct" it, only reference it. Any amount pass 2 asserts must actually
// appear somewhere in the transcript, and any amount the transcript contains
// must end up claimed by something in pass 2's output (or be surfaced as an
// unresolved line) — nothing may vanish or be invented silently between the
// two passes.

interface TranscribedAmount {
  value: number;
  lineIndex: number;
  lineText: string;
}

/**
 * Parses a money-shaped token (e.g. "23.75", "1,234.56", "23,75", "(4.50)")
 * into a major-unit number. Only tokens with an exact 2-digit fraction are
 * matched by the caller's regex, so the last separator is always decimal.
 */
function parseMoneyToken(raw: string): number | null {
  let text = raw.trim();
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (text.startsWith("-")) {
    negative = true;
    text = text.slice(1);
  }
  const sepIndex = Math.max(text.lastIndexOf("."), text.lastIndexOf(","));
  if (sepIndex === -1) return null;
  const integerPart = text.slice(0, sepIndex).replace(/[.,]/g, "");
  const fractionPart = text.slice(sepIndex + 1);
  if (!/^\d+$/.test(integerPart) || !/^\d{2}$/.test(fractionPart)) return null;
  const value = Number(`${integerPart}.${fractionPart}`);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

// Matches a run of digits (with optional thousands separators) ending in a
// 2-digit fraction — deliberately excludes bare integers (quantities, piece
// counts) to keep this a money-only witness, not a generic number extractor.
const MONEY_TOKEN_PATTERN = /-?\(?\d{1,3}(?:[.,]\d{3})*[.,]\d{2}\)?/g;

function extractMoneyFromLines(lines: string[]): TranscribedAmount[] {
  const results: TranscribedAmount[] = [];
  lines.forEach((lineText, lineIndex) => {
    const matches = lineText.match(MONEY_TOKEN_PATTERN);
    if (!matches) return;
    for (const raw of matches) {
      const value = parseMoneyToken(raw);
      if (value !== null) results.push({ value, lineIndex, lineText });
    }
  });
  return results;
}

// Magnitude only: item-level discounts are stored as a positive amount by
// convention (see lib/receipt/model.ts) but the printed line often shows a
// visually negative token ("-5.00", "(5.00)") — comparing absolute values
// sidesteps that sign-convention mismatch instead of false-flagging it.
function centsOf(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(Math.abs(value) * 100);
}

interface TranscriptValidation {
  /** Count only — never log the values/names themselves (receipt content). */
  hallucinationCount: number;
  addedUnresolvedCount: number;
}

/**
 * Cross-checks every monetary value pass 2 asserted against pass 1's
 * transcript, mutating `payload` in place:
 *   - A value with no match in the transcript is nulled out (treated as
 *     "unreadable", which the existing reconciliation/second-pass machinery
 *     already knows how to react to) rather than shipped as a confident lie.
 *   - A transcribed amount that ends up unclaimed by anything in the output
 *     is appended to unresolvedLines, so it surfaces to the user instead of
 *     disappearing.
 * Matching is multiset-based (a value printed twice must be claimed twice)
 * so a duplicate value doesn't mask one hallucinated instance of it.
 */
function validateAgainstTranscript(
  payload: RawPayload,
  transcript: TranscribedAmount[]
): TranscriptValidation {
  const pool = new Map<number, TranscribedAmount[]>();
  for (const t of transcript) {
    const c = centsOf(t.value);
    if (c === null) continue;
    const list = pool.get(c);
    if (list) list.push(t);
    else pool.set(c, [t]);
  }

  let hallucinationCount = 0;

  // Non-generic and cast at each call site on purpose: RawItem/RawModifier/
  // RawCharge have no index signature, so a generic `keyof T` helper would
  // not type-check against them the way it does against RawPayload.
  const claimOrNull = (obj: Record<string, unknown>, key: string): void => {
    const value = obj[key];
    if (typeof value !== "number") return;
    const c = centsOf(value);
    const list = c === null ? undefined : pool.get(c);
    if (list && list.length > 0) {
      list.shift();
    } else {
      hallucinationCount += 1;
      obj[key] = null;
    }
  };

  for (const item of payload.items ?? []) {
    const itemRecord = item as unknown as Record<string, unknown>;
    claimOrNull(itemRecord, "unitPrice");
    claimOrNull(itemRecord, "baseLineTotal");
    claimOrNull(itemRecord, "discount");
    for (const modifier of item.modifiers ?? []) {
      if (modifier.kind === "free") continue;
      claimOrNull(modifier as unknown as Record<string, unknown>, "price");
    }
  }

  for (const charge of payload.charges ?? []) {
    claimOrNull(charge as unknown as Record<string, unknown>, "amount");
  }

  // Already-unresolved amounts are legitimately accounted for — they're
  // surfaced to the user already, just not attributed to anything specific.
  for (const line of payload.unresolvedLines ?? []) {
    const c = centsOf(line.amount);
    const list = c === null ? undefined : pool.get(c);
    if (list && list.length > 0) list.shift();
  }

  for (const key of [
    "printedSubtotal",
    "printedServiceCharge",
    "printedTax",
    "printedTip",
    "printedDiscount",
    "printedTotal",
  ] as const) {
    claimOrNull(payload, key);
  }

  // Reverse check: whatever is left unclaimed in the pool was transcribed but
  // never accounted for anywhere in pass 2's output.
  const addedUnresolvedLines: RawUnresolvedLine[] = [];
  for (const occurrences of pool.values()) {
    for (const occ of occurrences) {
      addedUnresolvedLines.push({
        id: `evidence_${occ.lineIndex}_${addedUnresolvedLines.length}`,
        amount: occ.value,
        text: occ.lineText,
        lineIndex: occ.lineIndex,
      });
    }
  }
  if (addedUnresolvedLines.length > 0) {
    payload.unresolvedLines = [
      ...(Array.isArray(payload.unresolvedLines) ? payload.unresolvedLines : []),
      ...addedUnresolvedLines,
    ];
  }

  return {
    hallucinationCount,
    addedUnresolvedCount: addedUnresolvedLines.length,
  };
}

// ─── Server-side reconciliation (for logging and second-pass gating) ──────────

interface ServerReconciliation {
  currency: string;
  itemCount: number;
  calculatedSubtotalMinor: number;
  printedSubtotalMinor: number | null;
  subtotalDeltaMinor: number | null;
  printedTotalMinor: number | null;
  unresolvedCount: number;
  reconciles: boolean;
}

function reconcile(payload: RawPayload): ServerReconciliation {
  const currency =
    typeof payload.currency === "string" && payload.currency.trim().length > 0
      ? payload.currency.trim().toUpperCase()
      : "EUR";

  const items = Array.isArray(payload.items) ? payload.items : [];
  let subtotalMinor = 0;

  for (const item of items) {
    const quantityRaw =
      typeof item.quantity === "number" ? Math.round(item.quantity) : 1;
    const quantity = Number.isFinite(quantityRaw) && quantityRaw >= 1 ? quantityRaw : 1;

    const unit = toMinor(item.unitPrice, currency);
    const lineTotal = toMinor(item.baseLineTotal, currency);

    let base = 0;
    if (unit !== null) base = unit * quantity;
    else if (lineTotal !== null) base = lineTotal;

    let modifiers = 0;
    for (const modifier of item.modifiers ?? []) {
      if (modifier.kind === "free") continue;
      const price = toMinor(modifier.price, currency);
      if (price !== null) modifiers += price;
    }

    const discount = toMinor(item.discount, currency) ?? 0;
    subtotalMinor += base + modifiers - Math.abs(discount);
  }

  const printedSubtotalMinor = toMinor(payload.printedSubtotal, currency);
  const printedTotalMinor = toMinor(payload.printedTotal, currency);
  const unresolved = Array.isArray(payload.unresolvedLines)
    ? payload.unresolvedLines
    : [];

  const subtotalDeltaMinor =
    printedSubtotalMinor === null ? null : printedSubtotalMinor - subtotalMinor;

  const reconciles =
    subtotalDeltaMinor !== null &&
    subtotalDeltaMinor === 0 &&
    unresolved.length === 0;

  return {
    currency,
    itemCount: items.length,
    calculatedSubtotalMinor: subtotalMinor,
    printedSubtotalMinor,
    subtotalDeltaMinor,
    printedTotalMinor,
    unresolvedCount: unresolved.length,
    reconciles,
  };
}

// ─── Suspicious-candidate selection for the second pass ───────────────────────

interface SuspiciousCandidate {
  itemId?: string;
  name?: string;
  amount?: number;
  reason: string;
}

/**
 * Pick the lines worth re-reading. Keeping this list short keeps the second
 * pass focused on the discrepancy instead of re-parsing the whole receipt.
 */
function selectSuspicious(
  payload: RawPayload,
  reconciliation: ServerReconciliation
): SuspiciousCandidate[] {
  const candidates: SuspiciousCandidate[] = [];
  const { currency } = reconciliation;

  for (const line of payload.unresolvedLines ?? []) {
    const amount = toMinor(line.amount, currency);
    candidates.push({
      amount: amount === null ? undefined : toMajor(amount, currency),
      reason: "priced line not attributed to any item",
    });
  }

  for (const item of payload.items ?? []) {
    if (toMinor(item.unitPrice, currency) === null &&
        toMinor(item.baseLineTotal, currency) === null) {
      candidates.push({
        itemId: item.id,
        name: item.name,
        reason: "item has no readable price",
      });
      continue;
    }
    for (const modifier of item.modifiers ?? []) {
      if (modifier.kind === "paid" && toMinor(modifier.price, currency) === null) {
        candidates.push({
          itemId: item.id,
          name: `${item.name ?? "item"} / ${modifier.name ?? "modifier"}`,
          reason: "paid modifier has no readable price",
        });
      }
    }
  }

  const delta = reconciliation.subtotalDeltaMinor;
  if (delta !== null && delta !== 0) {
    for (const item of payload.items ?? []) {
      const unit = toMinor(item.unitPrice, currency);
      if (unit === null) continue;
      // An item whose price is off by exactly the delta is worth a second look.
      if (Math.abs(delta) === Math.abs(unit)) {
        candidates.push({
          itemId: item.id,
          name: item.name,
          amount: toMajor(unit, currency),
          reason: "price equals the unexplained difference",
        });
      }
    }
  }

  return candidates.slice(0, 8);
}

// ─── OpenAI calls ─────────────────────────────────────────────────────────────

interface OpenAIMessageContent {
  type: string;
  [key: string]: unknown;
}

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
  maxTokens: number
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
      response_format: { type: "json_object" },
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

interface SecondPassCorrection {
  type?: string;
  itemId?: string | null;
  name?: string | null;
  amount?: number | null;
  quantity?: number | null;
  lineText?: string | null;
  confidence?: number | null;
  explanation?: string | null;
}

async function runSecondPass(
  imageUrl: string,
  payload: RawPayload,
  reconciliation: ServerReconciliation
): Promise<SecondPassCorrection[]> {
  const { currency, subtotalDeltaMinor, calculatedSubtotalMinor, printedSubtotalMinor } =
    reconciliation;

  const suspicious = selectSuspicious(payload, reconciliation);

  const brief = {
    currency,
    printedSubtotal:
      printedSubtotalMinor === null ? null : toMajor(printedSubtotalMinor, currency),
    calculatedSubtotal: toMajor(calculatedSubtotalMinor, currency),
    difference:
      subtotalDeltaMinor === null ? null : toMajor(subtotalDeltaMinor, currency),
    suspicious,
    items: (payload.items ?? []).map((item) => ({
      id: item.id,
      name: item.name,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      modifiers: (item.modifiers ?? []).map((modifier) => ({
        name: modifier.name,
        price: modifier.price,
        kind: modifier.kind,
      })),
    })),
  };

  const content = await callOpenAI(
    SECOND_PASS_SYSTEM_PROMPT,
    [
      { type: "image_url", image_url: { url: imageUrl, detail: "high" } },
      {
        type: "text",
        text:
          `The parsed subtotal does not match the printed subtotal.\n\n` +
          `${JSON.stringify(brief, null, 2)}\n\n` +
          `Re-examine only the relevant region and report what explains the ` +
          `difference.`,
      },
    ],
    1500
  );

  try {
    const parsed = JSON.parse(content);
    const corrections = parsed?.corrections;
    return Array.isArray(corrections) ? corrections : [];
  } catch {
    return [];
  }
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
    if (OPENAI_API_KEY.length === 0) {
      console.error("[parse-receipt] OPENAI_API_KEY is not configured");
      return errorResponse("NOT_CONFIGURED", 500);
    }

    const imageUrl = image.startsWith("data:")
      ? image
      : `data:image/jpeg;base64,${image}`;

    // ── Pass 1: pure transcription, no interpretation ────────────────────────
    const transcriptionContent = await callOpenAI(
      TRANSCRIPTION_SYSTEM_PROMPT,
      [{ type: "image_url", image_url: { url: imageUrl, detail: "high" } }],
      2500
    );

    let lines: string[];
    try {
      const parsedTranscript = JSON.parse(transcriptionContent);
      lines = Array.isArray(parsedTranscript?.lines)
        ? parsedTranscript.lines.filter((l: unknown): l is string => typeof l === "string")
        : [];
    } catch {
      return errorResponse("UNREADABLE_RECEIPT", 422);
    }
    if (lines.length === 0) {
      return errorResponse("UNREADABLE_RECEIPT", 422);
    }

    // ── Pass 2: structure the transcript text (no image) into items/charges ──
    const numberedLines = lines.map((line, i) => `${i}: ${line}`).join("\n");
    const structureContent = await callOpenAI(
      STRUCTURE_SYSTEM_PROMPT,
      [
        {
          type: "text",
          text: `Transcribed receipt lines (index: text):\n\n${numberedLines}`,
        },
      ],
      4000
    );

    let payload: RawPayload;
    try {
      payload = JSON.parse(structureContent) as RawPayload;
    } catch {
      return errorResponse("UNREADABLE_RECEIPT", 422);
    }

    if (!Array.isArray(payload.items)) {
      return errorResponse("UNREADABLE_RECEIPT", 422);
    }

    // ── Deterministic transcript cross-check ─────────────────────────────────
    // Pass 1's transcript is the independent witness pass 2 is checked
    // against: any asserted amount pass 2 can't back with a transcript line
    // is nulled (treated as unreadable, not shipped as a confident lie), and
    // any transcribed amount pass 2 left unclaimed is surfaced as an
    // unresolved line instead of silently disappearing.
    const transcribedAmounts = extractMoneyFromLines(lines);
    const evidence = validateAgainstTranscript(payload, transcribedAmounts);

    // ── Deterministic reconciliation ─────────────────────────────────────────
    const reconciliation = reconcile(payload);

    // ── Pass 3: targeted corrective re-read, only if still not reconciled ────
    let secondPassCorrections: SecondPassCorrection[] = [];
    let secondPassTriggered = false;

    if (!reconciliation.reconciles && reconciliation.printedSubtotalMinor !== null) {
      secondPassTriggered = true;
      try {
        secondPassCorrections = await runSecondPass(
          imageUrl,
          payload,
          reconciliation
        );
      } catch (error) {
        // A failed second pass must not fail the request: the client can still
        // reconcile and let the user correct manually.
        console.error(
          "[parse-receipt] second pass failed:",
          error instanceof Error ? error.message : "unknown"
        );
      }
    }

    const topCorrection = secondPassCorrections[0];

    // ── Structured logging (no image data, no personal information) ──────────
    console.log(
      JSON.stringify({
        event: "parse_receipt_completed",
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
        validationStatus: reconciliation.reconciles ? "reconciled" : "needs_review",
        transcriptLineCount: lines.length,
        // Counts only — never the values/names themselves (receipt content).
        evidenceHallucinationCount: evidence.hallucinationCount,
        evidenceAddedUnresolvedCount: evidence.addedUnresolvedCount,
        secondPassTriggered,
        correctionCount: secondPassCorrections.length,
        topCorrectionType: topCorrection?.type ?? null,
        topCorrectionConfidence: topCorrection?.confidence ?? null,
        durationMs: Date.now() - startedAt,
      })
    );

    return jsonResponse({
      // Version marker so the client can tell the structural format from the
      // legacy category-based one during rollout.
      schemaVersion: 2,
      receipt: payload,
      serverReconciliation: {
        reconciles: reconciliation.reconciles,
        subtotalDelta:
          reconciliation.subtotalDeltaMinor === null
            ? null
            : toMajor(reconciliation.subtotalDeltaMinor, reconciliation.currency),
        unresolvedCount: reconciliation.unresolvedCount,
      },
      // Suggestions only. Never applied without explicit user confirmation.
      secondPassCorrections,
    });
  } catch (error) {
    if (error instanceof OpenAIError) {
      console.error("[parse-receipt]", error.message);
      if (error.status === 429) return errorResponse("RATE_LIMITED", 429);
      return errorResponse("PROVIDER_ERROR", 502);
    }
    console.error(
      "[parse-receipt]",
      error instanceof Error ? error.message : "unknown error"
    );
    return errorResponse("INTERNAL_ERROR", 500);
  }
});




