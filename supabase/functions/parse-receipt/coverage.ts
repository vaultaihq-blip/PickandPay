/**
 * Structural and monetary coverage invariants (FIX 7).
 *
 * Real-device testing surfaced a receipt whose printed subtotal matched
 * exactly (reconciles === true) while three items were actually scrambled,
 * because a dropped modifier block's orphaned amount got silently absorbed
 * by a neighbouring item, and the resulting wrong values happened to cancel
 * out arithmetically. That proved reconciliation can never be sufficient
 * evidence of correctness on its own.
 *
 * This module makes monetary coverage an explicit, checked invariant,
 * independent of and prior to reconciliation:
 *   - every monetary occurrence in the items region must end in exactly one
 *     of a fixed set of explicit states — never simply vanish;
 *   - every claimed amount must have exactly one owner, never more;
 *   - a receipt is VALID only when coverage and ownership both hold, AND
 *     printed-total reconciliation holds. Reconciliation success alone
 *     never overrides a coverage or ownership failure.
 *
 * Pure TypeScript — no Deno-specific imports.
 */

import type { LedgerEntry } from "./ledger.ts";
import type { StructureBlock, Assignment } from "./schema.ts";
import type { AssignmentValidation } from "./validate.ts";

export type CoverageState =
  | "CLAIMED_BY_ITEM"
  | "CLAIMED_BY_MODIFIER"
  | "CLAIMED_BY_DISCOUNT"
  | "CLAIMED_BY_FEE_OR_CHARGE"
  | "EXPLICITLY_NON_CHARGE"
  | "UNRESOLVED";

export interface CoverageEntry {
  amountId: string;
  lineIndex: number;
  state: CoverageState;
  claimedByBlockId: string | null;
}

/**
 * The items region is everything before the first "summary" block's own
 * earliest line — subtotal/tax/service/total and anything after are a
 * different region with their own (already-enforced) classification rules.
 * With no summary block at all, the whole document counts as items region:
 * absence of a detected summary is itself something coverage should not
 * paper over silently.
 */
export function computeItemsRegionEnd(blocks: StructureBlock[]): number {
  const summaryLines = blocks.filter((b) => b.kind === "summary").flatMap((b) => b.lineIndices);
  return summaryLines.length > 0 ? Math.min(...summaryLines) : Infinity;
}

/**
 * STEP 2 — structural coverage audit, run BEFORE ownership. A line in the
 * items region that carries a monetary token but isn't part of ANY
 * semantic block's own reported lineIndices is a structural gap: price
 * ownership must not proceed as if that line didn't exist, because nothing
 * downstream can invent a block that was never proposed.
 */
export interface StructuralGap {
  lineIndex: number;
  amountId: string;
}

export function findStructuralGaps(
  blocks: StructureBlock[],
  ledger: LedgerEntry[],
  itemsRegionEnd: number
): StructuralGap[] {
  const coveredLines = new Set<number>();
  for (const b of blocks) for (const li of b.lineIndices) coveredLines.add(li);

  const gaps: StructuralGap[] = [];
  for (const entry of ledger) {
    if (entry.lineIndex >= itemsRegionEnd) continue;
    if (!/[.,]\d{2}$/.test(entry.rawText)) continue; // bare-integer noise, not a real price — never a gap
    if (!coveredLines.has(entry.lineIndex)) {
      gaps.push({ lineIndex: entry.lineIndex, amountId: entry.amountId });
    }
  }
  return gaps;
}

/**
 * STEP 7 — the second coverage audit, run AFTER ownership assignment.
 * Classifies every load-bearing (decimal-formatted) monetary occurrence in
 * the items region into one of the explicit states. An amount whose line
 * was structurally covered by a block, but which no block's FINAL
 * assignment actually claims (the "block merged two modifiers but can only
 * report one price" failure class — line technically inside a block's
 * span, value still never claimed), surfaces here as UNRESOLVED exactly
 * the same as a line no block ever mentioned at all.
 */
