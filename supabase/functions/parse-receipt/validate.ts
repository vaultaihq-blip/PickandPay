/**
 * Deterministic validation and final-payload assembly.
 *
 * This is the primary safety layer of the pipeline — not the structured-
 * output schema (that only stops fully fabricated IDs) and not "does this
 * value exist somewhere in the OCR output" (existence alone is checked, but
 * is not sufficient on its own — see ownership below). Every accepted price
 * must pass, in order:
 *   1. existence  — the amountId resolves to a real ledger entry
 *   2. ownership  — that entry was actually near the claiming block's own
 *                    lines, not merely valid somewhere on the receipt
 *   3. evidence    — OCR's own reported confidence for that word is strong
 *                    enough to trust outright, or it survives targeted
 *                    verification
 * Nothing that fails these is silently dropped or auto-balanced; it is
 * either escalated for verification or surfaced as an unresolved line.
 *
 * Pure TypeScript — no Deno-specific imports.
 */

import type { LedgerEntry } from "./ledger.ts";
import type { Assignment, StructureBlock } from "./schema.ts";
import { computeEligibleAmountIds, resolveAmountReference } from "./schema.ts";
import type { RawCharge, RawItem, RawPayload, RawUnresolvedLine } from "./types.ts";
import { reconcile as computeCalculatedSubtotal, toMinor } from "./reconcile.ts";

// ─── Ownership validation ───────────────────────────────────────────────────

export interface AssignmentValidation {
  blockId: string;
  amountId: string | null;
  /** False when amountId exists in the ledger but was not near this block's
   *  own lines — a schema-valid, contextually-wrong pick. */
  ownershipValid: boolean;
  /** False when amountId doesn't resolve to any ledger entry at all — should
   *  be near-impossible given the schema enum, checked anyway (never trust a
   *  provider guarantee blindly). */
  existsInLedger: boolean;
  entry: LedgerEntry | null;
}

export function validateAssignments(
  blocks: StructureBlock[],
  assignments: Assignment[],
  ledger: LedgerEntry[]
): AssignmentValidation[] {
  const blockById = new Map(blocks.map((b) => [b.blockId, b]));
  return assignments.map((a) => {
    if (a.amountId === null) {
      return { blockId: a.blockId, amountId: null, ownershipValid: true, existsInLedger: true, entry: null };
    }
    const entry = resolveAmountReference(a.amountId, ledger);
    if (entry === null) {
      return { blockId: a.blockId, amountId: a.amountId, ownershipValid: false, existsInLedger: false, entry: null };
    }
    const block = blockById.get(a.blockId);
    const eligible = block ? computeEligibleAmountIds(block, ledger) : [];
    const ownershipValid = eligible.includes(a.amountId);
    return { blockId: a.blockId, amountId: a.amountId, ownershipValid, existsInLedger: true, entry };
  });
}

// ─── Escalation to targeted verification ────────────────────────────────────

/** Below this, a load-bearing OCR reading is not trusted outright — OCR
 *  confidence is never blindly trusted (requirement #9). Tunable; chosen
 *  conservatively since the cost of a missed verification (a silent wrong
 *  value) is much higher than an occasional unnecessary one. */
export const OCR_CONFIDENCE_THRESHOLD = 0.75;

export interface SuspiciousEvidence {
  amountId?: string;
  lineIndex?: number;
  blockId?: string;
  reason: "ownership_invalid" | "low_confidence" | "reconciliation_failed" | "ownership_ambiguous";
}

/**
 * Blocks the geometric ownership layer (ownership.ts) could not confidently
 * resolve — its two best candidates were too close to call, so it fell back
 * to a hint rather than guessing. Distinct from `findSuspiciousEvidence`'s
 * checks (which run against the *value* actually assigned); this runs
 * against the *decision process* itself, since a low-confidence geometric
 * match can carry a perfectly plausible-looking value.
 */
export function findOwnershipAmbiguous(
  ownershipResults: Array<{ blockId: string; amountId: string | null; confident: boolean }>
): SuspiciousEvidence[] {
  return ownershipResults
    .filter((r) => !r.confident && r.amountId !== null)
    .map((r) => ({ blockId: r.blockId, amountId: r.amountId as string, reason: "ownership_ambiguous" as const }));
}

