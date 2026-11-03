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
import type { SummaryRole, SummaryRoleAssignment } from "./coverage.ts";
import { claimedValueHasUnitPriceAnnotation } from "./coverage.ts";
import type { TotalWitnessResult } from "./totalWitness.ts";
import type { ColumnRoles } from "./columns.ts";
import { nearestInBand } from "./columns.ts";

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
  reason: "ownership_invalid" | "low_confidence" | "reconciliation_failed" | "ownership_ambiguous" | "arithmetic_contradiction";
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

/**
 * FIX 35 Part 4 — a claimed line-total value whose own row ALSO prints a
 * quantity and a unit price (columns.ts's detectColumnRoles + nearestInBand
 * — the identical row-pairing rule Part 2's row-arithmetic proof already
 * uses) is checked against them: quantity * unitPrice must equal the
 * claimed total exactly. When it doesn't, this is a contradiction between
 * two PRINTED sources on the same receipt — never silently corrected
 * in-place (a misread "34,502" for a true "34,50" is exactly this shape:
 * OCR confidence alone (84%) didn't flag it, but the arithmetic does) —
 * surfaced as suspicious evidence so the existing targeted-verification
 * pass (runTargetedVerification) re-reads that zone of the image. If
 * re-reading confirms the corrected value, it's used; if it can't
 * (--fixture runs, or the re-read is itself inconclusive), the line stays
 * unresolved rather than trusting either printed figure blindly.
 *
 * Never fires without BOTH bands present, and never for a claim whose
 * quantity/unit price weren't found within nearestInBand's own row window —
 * a receipt with only one combined value column (most of this corpus) has
 * nothing for this check to compare against, and correctly stays silent.
 */
