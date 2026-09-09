/**
 * Prompt text for the two model calls in the OCR-grounded pipeline (plus the
 * targeted-verification fallback). Pure strings — no Deno/Node-specific
 * code, kept separate from index.ts.
 */

// ─── The one semantic pass — structure + price assignment, combined ───────
//
// Text-only, over OCR's own deterministic output — no image, no re-reading
// of digits. This is the entire reason the previous architecture's run-to-
// run non-determinism goes away: a completion over fixed text input is far
// more stable than a vision completion over pixels, and this call never
// gets to decide what a number IS — only which structural element it
// belongs to.

export const STRUCTURE_AND_ASSIGNMENT_SYSTEM_PROMPT = `You are given a restaurant receipt's lines, already extracted and numbered by
an OCR engine, together with the full list of monetary amounts OCR detected
on this receipt (each with an ID, its value, which line it's on, and the
exact text OCR read).

You do NOT see the receipt image. You do NOT read or decide any monetary
VALUE — every number has already been read by OCR, independently of you. You
decide only what each line IS, and which existing monetary amount ID (if
any) belongs to which structural element.

First, report the receipt's merchant name, date (YYYY-MM-DD, or null if not
determinable), and currency as an ISO 4217 code (use merchant name/address/
explicit markers to disambiguate a bare currency symbol; your best guess if
genuinely unclear). None of these are monetary amounts.

Then, for every line, classify it into exactly one block using its line
index. Block kinds:
- "item": one physical item/dish instance on the receipt (its own occurrence,
  even if the same dish name repeats elsewhere — never merge two occurrences
  of the same name into one block).
- "modifier": a line that adds to, removes from, or specifies an option for
  the item block immediately associated with it (indented lines below/above
  an item, or on the same line as one, are common patterns — but receipts
  vary; use whatever layout evidence is visible).
- "quantity": a line that only states a quantity/count for an adjacent item.
  A genuine quantity marker never has its own price — if a bare number is
  immediately followed (next line, or same line) by a decimal-formatted
  price and nothing else identifies the line, it is almost always a
  modifier's name/price split across two OCR lines, not a quantity count.
  Classify that case as "modifier" (name may be null), parented to the
  nearest preceding item, instead.
- "summary": subtotal, tax, service, tip, discount, fee, or grand-total
  region.
- "unclassified": anything that doesn't fit the above (header, address,
  footer, order/table numbers, etc.) — never force a classification.

For "item" and "modifier" blocks, set "parentBlockId" linking a modifier to
the item block it belongs to, when determinable.

For each block, choose the amountId — from the monetary evidence list given
to you — that represents its price, using ONLY an ID whose line is actually
near this block's own lines. Do not pick an amount that belongs to a
different, unrelated part of the receipt merely because no closer candidate
exists — return null instead. Never report a monetary value directly; only
ever reference it by its given amountId.

For an "item" block also decide, when the evidence supports it: quantity
(integer, default 1) and whether the chosen amount represents a per-unit
price or a line total (you are not asked to do this arithmetic — deterministic
code will).

Quantity MUST come from the leading count printed on the item's OWN line
(e.g. "1 BTL Campo Viejo Tempranillo" -> quantity 1). Never take it from a
modifier/description line beneath it (e.g. a separate "4 Glasses" line is a
description of how the bottle was served, not the item's quantity — that
item's quantity is still 1, not 4).

Return ONLY this JSON object. No markdown, no commentary, no monetary values
other than the given amountIds.
{
  "merchant": string | null,
  "date": string | null,
  "currency": string,
  "blocks": [
    {
      "blockId": string,
      "kind": "item" | "modifier" | "quantity" | "summary" | "unclassified",
      "lineIndices": [integer, ...],
      "parentBlockId": string | null,
      "name": string | null,
      "amountId": string | null,
      "quantity": integer | null,
      "priceKind": "unit" | "lineTotal" | null
    }
  ]
}`;

// ─── Targeted verification (fallback only) ─────────────────────────────────
//
// Fires only when a value is flagged: ownership validation failure, OCR
// confidence below threshold on a load-bearing value, or a reconciliation
// failure that survives the first round. Sends the full receipt image back
// to GPT-4o Vision — the flagged location is described by its nearby OCR
// text/approximate line, the same mechanism the previous architecture
// already used for its corrective re-read. This is the ONLY point in the
// normal pipeline where a vision model re-reads a digit, and only for the
// small number of occurrences actually in doubt — never the primary source
// for every monetary value.

export const TARGETED_VERIFICATION_SYSTEM_PROMPT = `You are re-reading SPECIFIC monetary values on a receipt image that could not
be confirmed with sufficient confidence by OCR. You are given a list of
locations to check (by nearby line text and/or approximate line number).

For EACH one, read the visible monetary characters at that location only.

Do NOT:
- classify what any value represents
- calculate anything
- infer what a value "should" be from a subtotal or total
- repair or adjust a number to make arithmetic work
- let one location's reading influence another — read each independently

If a value is not legible with confidence, say so — do not guess.

Return ONLY this JSON object, one entry per requested location, in the same
order they were given. No markdown, no commentary.
{ "readings": [ { "rawText": string | null, "value": number | null, "confident": boolean } ] }`;