/**
 * A block is "load-bearing" when it can actually move the receipt's totals —
 * an unclassified block with no assigned price isn't worth the cost of a
 * verification call.
 */
export function isLoadBearing(block: StructureBlock | undefined, amountId: string | null): boolean {
  if (amountId === null || block === undefined) return false;
  return block.kind === "item" || block.kind === "summary";
}

/**
 * Finds the specific occurrences worth a targeted re-read: ownership
 * failures always qualify (direct evidence of a problem); a load-bearing
 * value below the OCR confidence threshold qualifies too, to keep this
 * cost-aware rather than re-verifying every low-stakes reading.
 */
export function findSuspiciousEvidence(
  blocks: StructureBlock[],
  validations: AssignmentValidation[]
): SuspiciousEvidence[] {
  const blockById = new Map(blocks.map((b) => [b.blockId, b]));
  const suspicious: SuspiciousEvidence[] = [];

  for (const v of validations) {
    const block = blockById.get(v.blockId);
    if (v.amountId === null) continue;

    if (!v.existsInLedger) {
      suspicious.push({ amountId: v.amountId, blockId: v.blockId, reason: "ownership_invalid" });
      continue;
    }
    if (!v.ownershipValid) {
      suspicious.push({ amountId: v.amountId, blockId: v.blockId, lineIndex: v.entry?.lineIndex, reason: "ownership_invalid" });
      continue;
    }

    const confidence = v.entry?.ocrConfidence ?? 0;
    if (confidence < OCR_CONFIDENCE_THRESHOLD && isLoadBearing(block, v.amountId)) {
      suspicious.push({
        amountId: v.amountId,
        blockId: v.blockId,
        lineIndex: v.entry?.lineIndex,
        reason: "low_confidence",
      });
    }
  }

  return suspicious;
}

/**
 * Second-round escalation, triggered when reconstructed arithmetic does not
 * reconcile against the printed subtotal even though every individual value
 * passed ownership validation (including high-OCR-confidence ones).
 * Reconciling arithmetic is a supporting signal, not proof — this is the
 * other half of that: FAILING arithmetic must not be waved through just
 * because each value looked fine in isolation. High OCR confidence means the
 * engine is confident in its own read, never a guarantee the read is
 * correct, so it does not exempt a value from this second look.
 *
 * Scoped to every load-bearing (item/summary) block with an assigned value —
 * that is precisely the set of values feeding the failing arithmetic, and
 * finer localization than that is not something a single reconciliation
 * delta gives us. `excludeAmountIds` skips whatever the first verification
 * round already re-read this request, so nothing is re-checked twice.
 */
export function findReconciliationSuspects(
  blocks: StructureBlock[],
  validations: AssignmentValidation[],
  excludeAmountIds: ReadonlySet<string>
): SuspiciousEvidence[] {
  const blockById = new Map(blocks.map((b) => [b.blockId, b]));
  const suspects: SuspiciousEvidence[] = [];

  for (const v of validations) {
    if (v.amountId === null || !v.existsInLedger || !v.ownershipValid) continue;
    if (excludeAmountIds.has(v.amountId)) continue;
    const block = blockById.get(v.blockId);
    if (!isLoadBearing(block, v.amountId)) continue;
    suspects.push({ amountId: v.amountId, blockId: v.blockId, lineIndex: v.entry?.lineIndex, reason: "reconciliation_failed" });
  }

  return suspects;
}

// ─── Final payload assembly ─────────────────────────────────────────────────
//
// Converts the internal blocks/assignments/ledger representation into the
// SAME RawPayload shape the previous pipeline produced, so the public
// envelope (and everything downstream on the client) is unchanged.

/**
 * FIX 10 (Group 2) — only the UNAMBIGUOUS-by-name charge kinds are still
 * classified this way. Tax/service/tip/discount/delivery/bag are never
 * mistaken for a receipt's total or subtotal in practice (their values are
 * essentially never equal to item-sum(+charges)), so trusting their own
 * printed label remains safe and is unchanged from before this fix.
 *
 * Subtotal/total are deliberately NOT handled here anymore — see
 * `classifyTotalCandidates` below. A block whose name says "Total" is still
 * only IDENTIFIED as the total if it arithmetically closes; name is at most
 * a tie-breaker between multiple equally-closing candidates, never the
 * primary signal (that was the bug: a label the model failed to print, or
 * printed on the wrong line, silently lost the value or picked the wrong
 * one of several "Total"-like candidates).
 */