export function findArithmeticContradictions(
  validations: AssignmentValidation[],
  columnRoles: ColumnRoles,
  ledger: LedgerEntry[]
): SuspiciousEvidence[] {
  if (!columnRoles.quantity || !columnRoles.unitPrice) return [];
  const byAmountId = new Map(ledger.map((e) => [e.amountId, e]));
  const suspects: SuspiciousEvidence[] = [];

  for (const v of validations) {
    if (v.amountId === null || !v.existsInLedger || !v.ownershipValid || !v.entry) continue;
    const claimed = v.entry;
    const qty = nearestInBand(claimed, columnRoles.quantity, byAmountId);
    const unit = nearestInBand(claimed, columnRoles.unitPrice, byAmountId);
    if (!qty || !unit) continue;

    const expectedMinor = Math.round(Math.round(qty.value * 100) * unit.value);
    const claimedMinor = Math.round(claimed.value * 100);
    if (expectedMinor !== claimedMinor) {
      suspects.push({ amountId: v.amountId, blockId: v.blockId, lineIndex: claimed.lineIndex, reason: "arithmetic_contradiction" });
    }
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

/** Maps validate.ts's own charge-kind vocabulary (classifyKnownCharge's
 *  chargeKind strings) onto coverage.ts's SummaryRole — kept here, next to
 *  where chargeKind is produced, rather than in coverage.ts. */
const CHARGE_KIND_TO_SUMMARY_ROLE: Record<
  string,
  Exclude<SummaryRole, "UNRESOLVED" | "SUBTOTAL" | "GRAND_TOTAL" | "PROVEN_NON_ADDITIVE" | "PROVEN_ADDITIVE_CHARGE">
> = {
  tax: "TAX",
  service: "SERVICE_CHARGE",
  tip: "TIP",
  discount: "DISCOUNT",
  delivery: "FEE",
  bag: "FEE",
};

export interface AssembleResult {
  payload: RawPayload;
  /** Ledger entries no assignment ever referenced — surfaced, never dropped. */
  orphanCount: number;
  /** FIX 15 — every summary financial role this function decided, keyed by
   *  the amountId that backs it. Purely a record of decisions already made
   *  above; computing it changes nothing about `payload` or `orphanCount`.
   *  Consumed by coverage.ts's classifySummaryCoverage/
   *  findSummaryDuplicateRoles/determineSummaryValidity — never by the
   *  public envelope. */
  summaryRoleAssignments: SummaryRoleAssignment[];
  /** FIX 23 — every item where the deterministic unit-price-annotation
   *  rule overrode GPT's own `priceKind` (GPT said something other than
   *  "lineTotal", but an adjacent annotation proved the claimed value IS
   *  the line total). Purely diagnostic — quantifies how often GPT's
   *  priceKind disagrees with the verified arithmetic, and by which item,
   *  so a block that disagrees on EVERY run is visible rather than
   *  averaged away. */
  priceKindOverrides: Array<{ blockId: string; name: string | null }>;
  /** FIX 31 — which witness (if any) identified the grand total independently
   *  of item-sum closure, and whether typography agreed. Null when neither
   *  witness found anything (pre-FIX-31 closure-only behavior applied). */
  totalWitness: TotalWitnessResult | null;
  /** FIX 32 — itemSum + recognized charges, in minor units, exactly as
   *  already computed above for the (possibly witness-overridden)
   *  totalResolution — exposed so coverage.ts's applyProvenNonAdditive can
   *  test it against an INDEPENDENTLY identified total without
   *  recomputing it a second, potentially-divergent way. */
  itemSumPlusChargesMinor: number;
  /** FIX 34 — itemSum ALONE, in minor units (the same value already used
   *  above to compute itemSumPlusChargesMinor, exposed separately) — needed
   *  by coverage.ts's applyProvenAdditiveCharge for its base*rate=value
   *  corroboration check (FIX 34's own guard 5), which is measured against
   *  the item sum alone, never against itemSum+charges (a printed
   *  percentage like "Large Party (20.00%)" is always of the item total,
   *  not of an already-tax-inclusive figure). */
  itemSumMinor: number;
}

export function buildFinalPayload(
  merchant: string | null,
  currency: string,
  lines: string[],
  blocks: StructureBlock[],
  validations: AssignmentValidation[],
  ledger: LedgerEntry[],
  /** FIX 31 — optional, backward-compatible: every pre-existing call site
   *  and test omits this and keeps exact prior behavior (closure decides
   *  the total). Computed by the caller (index.ts) from the real OCR lines,
   *  since this function only ever received flattened `lines: string[]` —
   *  see totalWitness.ts's own header for why the witnesses need full
   *  OcrLine word/bounding-box data that a plain string array can't carry. */
  totalWitness: TotalWitnessResult | null = null
): AssembleResult {
  const validationByBlock = new Map(validations.map((v) => [v.blockId, v]));
  const claimedAmountIds = new Set(validations.filter((v) => v.amountId !== null).map((v) => v.amountId));

  const items: RawItem[] = [];
  const charges: RawCharge[] = [];
  const unresolvedLines: RawUnresolvedLine[] = [];
  const printedFields: Record<string, number | undefined> = {};
  const priceKindOverrides: Array<{ blockId: string; name: string | null }> = [];

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
    //
    // FIX 23 — GPT's own priceKind is IGNORED, not merely outvoted, when a
    // deterministic override proves the claimed value is a line total: an
    // adjacent (same-or-next-line) candidate whose value * quantity
    // reconstructs it exactly, with quantity verified in exact minor-unit
    // arithmetic, never assumed (see claimedValueHasUnitPriceAnnotation's
    // comment). One-directional — this can only push priceKind TOWARD
    // lineTotal, never away from it, so a correct GPT "lineTotal" is
    // simply confirmed, never disturbed.
    const gptSaysLineTotal = item.priceKind === "lineTotal";
    const overriddenToLineTotal = !gptSaysLineTotal && quantity > 1 && entry !== null && claimedValueHasUnitPriceAnnotation(entry, quantity, ledger);
    if (overriddenToLineTotal) priceKindOverrides.push({ blockId: item.blockId, name: item.name });
    const isLineTotal = gptSaysLineTotal || overriddenToLineTotal;
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
  const summaryRoleAssignments: SummaryRoleAssignment[] = [];
  for (const summary of summaryBlocks) {
    const v = validationByBlock.get(summary.blockId);
    const entry = v?.entry ?? null;
    if (entry === null) continue; // no evidence for this region — nothing to record

    const known = classifyKnownCharge(summary.name);
    if (known) {
      if (known.printedField) printedFields[known.printedField] = entry.value;
      charges.push({ id: summary.blockId, name: summary.name ?? known.chargeKind, amount: entry.value, kind: known.chargeKind });
      const role = CHARGE_KIND_TO_SUMMARY_ROLE[known.chargeKind];
      if (role) summaryRoleAssignments.push({ amountId: entry.amountId, role });
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

  // FIX 31 — the witness, when it names a candidate that's actually present
  // in this summary region, decides the total OUTRIGHT — closure is never
  // consulted to pick between witness and arithmetic; it only still runs
  // (unchanged, below) for the SUBTOTAL role, and as itemSum+charges
  // continues to feed `reconcile()`'s own independent check downstream.
  // When the witness's amountId isn't among this receipt's own candidates
  // at all (should not normally happen — the witness ledger IS this
  // receipt's ledger — kept as a defensive fallback, never trusted
  // blindly), behavior is exactly what it was before FIX 31.
  const witnessCandidate = totalWitness ? totalCandidates.find((c) => c.entry.amountId === totalWitness.amountId) : undefined;
  const totalResolution: ClosureResolution | { ambiguous: true; distinctValuesMinor: number[] } | null = witnessCandidate
    ? { valueMinor: toMinor(witnessCandidate.entry.value, currency) ?? 0, winnerId: witnessCandidate.id }
    : resolveClosure(totalCandidates, itemSumMinor + chargesMinor, currency, "total");
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

  // FIX 15.1 — a single occurrence may win BOTH the subtotal and the total
  // role only when nothing LARGER is left unclaimed in the summary region.
  // Root cause (Mademoiselle Raw Bar & Grill): totalResolution and
  // subtotalResolution are each computed independently, against the SAME
  // candidate pool — nothing stops them returning the same winnerId, and
  // when the receipt's total coincidentally matches item-sum (no charge
  // block was recognized), the shared winner silently absorbed both roles
  // while the REAL tax (5.85) and REAL total (50.85) sat unclaimed in
  // totalCandidates, never surfaced as contradicting the coincidence —
  // reconcile() came back true on the wrong number.
  //
  // FIX 15.3B — the original condition ("refuse if ANY unclaimed decimal
  // remains") also rejected a real, distinct failure class: a tax-inclusive
  // receipt (Portuguese/German VAT-included pricing) whose informal rate
  // breakdown table (e.g. "9% / 16% / ..." rows) is genuinely never claimed
  // by any block, has nothing to do with the total, and is always SMALLER
  // than it — three real receipts (Quebra Mar, Ramires, Sulbarreiro),
  // previously stable and correct, regressed to refused/unresolved under
  // that stricter rule. The distinguishing structural fact, with no name,
  // merchant, or language involved: a printed total is, by construction,
  // the largest figure on the receipt (subtotal plus zero-or-positive
  // charges, since a genuine reduction still prints as a smaller LINE ITEM,
  // never as an unclaimed larger figure). An unclaimed value LARGER than
  // the shared winner is therefore positive evidence the role assignment
  // itself is wrong (exactly Mademoiselle: 50.85 > 45.00) — an unclaimed
  // value smaller than or equal to it is exactly what an informational
  // breakdown of a tax-inclusive total looks like, and must not block the
  // coincidence on its own.
  //
  // "Unclaimed" still means genuinely unclaimed — a bare ledger-fallback
  // entry (`ledger_`-prefixed id) that no block or assignment ever
  // referenced. A candidate that DOES come from a real summary block is not
  // "left to claim" in the same sense (GPT's own segmentation recognized it
  // as summary content), but as of FIX 17 Part 1 it is NOT given any role
  // on that basis alone either — it falls through to the loop below and
  // surfaces as UNRESOLVED, exactly like a ledger_ orphan would, since
  // having a block only proves territory, never a financial role (see that
  // loop's own comment for the FALSE_VALID this used to permit).
  const totalWinnerId = totalResolution && !("ambiguous" in totalResolution) ? totalResolution.winnerId : null;
  const subtotalWinnerId = subtotalResolution && !("ambiguous" in subtotalResolution) ? subtotalResolution.winnerId : null;

  if (subtotalWinnerId !== null && totalWinnerId !== null && subtotalWinnerId === totalWinnerId) {
    const winner = totalCandidates.find((c) => c.id === subtotalWinnerId)!;
    const unclaimedOrphans = totalCandidates.filter((c) => c.id !== subtotalWinnerId && c.id.startsWith("ledger_"));
    // Strictly larger, not "larger or equal": an unclaimed value EQUAL to
    // the winner is an echo/duplicate print of the same total, not evidence
    // that a bigger, real total was missed. Note: after FIX 17 Part 1, any
    // OTHER non-winning candidate (this ledger_ check or not) ends up
    // UNRESOLVED regardless of whether this branch refuses or permits — the
    // choice below still matters for the DIAGNOSTIC shape (a duplicate-role
    // claim vs. a clean single winner plus unresolved leftovers), but safety
    // no longer depends on it alone.
    const largerOrphan = unclaimedOrphans.find((c) => c.entry.value > winner.entry.value);
    if (largerOrphan) {
      // Refused: something LARGER in the summary region is still unclaimed
      // — never assume it's compatible with the shared winner. Recorded as
      // a genuine duplicate-role claim so findSummaryDuplicateRoles
      // surfaces it and the receipt is treated as unresolved, not silently
      // accepted.
      summaryRoleAssignments.push({ amountId: winner.entry.amountId, role: "SUBTOTAL" });
      summaryRoleAssignments.push({ amountId: winner.entry.amountId, role: "GRAND_TOTAL" });
    } else {
      // Nothing LARGER to explain — a genuinely tax/charge-free receipt, or
      // a tax-inclusive one whose informational breakdown is all smaller.
      summaryRoleAssignments.push({ amountId: winner.entry.amountId, role: "GRAND_TOTAL" });
    }
  } else {
    if (subtotalWinnerId !== null) {
      const w = totalCandidates.find((c) => c.id === subtotalWinnerId)!;
      summaryRoleAssignments.push({ amountId: w.entry.amountId, role: "SUBTOTAL" });
    }
    if (totalWinnerId !== null) {
      const w = totalCandidates.find((c) => c.id === totalWinnerId)!;
      summaryRoleAssignments.push({ amountId: w.entry.amountId, role: "GRAND_TOTAL" });
    }
  }

  const winningAmountIds = new Set<string>([
    ...(subtotalWinnerId !== null ? [totalCandidates.find((c) => c.id === subtotalWinnerId)!.entry.amountId] : []),
    ...(totalWinnerId !== null ? [totalCandidates.find((c) => c.id === totalWinnerId)!.entry.amountId] : []),
  ]);

  // Every candidate that didn't win either role is surfaced, not dropped —
  // whether it failed to close at all, or was refused by the check above. A
  // ledger-derived candidate that DID win is now "claimed" (it became the
  // total/subtotal), so it must not also fall through the orphan pass below
  // as unclaimed evidence.
  for (const c of totalCandidates) {
    if (winningAmountIds.has(c.entry.amountId)) {
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
    // FIX 17 Part 1 — this candidate came from a real summary BLOCK, not a
    // bare ledger_ fallback, but that is proof the block-territory EXISTS,
    // never proof of what its financial role is. The FIX 15.3 exception
    // that assigned NON_CHARGE_INFORMATIONAL here purely because "it has a
    // block and didn't win" was a deterministic FALSE_VALID hole: the exact
    // same 45.00/5.85/50.85 figures that FIX 15.1 correctly refuses when
    // 5.85/50.85 arrive as bare ledger_ orphans sail straight through
    // uncontested the moment GPT happens to segment them into their own
    // blocks — a coin flip of GPT's non-deterministic segmentation (FIX 13)
    // deciding a safety outcome. No positive evidence of "informational"
    // exists here (see docs/design/summary-closure-identity-graph.md's
    // negative-result section — base×rate=charge is structurally identical
    // whether the charge is disclosed detail or a real, uncounted addition
    // to the total, and no generic signal distinguishes them). Left
    // deliberately unassigned — classifySummaryCoverage reports it
    // UNRESOLVED, the same honest "we don't know" as a ledger_ orphan gets.
    // Still surfaced above via unresolvedLines, never silently dropped.
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

  return {
    payload,
    orphanCount,
    summaryRoleAssignments,
    priceKindOverrides,
    totalWitness: witnessCandidate ? totalWitness : null,
    itemSumPlusChargesMinor: itemSumMinor + chargesMinor,
    itemSumMinor,
  };
}
