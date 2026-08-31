import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

/**
 * parse-receipt — structural receipt extraction.
 *
 * The vision model is used strictly as a *reader* of the image. It is never
 * asked to compute totals or to judge whether the receipt is valid: all
 * arithmetic and all validation happen deterministically, here and on the
 * client, in integer minor units.
 *
 * Flow:
 *   image -> pass 1 (structural extraction)
 *         -> deterministic reconciliation
 *         -> pass 2 (targeted re-read) only when pass 1 does not reconcile
 *         -> structured payload for the client pipeline
 */

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const MODEL = "gpt-4o";

// ─── Prompts ──────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You read restaurant receipts from images and return structured JSON.

You are a READER, not a calculator. Never compute or invent totals. Report only
what is printed. If a value is not printed, omit the field.

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

## Reading rules

1. LINE INDEXING. Walk the receipt body top to bottom and number every line
   from 0. Put that index in sourceEvidence.lineIndex, and the verbatim text in
   sourceEvidence.lineText. This is how the app points the user at a problem.

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
   and printedTotal from the receipt verbatim. Do not derive one from another.
   Do not add them up. If the receipt shows no subtotal line, use null.

7. CHARGES. Service, tax, tip, delivery and bag fees are charges, never items.

8. CURRENCY. Return an ISO code. Use location and explicit markers to
   disambiguate: a receipt from Canada showing "$" is CAD; from the USA, USD.
   If genuinely unclear, return your best ISO guess.

9. NUMBERS. Return JSON numbers, not strings, and never with thousands
   separators. Use a dot as the decimal separator.

10. UNCERTAINTY. Use the confidence field honestly. A low confidence on a
    correctly-flagged line is more useful than false certainty.

Return ONLY the JSON object. No markdown, no commentary.`;

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
  amount?: unknown;
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

    // ── Pass 1: structural extraction ────────────────────────────────────────
    const firstPassContent = await callOpenAI(
      SYSTEM_PROMPT,
      [
        { type: "image_url", image_url: { url: imageUrl, detail: "high" } },
        {
          type: "text",
          text:
            "Read this receipt. Report every priced line exactly once. Keep item " +
            "names in their original language.",
        },
      ],
      4000
    );

    let payload: RawPayload;
    try {
      payload = JSON.parse(firstPassContent) as RawPayload;
    } catch {
      return errorResponse("UNREADABLE_RECEIPT", 422);
    }

    if (!Array.isArray(payload.items)) {
      return errorResponse("UNREADABLE_RECEIPT", 422);
    }

    // ── Deterministic reconciliation ─────────────────────────────────────────
    const reconciliation = reconcile(payload);

    // ── Pass 2: targeted re-read, only when pass 1 did not reconcile ─────────
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