function classifyKnownCharge(
  name: string | null
): { printedField?: "printedTax" | "printedServiceCharge" | "printedTip" | "printedDiscount"; chargeKind: string } | null {
  const n = (name ?? "").toLowerCase();
  if (/tax|vat|gst|hst/.test(n)) return { printedField: "printedTax", chargeKind: "tax" };
  if (/service/.test(n)) return { printedField: "printedServiceCharge", chargeKind: "service" };
  if (/tip|gratuity/.test(n)) return { printedField: "printedTip", chargeKind: "tip" };
  if (/discount|coupon|voucher/.test(n)) return { printedField: "printedDiscount", chargeKind: "discount" };
  if (/deliver/.test(n)) return { chargeKind: "delivery" };
  if (/\bbag\b/.test(n)) return { chargeKind: "bag" };
  return null;
}

// ─── FIX 10 — total/subtotal identification by arithmetic closure ─────────
//
// A receipt's printed total is, by definition, the value that CLOSES the
// books: item-sum + charges. That identity is true regardless of what the
// block happened to be named, what order it was printed in, or what
// language/format the receipt uses — unlike a name regex, it can't be
// fooled by a null name, and unlike position, it can't be fooled by a
// "Total"-shaped line that isn't the grand total (a per-rate VAT subtotal,
// a payment-method breakdown line, etc.).

/** Rounding-only tolerance, in minor currency units (cents). This absorbs
 *  float/rounding noise, never wrong structure — if a candidate needs more
 *  than this to close, it doesn't close, full stop. */
const CLOSURE_TOLERANCE_MINOR = 1;

export interface TotalCandidate {
  /** blockId for a summary-block candidate, or `ledger_<amountId>` for an
   *  unclaimed ledger value found in the summary region. */
  id: string;
  entry: LedgerEntry;
  /** From the block's own name, when one exists — a tie-breaker only, never
   *  the primary signal. Ledger-derived candidates have no name at all. */
  nameHint: "subtotal" | "total" | null;
  lineIndex?: number;
}

export interface ClosureResolution {
  valueMinor: number;
  winnerId: string;
}

/** null = nothing closed; the ambiguous shape = 2+ DIFFERENT values all
 *  close and none can be preferred by name — never guessed. */
export function resolveClosure(
  candidates: TotalCandidate[],
  targetMinor: number,
  currency: string,
  preferHint: "subtotal" | "total"
): ClosureResolution | { ambiguous: true; distinctValuesMinor: number[] } | null {
  const closing = candidates
    .map((c) => ({ c, m: toMinor(c.entry.value, currency) }))
    .filter((x): x is { c: TotalCandidate; m: number } => x.m !== null && Math.abs(x.m - targetMinor) <= CLOSURE_TOLERANCE_MINOR);
  if (closing.length === 0) return null;

  const distinctValuesMinor = [...new Set(closing.map((x) => x.m))];
  if (distinctValuesMinor.length > 1) return { ambiguous: true, distinctValuesMinor };

  // Every closing candidate agrees on the value — which specific block gets
  // credited as "the" winner cannot change the outcome, but a matching name
  // hint is preferred when one exists, purely for a more legible source
  // reference (never as the reason it was chosen).
  const preferred = closing.find((x) => x.c.nameHint === preferHint) ?? closing[0];
  return { valueMinor: distinctValuesMinor[0], winnerId: preferred.c.id };
}

export interface AssembleResult {
  payload: RawPayload;
  /** Ledger entries no assignment ever referenced — surfaced, never dropped. */
  orphanCount: number;
}