export function classifyCoverage(
  blocks: StructureBlock[],
  assignments: Assignment[],
  ledger: LedgerEntry[],
  itemsRegionEnd: number
): CoverageEntry[] {
  const blockById = new Map(blocks.map((b) => [b.blockId, b]));
  const claimedBy = new Map<string, string>(); // amountId -> blockId
  for (const a of assignments) {
    if (a.amountId !== null && !claimedBy.has(a.amountId)) claimedBy.set(a.amountId, a.blockId);
  }

  const kindToState = (kind: StructureBlock["kind"]): CoverageState => {
    switch (kind) {
      case "item":
        return "CLAIMED_BY_ITEM";
      case "modifier":
        return "CLAIMED_BY_MODIFIER";
      case "summary":
        return "CLAIMED_BY_FEE_OR_CHARGE";
      default:
        return "EXPLICITLY_NON_CHARGE";
    }
  };

  const entries: CoverageEntry[] = [];
  for (const entry of ledger) {
    if (entry.lineIndex >= itemsRegionEnd) continue;
    if (!/[.,]\d{2}$/.test(entry.rawText)) continue; // bare-integer noise is never load-bearing

    const owner = claimedBy.get(entry.amountId);
    if (owner) {
      const block = blockById.get(owner);
      entries.push({
        amountId: entry.amountId,
        lineIndex: entry.lineIndex,
        state: block ? kindToState(block.kind) : "UNRESOLVED",
        claimedByBlockId: owner,
      });
    } else {
      entries.push({ amountId: entry.amountId, lineIndex: entry.lineIndex, state: "UNRESOLVED", claimedByBlockId: null });
    }
  }
  return entries;
}

/** Requirement #6 — exclusive token ownership: an amountId claimed by more
 *  than one block at once. Should be structurally impossible given how
 *  ownership.ts and assignmentsFromBlocks work, but verified explicitly
 *  rather than assumed — a provider/upstream guarantee is never trusted
 *  blindly anywhere else in this pipeline, and this is no exception. */
export interface DuplicateOwnership {
  amountId: string;
  blockIds: string[];
}

export function findDuplicateOwnership(assignments: Assignment[]): DuplicateOwnership[] {
  const byAmount = new Map<string, string[]>();
  for (const a of assignments) {
    if (a.amountId === null) continue;
    const list = byAmount.get(a.amountId) ?? [];
    list.push(a.blockId);
    byAmount.set(a.amountId, list);
  }
  return [...byAmount.entries()]
    .filter(([, blockIds]) => blockIds.length > 1)
    .map(([amountId, blockIds]) => ({ amountId, blockIds }));
}

/**
 * STEP 8 — VALID requires ALL of: structural coverage complete, ownership
 * validation passing (checked upstream in validate.ts, reflected here via
 * `ownershipValid`), zero unresolved load-bearing items-region amounts,
 * zero multiply-owned amounts, and printed-total reconciliation. Any
 * single failure makes the receipt invalid regardless of how well the
 * others hold — reconciliation success never overrides A-E.
 */
export interface ValidityResult {
  valid: boolean;
  structuralGapCount: number;
  unresolvedLoadBearingCount: number;
  duplicateOwnershipCount: number;
  ownershipInvalidCount: number;
  reconciles: boolean;
}

export function determineValidity(
  structuralGaps: StructuralGap[],
  coverage: CoverageEntry[],
  duplicates: DuplicateOwnership[],
  validations: AssignmentValidation[],
  reconciles: boolean
): ValidityResult {
  const unresolvedLoadBearingCount = coverage.filter((c) => c.state === "UNRESOLVED").length;
  const ownershipInvalidCount = validations.filter((v) => v.amountId !== null && !v.ownershipValid).length;

  const valid =
    structuralGaps.length === 0 &&
    unresolvedLoadBearingCount === 0 &&
    duplicates.length === 0 &&
    ownershipInvalidCount === 0 &&
    reconciles;

  return {
    valid,
    structuralGapCount: structuralGaps.length,
    unresolvedLoadBearingCount,
    duplicateOwnershipCount: duplicates.length,
    ownershipInvalidCount,
    reconciles,
  };
}
