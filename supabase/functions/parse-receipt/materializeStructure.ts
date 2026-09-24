/**
 * FIX 41 — the deterministic segment of the pipeline that turns ONE
 * structuring pass's raw blocks into a resolved, user-relevant structure:
 * geometric ownership (FIX 11), constant-offset arbitration (FIX 27), and
 * final payload assembly. Extracted from index.ts (and mirrored previously
 * in scripts/debug-parse-receipt.ts) so both the production single-read
 * path and this round's double-read comparison call the EXACT same code —
 * never two hand-kept-in-sync copies.
 *
 * Nothing in this file is new logic: it is index.ts's own pre-FIX-41
 * sequence (computeGeometricOwnership -> detectConstantOffsetRuns's Step 2
 * arbitration -> assignmentsFromBlocks -> validateAssignments ->
 * buildFinalPayload), moved here unchanged so it can run twice. Everything
 * downstream of this (targeted verification, coverage/saturation, the
 * final validity decision) still lives in index.ts / debug-parse-receipt.ts
 * and is untouched by this round.
 *
 * Deterministic given its inputs: computeGeometricOwnership and
 * detectConstantOffsetRuns are pure geometry/arithmetic over the ledger and
 * OCR lines, never a network call. Calling this twice with the SAME blocks
 * produces the SAME result — the only thing that varies between two calls
 * is which `blocks` GPT itself returned upstream.
 */

import type { LedgerEntry } from "./ledger.ts";
import type { OcrLine } from "./ocr.ts";
import { assignmentsFromBlocks, type StructureBlock, type Assignment } from "./schema.ts";
import { validateAssignments, buildFinalPayload, type AssignmentValidation, type AssembleResult } from "./validate.ts";
import { computeGeometricOwnership, detectConstantOffsetRuns, type PriceBlockInput, type OwnershipResult } from "./ownership.ts";
import type { TotalWitnessResult } from "./totalWitness.ts";
import { reconcile, toMinor } from "./reconcile.ts";

export interface MaterializedStructure {
  /** The SAME blocks array passed in, mutated in place with each block's
   *  final `amountId` (ownership, then offset arbitration if it fired) —
   *  matching index.ts's own pre-existing mutation style exactly. */
  blocks: StructureBlock[];
  assignments: Assignment[];
  validations: AssignmentValidation[];
  assembled: AssembleResult;
  offsetFormDetected: boolean;
  offsetHypothesisAdopted: "H0" | "H1" | "AMBIGUOUS";
  /** Every block's own geometric ownership result — needed downstream for
   *  findOwnershipAmbiguous and the crossingsDetected diagnostic, both
   *  unchanged from before FIX 41. */
  ownershipResults: OwnershipResult[];
}

export function materializeStructure(
  blocks: StructureBlock[],
  ledger: LedgerEntry[],
  matchingLedger: LedgerEntry[],
  ocrLines: OcrLine[],
  lines: string[],
  merchant: string | null,
  currency: string,
  itemsRegionEnd: number,
  totalWitness: TotalWitnessResult | null
): MaterializedStructure {
  const ownershipInputs: PriceBlockInput[] = blocks.map((b) => ({
    blockId: b.blockId,
    kind: b.kind,
    lineIndices: b.lineIndices,
    name: b.name,
    parentBlockId: b.parentBlockId,
    proposedAmountId: b.amountId,
  }));
  const ownershipResults = computeGeometricOwnership(ownershipInputs, matchingLedger, ocrLines, itemsRegionEnd);
  const ownershipByBlock = new Map(ownershipResults.map((r) => [r.blockId, r]));
  for (const block of blocks) {
    const owned = ownershipByBlock.get(block.blockId);
    if (owned) block.amountId = owned.amountId;
  }

  let offsetFormDetected = false;
  let offsetHypothesisAdopted: "H0" | "H1" | "AMBIGUOUS" = "H0";
  {
    const offsetRuns = detectConstantOffsetRuns(ownershipInputs, matchingLedger, ocrLines, itemsRegionEnd);
    offsetFormDetected = offsetRuns.length > 0;
    const viableRuns = offsetRuns.filter((r) => r.h1AmountIds !== null);
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
        offsetHypothesisAdopted = "AMBIGUOUS";
        for (const block of blocks) {
          if (affectedBlockIds.has(block.blockId)) block.amountId = null;
        }
      }
      // Neither closes: H0 stands untouched, offsetHypothesisAdopted stays "H0".
    }
  }

  const assignments = assignmentsFromBlocks(blocks);
  let validations = validateAssignments(blocks, assignments, ledger);
  validations = validations.map((v) => {
    const owned = ownershipByBlock.get(v.blockId);
    if (owned?.confident && v.amountId === owned.amountId) {
      return { ...v, ownershipValid: true };
    }
    return v;
  });

  const assembled = buildFinalPayload(merchant, currency, lines, blocks, validations, ledger, totalWitness);

  return { blocks, assignments, validations, assembled, offsetFormDetected, offsetHypothesisAdopted, ownershipResults };
}