export function buildFinalPayload(
  merchant: string | null,
  currency: string,
  lines: string[],
  blocks: StructureBlock[],
  validations: AssignmentValidation[],
  ledger: LedgerEntry[]
): AssembleResult {
  const validationByBlock = new Map(validations.map((v) => [v.blockId, v]));
  const claimedAmountIds = new Set(validations.filter((v) => v.amountId !== null).map((v) => v.amountId));

  const items: RawItem[] = [];
  const charges: RawCharge[] = [];
  const unresolvedLines: RawUnresolvedLine[] = [];
  const printedFields: Record<string, number | undefined> = {};

  const itemBlocks = blocks.filter((b) => b.kind === "item");
  const modifierBlocks = blocks.filter((b) => b.kind === "modifier");
  const summaryBlocks = blocks.filter((b) => b.kind === "summary");
  const unclassifiedBlocks = blocks.filter((b) => b.kind === "unclassified" || b.kind === "quantity");

  for (const item of itemBlocks) {
    const v = validationByBlock.get(item.blockId);
    const entry = v?.entry ?? null;
    const minLine = item.lineIndices.length > 0 ? Math.min(...item.lineIndices) : undefined;

    const modifiers = modifierBlocks
      .filter((m) => m.parentBlockId === item.blockId)
      .map((m) => {
        const mv = validationByBlock.get(m.blockId);
        const mEntry = mv?.entry ?? null;
        const mMinLine = m.lineIndices.length > 0 ? Math.min(...m.lineIndices) : undefined;
        return {
          id: m.blockId,
          name: m.name ?? "",
          price: mEntry ? mEntry.value : null,
          kind: mEntry ? "paid" : "free",
          sourceEvidence:
            mMinLine !== undefined
              ? { lineIndex: mMinLine, lineText: lines[mMinLine] ?? "" }
              : undefined,
        };
      });

    // Quantity comes only from this item block's own `quantity` field — the
    // semantic pass is instructed to read it from the item's own line, never
    // a modifier/description line beneath it (e.g. "1 BTL ... / 4 Glasses"
    // must yield quantity 1, not 4 — see prompts.ts).
    const quantity =
      typeof item.quantity === "number" && Number.isFinite(item.quantity) && item.quantity >= 1
        ? Math.round(item.quantity)
        : 1;

    // priceKind decides which field the observed value populates. A value
    // that is ALREADY a line total must never also be multiplied by
    // quantity in reconcile() — populating baseLineTotal (and leaving
    // unitPrice null) is what prevents that, since reconcile() only
    // multiplies unitPrice by quantity, never baseLineTotal. The same
    // printed occurrence can never be treated as both at once.
    const isLineTotal = item.priceKind === "lineTotal";
    const value = entry ? entry.value : null;

    items.push({
      id: item.blockId,
      name: item.name ?? "",
      quantity,
      unitPrice: isLineTotal ? null : value,
      baseLineTotal: isLineTotal ? value : null,
      modifiers,
      sourceEvidence:
        minLine !== undefined ? { lineIndex: minLine, lineText: lines[minLine] ?? "" } : undefined,
    });
  }

  // FIX 10 — first pass: unambiguous-by-name charges (tax/service/tip/
  // discount/delivery/bag) are classified immediately, exactly as before.
  // Everything else (a subtotal/total-flavored name, or no name at all)
  // becomes a total/subtotal CLOSURE CANDIDATE instead of being trusted or
  // discarded by name — resolved below, once every candidate is known.
  const totalCandidates: TotalCandidate[] = [];
  for (const summary of summaryBlocks) {
    const v = validationByBlock.get(summary.blockId);
    const entry = v?.entry ?? null;
    if (entry === null) continue; // no evidence for this region — nothing to record

    const known = classifyKnownCharge(summary.name);
    if (known) {
      if (known.printedField) printedFields[known.printedField] = entry.value;
      charges.push({ id: summary.blockId, name: summary.name ?? known.chargeKind, amount: entry.value, kind: known.chargeKind });
      continue;
    }

    const n = (summary.name ?? "").toLowerCase();
    const nameHint: "subtotal" | "total" | null = /subtotal/.test(n) ? "subtotal" : /\btotal\b/.test(n) ? "total" : null;
    const minLine = summary.lineIndices.length > 0 ? Math.min(...summary.lineIndices) : undefined;
    totalCandidates.push({ id: summary.blockId, entry, nameHint, lineIndex: minLine });
  }

  // A block whose value might be the printed discount/tax/etc. is never
  // ALSO a total candidate (that would be self-referential: the total
  // closure target already includes those charges) — but a value the
  // pipeline never assigned to ANY block at all might still be the total,
  // if it sits in the same structural region GPT itself marked as
  // "summary". No keyword involved: the region boundary comes from the
  // model's own block layout, not from any printed word.
  const summaryRegionStart =
    summaryBlocks.length > 0 ? Math.min(...summaryBlocks.flatMap((b) => b.lineIndices)) : Infinity;
  for (const entry of ledger) {
    if (claimedAmountIds.has(entry.amountId)) continue;
    if (entry.lineIndex < summaryRegionStart) continue;
    if (!/[.,]\d{2}$/.test(entry.rawText)) continue; // decimal-shaped only — never a bare noise integer
    totalCandidates.push({ id: `ledger_${entry.amountId}`, entry, nameHint: null, lineIndex: entry.lineIndex });
  }

  // Item-sum, computed by the SAME function reconcile() itself uses —
  // never a second, potentially-divergent reimplementation of that
  // arithmetic (see reconcile.ts's own header comment on why that matters).
  const itemSumMinor = computeCalculatedSubtotal({ currency, items }).calculatedSubtotalMinor;

  // Charges sum for the total-closure target: discount reduces the total,
  // everything else (tax/service/tip/delivery/bag) adds to it.
  let chargesMinor = 0;
  for (const c of charges) {
    const m = toMinor(c.amount, currency) ?? 0;
    chargesMinor += c.kind === "discount" ? -m : m;
  }

  const totalResolution = resolveClosure(totalCandidates, itemSumMinor + chargesMinor, currency, "total");
  const subtotalResolution = resolveClosure(totalCandidates, itemSumMinor, currency, "subtotal");

  const winningIds = new Set<string>();
  if (totalResolution && !("ambiguous" in totalResolution)) {
    printedFields.printedTotal = totalCandidates.find((c) => c.id === totalResolution.winnerId)?.entry.value;
    winningIds.add(totalResolution.winnerId);
  }
  if (subtotalResolution && !("ambiguous" in subtotalResolution)) {
    printedFields.printedSubtotal = totalCandidates.find((c) => c.id === subtotalResolution.winnerId)?.entry.value;
    winningIds.add(subtotalResolution.winnerId);
  }

  // Every candidate that didn't win either role is surfaced, not dropped —
  // whether it failed to close at all, or closed but lost an ambiguous tie
  // against a different value. A ledger-derived candidate that DID win is
  // now "claimed" (it became the total/subtotal), so it must not also fall
  // through the orphan pass below as unclaimed evidence.
  for (const c of totalCandidates) {
    if (winningIds.has(c.id)) {
      claimedAmountIds.add(c.entry.amountId);
      continue;
    }
    if (c.id.startsWith("ledger_")) continue; // never claimed — the ordinary orphan pass below will surface it
    unresolvedLines.push({
      id: `unclassified_${c.id}`,
      amount: c.entry.value,
      text: c.lineIndex !== undefined ? lines[c.lineIndex] : "",
      lineIndex: c.lineIndex,
    });
  }

  // Unclassified/quantity blocks that still ended up with an assigned amount
  // are exactly the "we don't know where this belongs" case — surfaced, not
  // dropped.
  for (const block of unclassifiedBlocks) {
    const v = validationByBlock.get(block.blockId);
    if (v?.entry) {
      const minLine = block.lineIndices.length > 0 ? Math.min(...block.lineIndices) : undefined;
      unresolvedLines.push({
        id: `unclassified_${block.blockId}`,
        amount: v.entry.value,
        text: minLine !== undefined ? lines[minLine] : block.name ?? "",
        lineIndex: minLine,
      });
    }
  }

  // Reverse check: any ledger entry no block ever claimed is evidence that
  // would otherwise vanish silently — surface it instead.
  let orphanCount = 0;
  for (const entry of ledger) {
    if (claimedAmountIds.has(entry.amountId)) continue;
    orphanCount += 1;
    unresolvedLines.push({
      id: `orphan_${entry.amountId}`,
      amount: entry.value,
      text: entry.rawText,
      lineIndex: entry.lineIndex,
    });
  }

  const payload: RawPayload = {
    merchant,
    currency,
    items,
    charges,
    unresolvedLines,
    printedSubtotal: printedFields.printedSubtotal ?? null,
    printedServiceCharge: printedFields.printedServiceCharge ?? null,
    printedTax: printedFields.printedTax ?? null,
    printedTip: printedFields.printedTip ?? null,
    printedDiscount: printedFields.printedDiscount ?? null,
    printedTotal: printedFields.printedTotal ?? null,
  };

  return { payload, orphanCount };
}
