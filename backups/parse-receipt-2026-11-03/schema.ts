/**
 * Structured-output schema construction for the single semantic pass
 * (structure + price assignment, combined), plus the deterministic
 * eligibility check used to validate its output afterward.
 *
 * Pure TypeScript — no Deno-specific imports.
 */

import type { LedgerEntry } from "./ledger.ts";

// ─── The one semantic pass — structure and assignment combined ────────────
//
// v1 kept structure discovery and price assignment as two separate calls so
// price assignment could be offered a pre-narrowed candidate set per block.
// With one OCR source of truth there is no longer a second probabilistic
// read to guard against by isolating candidates in advance — the model
// receives the full monetary ledger alongside the OCR lines and reports
// blocks with their amountId in one call. The schema's amountId enum (union
// of every ledger ID) remains a fabrication-prevention SAFETY LAYER only,
// exactly as in v1; the actual acceptance gate is the ownership check below,
// applied after the response comes back and each block's own lineIndices
// are known.

export type BlockKind = "item" | "modifier" | "quantity" | "summary" | "unclassified";

export interface StructureBlock {
  blockId: string;
  kind: BlockKind;
  lineIndices: number[];
  parentBlockId: string | null;
  name: string | null;
  amountId: string | null;
  quantity: number | null;
  priceKind: "unit" | "lineTotal" | null;
}

export interface StructureResult {
  merchant: string | null;
  date: string | null;
  currency: string;
  blocks: StructureBlock[];
}

/**
 * OpenAI Structured Outputs schema for the single semantic pass.
 *
 * `lineIndices` is constrained to the enum of line indices that actually
 * exist in this receipt's OCR output — the model cannot report a
 * hallucinated, out-of-range line. This does not by itself guarantee a
 * *correct* choice among the valid ones (a run was observed reporting an
 * item on a real but wrong neighbouring line) — that class of error is
 * caught afterward in ownership.ts, which cross-checks a block's claimed
 * line against what the OCR text at that line actually says, and corrects
 * it by search when they disagree. This enum is defense against the
 * cheaper, purely-invented case; ownership.ts is defense against the
 * subtler valid-but-wrong case.
 */
export function buildStructureSchema(ledger: LedgerEntry[], lineCount: number): Record<string, unknown> {
  const allIds = ledger.map((e) => e.amountId);
  const validLineIndices = Array.from({ length: lineCount }, (_, i) => i);
  return {
    name: "receipt_structure_and_assignment",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["merchant", "date", "currency", "blocks"],
      properties: {
        merchant: { type: ["string", "null"] },
        date: { type: ["string", "null"] },
        currency: { type: "string" },
        blocks: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "blockId",
              "kind",
              "lineIndices",
              "parentBlockId",
              "name",
              "amountId",
              "quantity",
              "priceKind",
            ],
            properties: {
              blockId: { type: "string" },
              kind: {
                type: "string",
                enum: ["item", "modifier", "quantity", "summary", "unclassified"],
              },
              lineIndices: { type: "array", items: { type: "integer", enum: validLineIndices } },
              parentBlockId: { type: ["string", "null"] },
              name: { type: ["string", "null"] },
              amountId: { enum: [...allIds, null] },
              quantity: { type: ["integer", "null"] },
              priceKind: { type: ["string", "null"], enum: ["unit", "lineTotal", null] },
            },
          },
        },
      },
    },
  };
}

/** Renders the full monetary ledger into prompt text — the model chooses an
 *  amountId from this list per block, by line proximity; it never invents a
 *  value. */
export function describeLedgerForPrompt(ledger: LedgerEntry[]): string {
  if (ledger.length === 0) return "(no monetary amounts were detected by OCR on this receipt)";
  return ledger
    .map((e) => `${e.amountId}: ${e.value} (line ${e.lineIndex}, OCR text "${e.rawText}")`)
    .join("\n");
}

// ─── Deterministic ownership validation input ───────────────────────────────
//
// Layout is used as EVIDENCE that a chosen amountId actually belongs to the
// block claiming it — not as a hard universal rule. The model is not
// pre-restricted to this set (there's no longer a second call to restrict
// it for); instead, this same computation is applied AFTER the response
// comes back, in validate.ts, as the acceptance gate.

const NEAR_LINE_RADIUS = 2;
const WIDE_LINE_RADIUS = 6;

export function computeEligibleAmountIds(
  block: StructureBlock,
  ledger: LedgerEntry[]
): string[] {
  if (block.lineIndices.length === 0) return [];
  const minLine = Math.min(...block.lineIndices);
  const maxLine = Math.max(...block.lineIndices);

  const near = ledger.filter(
    (e) => e.lineIndex >= minLine - NEAR_LINE_RADIUS && e.lineIndex <= maxLine + NEAR_LINE_RADIUS
  );
  if (near.length > 0) return near.map((e) => e.amountId);

  const wide = ledger.filter(
    (e) => e.lineIndex >= minLine - WIDE_LINE_RADIUS && e.lineIndex <= maxLine + WIDE_LINE_RADIUS
  );
  return wide.map((e) => e.amountId);
}

// ─── Assignment view over blocks ────────────────────────────────────────────
//
// validate.ts's validation/assembly functions operate on a flat
// {blockId, amountId, quantity, priceKind} shape, unchanged from v1 (where
// it came from a separate Pass 2b response) — here it's just extracted from
// the merged StructureBlock, so those functions need no changes at all.

export interface Assignment {
  blockId: string;
  amountId: string | null;
  quantity: number | null;
  priceKind: "unit" | "lineTotal" | null;
}

export function assignmentsFromBlocks(blocks: StructureBlock[]): Assignment[] {
  return blocks.map((b) => ({
    blockId: b.blockId,
    amountId: b.amountId,
    quantity: b.quantity,
    priceKind: b.priceKind,
  }));
}

/**
 * Resolves an amountId back to its ledger entry. Defense in depth: even
 * though the schema enum should already guarantee a returned ID exists, a
 * provider guarantee is never trusted blindly — this is checked regardless.
 */
export function resolveAmountReference(
  amountId: string | null,
  ledger: LedgerEntry[]
): LedgerEntry | null {
  if (amountId === null) return null;
  return ledger.find((e) => e.amountId === amountId) ?? null;
}
