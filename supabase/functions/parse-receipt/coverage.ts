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
  /** FIX 19, redefined FIX 21 — a decimal-shaped occurrence that never won
   *  any assignment of its own, but sits on the SAME line or the
   *  IMMEDIATELY adjacent one as a value some item/modifier block DID
   *  claim, EXACTLY equal (minor units, no tolerance) to that claimed
   *  value. FIX 19 additionally required `entry` to sit inside that SAME
   *  block's own lineIndices ("territory"); FIX 21 dropped that
   *  requirement — GPT's segmentation (which block a line ends up in)
   *  varies between runs, while line adjacency (from OCR) does not, so
   *  position replaced block membership as the qualifying condition. FIX
   *  11 deliberately excludes a secondary printed column (a "Preco: X/Uni"
   *  unit-price annotation) from ownership candidacy — this state is
   *  coverage.ts learning about that exclusion after the fact, not a new
   *  guess: the amountId is never assigned a role, no value changes, and
   *  no arithmetic depends on it — it is a PROVEN duplicate of evidence
   *  already counted, nothing more. Never used when the matching claimed
   *  value is merely similar, on a farther line, or absent — see
   *  findEchoOwner's own comment. */
  | "ECHO_OF_CLAIMED_VALUE"
  /** FIX 20, redefined FIX 21 — a sibling of ECHO_OF_CLAIMED_VALUE, not a
   *  reuse of it: the evidence shape is different (a verified arithmetic
   *  relationship, candidate x quantity = claimed, not a bare duplicate),
   *  and the two are worth counting separately as distinct signals about
   *  how a receipt prints its secondary column ("Preco: X/Uni" on a
   *  quantity=1 line vs. quantity>1). Like ECHO_OF_CLAIMED_VALUE, FIX 21
   *  dropped the same-block ("territory") requirement in favor of same-or-
   *  adjacent-line — see that state's comment for why. The claiming
   *  block's own `quantity` is untrusted GPT output, but this state never
   *  spends that trust — it only uses `quantity` to predict a product,
   *  then verifies the product in exact minor-unit arithmetic against a
   *  value already on the ledger. A wrong `quantity` makes the product
   *  fail to match and the candidate stays UNRESOLVED — the same closed-
   *  fails-safe shape as FIX 7.2's residual guard. Never used when
   *  quantity <= 1 (that is exactly ECHO_OF_CLAIMED_VALUE's job, an exact
   *  duplicate, not a product), and never when the product is merely
   *  close — zero tolerance, see findMultiplicativeEchoOwner. */
  | "ECHO_MULTIPLICATIVE_OF_CLAIMED_VALUE"
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
/**
 * FIX 21 — one claim already on the ledger: a value some item/modifier
 * block's own assignment claims, together with the quantity of the block
 * that claims it. Built once per classifyCoverage call (see `buildClaims`)
 * and shared by both echo finders below.
 *
 * FIX 19/20 originally required `entry` to sit inside the SAME block that
 * owns the claim ("territory"). FIX 18's investigation proved that
 * requirement was the actual bottleneck: GPT frequently segments a
 * "Preco: X/Uni" annotation into its OWN sibling MODIFIER block, parented
 * to the item but never merged into its lineIndices — so `entry`'s
 * "territory" resolved to that empty sibling, which claims nothing, and
 * the arithmetic was never even reached, even though hand verification
 * confirmed it would have closed exactly against the true parent item.
 * FIX 21 drops the block-membership requirement entirely: line ADJACENCY
 * (deterministic, from OCR, stable across runs) replaces block territory
 * (from GPT's segmentation, which varies between runs and receipts) as the
 * qualifying condition. What remains untouched: exact minor-unit
 * arithmetic, strict same-or-adjacent-line, and quantity verified rather
 * than trusted — see findEchoOwner/findMultiplicativeEchoOwner.
 */
interface Claim {
  entry: LedgerEntry;
  quantity: number | null;
  blockId: string;
}

function buildClaims(blocks: StructureBlock[], blockClaims: Map<string, string>, ledgerByAmountId: Map<string, LedgerEntry>): Claim[] {
  const claims: Claim[] = [];
  for (const b of blocks) {
    if (b.kind !== "item" && b.kind !== "modifier") continue; // never summary/unclassified/quantity
    const claimedAmountId = blockClaims.get(b.blockId);
    if (!claimedAmountId) continue;
    const claimedEntry = ledgerByAmountId.get(claimedAmountId);
    if (!claimedEntry) continue;
    claims.push({ entry: claimedEntry, quantity: b.quantity, blockId: b.blockId });
  }
  return claims;
}

/**
 * FIX 21 — is `entry` a proven exact echo of ANY item/modifier claim on the
 * same or immediately adjacent line? Two conditions, both required:
 *   1. some claim sits on the SAME line as `entry`, or the IMMEDIATELY
 *      adjacent one — never farther (see the Quebra Mar FINO case, CF).
 *   2. that claim's value is EXACTLY equal to `entry`'s value in minor
 *      units — no tolerance. Both values are already known to be
 *      2-decimal-shaped (the caller only calls this for `/[.,]\d{2}$/`
 *      matches), so `Math.round(v * 100)` is a safe, currency-agnostic
 *      minor-unit comparison here.
 * No block-membership condition — see the Claim interface's comment for
 * why. Returns the first matching claim, or null — never guesses.
 */
function findEchoOwner(entry: LedgerEntry, claims: Claim[]): Claim | null {
  const entryMinor = Math.round(entry.value * 100);
  return (
    claims.find((c) => Math.abs(c.entry.lineIndex - entry.lineIndex) <= 1 && Math.round(c.entry.value * 100) === entryMinor) ?? null
  );
}

/**
 * FIX 21 — is `entry` a proven multiplicative echo of ANY item/modifier
 * claim on the same or immediately adjacent line: `entry * that claim's
 * own quantity` reconstructs the claimed value exactly? Conditions:
 *   1. same-or-adjacent line (shared with findEchoOwner).
 *   2. the claiming block reports `quantity > 1` (quantity===1 degenerates
 *      to a bare duplicate — findEchoOwner's job, not this one).
 *   3. `entry.value * quantity === claim.value` in EXACT minor-unit
 *      integer arithmetic — computed as `round(entry*100) * quantity ===
 *      round(claim*100)`, never as floating-point multiplication of the
 *      major-unit values, which can misround (e.g. 1.15 * 3 in IEEE754).
 *      `quantity` is GPT output and untrusted; this is exactly why the
 *      check must be exact — a wrong quantity almost never produces an
 *      exact cent match by chance, so the arithmetic verifies the quantity
 *      rather than assuming it. No tolerance, ever.
 * No block-membership condition — see the Claim interface's comment for
 * why. Returns the first matching claim, or null — never guesses.
 */
function findMultiplicativeEchoOwner(entry: LedgerEntry, claims: Claim[]): Claim | null {
  const entryMinor = Math.round(entry.value * 100);
  return (
    claims.find(
      (c) =>
        Math.abs(c.entry.lineIndex - entry.lineIndex) <= 1 &&
        c.quantity !== null &&
        c.quantity > 1 &&
        entryMinor * c.quantity === Math.round(c.entry.value * 100)
    ) ?? null
  );
}

/**
 * FIX 23 — the mirror question to findMultiplicativeEchoOwner, asked from
 * the CLAIMED value's own side: does `claimedEntry` (an item block's own
 * claimed value, with that block's `quantity`) have an adjacent unit-price
 * annotation proving it is ALREADY a line total? First investigated in FIX
 * 13 — a real Ramires run flipped `priceKind` from lineTotal to unit on
 * four quantity>1 items between runs (Cola Zero, Cerveja Copo, Pão,
 * Manteiga; structuralGap stayed 0 throughout — coverage was perfect, only
 * the MEANING of the correctly-claimed value changed), which then got
 * double/triple-counted by the deterministic arithmetic engine. FIX 13
 * couldn't implement this because territory-by-block blocked the
 * adjacency check the same way it blocked FIX 19/20; FIX 21 removed that
 * requirement, so this is now buildable with the identical arithmetic
 * FIX 20 already ships (candidate * quantity = claimed, exact minor
 * units, quantity verified never trusted — a wrong quantity fails the
 * product and this returns false, never a guess). One-directional by
 * design: proves a claimed value IS a total, never the reverse (there is
 * no equally strong signal that would prove a value is NOT a total).
 */
export function claimedValueHasUnitPriceAnnotation(claimedEntry: LedgerEntry, quantity: number, ledger: LedgerEntry[]): boolean {
  if (quantity <= 1) return false;
  const claimedMinor = Math.round(claimedEntry.value * 100);
  return ledger.some((e) => {
    if (e.amountId === claimedEntry.amountId) return false;
    if (!/[.,]\d{2}$/.test(e.rawText)) return false;
    if (Math.abs(e.lineIndex - claimedEntry.lineIndex) > 1) return false;
    return Math.round(e.value * 100) * quantity === claimedMinor;
  });
}

export function classifyCoverage(
  blocks: StructureBlock[],
  assignments: Assignment[],
  ledger: LedgerEntry[],
  itemsRegionEnd: number
): CoverageEntry[] {
  const blockById = new Map(blocks.map((b) => [b.blockId, b]));
  const claimedBy = new Map<string, string>(); // amountId -> blockId
  const blockClaims = new Map<string, string>(); // blockId -> amountId, the reverse
  for (const a of assignments) {
    if (a.amountId !== null && !claimedBy.has(a.amountId)) claimedBy.set(a.amountId, a.blockId);
    if (a.amountId !== null && !blockClaims.has(a.blockId)) blockClaims.set(a.blockId, a.amountId);
  }
  const ledgerByAmountId = new Map(ledger.map((e) => [e.amountId, e]));
  const claims = buildClaims(blocks, blockClaims, ledgerByAmountId); // FIX 21 — built once, shared by both echo finders

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
      continue;
    }

    const echoOwner = findEchoOwner(entry, claims);
    if (echoOwner) {
      entries.push({ amountId: entry.amountId, lineIndex: entry.lineIndex, state: "ECHO_OF_CLAIMED_VALUE", claimedByBlockId: echoOwner.blockId });
      continue;
    }

    const multiplicativeEchoOwner = findMultiplicativeEchoOwner(entry, claims);
    if (multiplicativeEchoOwner) {
      entries.push({
        amountId: entry.amountId,
        lineIndex: entry.lineIndex,
        state: "ECHO_MULTIPLICATIVE_OF_CLAIMED_VALUE",
        claimedByBlockId: multiplicativeEchoOwner.blockId,
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
  /** FIX 19 — proven exact echoes of an already-claimed value (see
   *  ECHO_OF_CLAIMED_VALUE). Counted separately from
   *  `unresolvedLoadBearingCount` and never blocks `valid` — it changes no
   *  value and backs no new financial claim, it only explains an
   *  occurrence coverage.ts would otherwise have flagged unexplained. */
  echoExactCount: number;
  /** FIX 20 — proven multiplicative echoes: candidate * block.quantity =
   *  claimed value, exact minor-unit arithmetic (see
   *  ECHO_MULTIPLICATIVE_OF_CLAIMED_VALUE). Counted separately from
   *  echoExactCount — different evidence shape, useful as its own signal
   *  about a receipt's secondary-column format — and, like echoExactCount,
   *  never blocks `valid`. */
  echoMultiplicativeCount: number;
  /** Genuine misses only, as of FIX 19/20 — a proven echo (exact or
   *  multiplicative) is no longer UNRESOLVED, so this field's meaning
   *  narrows accordingly without any change to its name or its role in
   *  `valid` below. */
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
  const echoExactCount = coverage.filter((c) => c.state === "ECHO_OF_CLAIMED_VALUE").length;
  const echoMultiplicativeCount = coverage.filter((c) => c.state === "ECHO_MULTIPLICATIVE_OF_CLAIMED_VALUE").length;
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
    echoExactCount,
    echoMultiplicativeCount,
    unresolvedLoadBearingCount,
    duplicateOwnershipCount: duplicates.length,
    ownershipInvalidCount,
    reconciles,
  };
}

// ─── FIX 15 — summary monetary coverage ─────────────────────────────────────
//
// The items-region coverage above (FIX 7) proved that reconciliation success
// is never sufficient evidence of correctness — a dropped value silently
// absorbed elsewhere can still reconcile by coincidental cancellation. The
// same failure class exists in the summary region, and a real receipt
// (Mademoiselle Raw Bar & Grill) proved it: item subtotal (45.00) matched
// the printed subtotal (45.00) exactly, `reconciles` came back true, and
// the SAME 45.00 occurrence silently satisfied both the subtotal role and
// the grand-total role — the real printed tax (5.85) and real printed total
// (50.85) were never explained, only pushed into `unresolvedLines`, which
// `reconcile()` has never consulted (see reconcile.ts's own comment on why
// items-region noise is deliberately excluded from `reconciles` — that
// reasoning does not extend to unexplained SUMMARY money).
//
// Root cause traced in validate.ts's buildFinalPayload: `totalResolution`
// and `subtotalResolution` are each computed by resolveClosure() against
// their own target (itemSum+charges, and itemSum alone) over the SAME
// candidate pool, entirely independently — nothing stops them from
// returning the same winnerId, and when no charge was detected the two
// targets are numerically identical, so whichever single candidate closes
// wins BOTH roles. Reconciliation itself never looks at coverage at all.
//
// This section makes summary coverage an explicit, checked invariant,
// exactly parallel to the items-region one: every load-bearing (decimal-
// shaped) monetary occurrence at or after the summary boundary must end in
// exactly one explicit financial role, and no occurrence may back more than
// one role except through the single, narrow, structurally-justified
// exception documented at its call site in validate.ts (subtotal and total
// may share one occurrence ONLY when nothing else in the summary region is
// left unexplained — never merely because the two values are equal).

// FIX 17 Part 1 — NON_CHARGE_INFORMATIONAL removed. It was produced in
// exactly one place (validate.ts's losing-candidate loop) purely because a
// candidate "had a block and didn't win" — never because anything proved
// it informational. That gap was a deterministic FALSE_VALID hole (see
// this file's history / docs/design/summary-closure-identity-graph.md's
// negative-result section): identical figures resolve safely as UNRESOLVED
// when they arrive as bare ledger orphans and unsafely as "informational"
// when GPT's non-deterministic segmentation happens to give them their own
// block. No generic, merchant/language-independent signal was found that
// distinguishes a genuinely informational disclosure from a real,
// uncounted charge (base×rate=value has the identical shape for both) — a
// role must never exist as a euphemism for "we didn't bother resolving
// this." Losing candidates now always surface as UNRESOLVED.
export type SummaryRole =
  | "SUBTOTAL"
  | "GRAND_TOTAL"
  | "TAX"
  | "SERVICE_CHARGE"
  | "TIP"
  | "DISCOUNT"
  | "FEE"
  | "UNRESOLVED"
  | "PROVEN_NON_ADDITIVE";

/** One decided role for one observed summary amountId. Built by
 *  validate.ts's buildFinalPayload from the exact same resolution it
 *  already computes — this records the decision, it does not make a new
 *  one and does not change buildFinalPayload's existing payload/orphanCount
 *  output. */
export interface SummaryRoleAssignment {
  amountId: string;
  /** PROVEN_NON_ADDITIVE is deliberately excluded here too — it is never a
   *  per-occurrence decision buildFinalPayload makes (nothing "won" that
   *  role), only a blanket reclassification applyProvenNonAdditive applies
   *  afterward, over the whole UNRESOLVED set at once, and only when its
   *  own four guards hold. See that function's header. */
  role: Exclude<SummaryRole, "UNRESOLVED" | "PROVEN_NON_ADDITIVE">;
}

export interface SummaryCoverageEntry {
  amountId: string;
  lineIndex: number;
  role: SummaryRole;
}

/**
 * Every decimal-shaped ledger entry at or after the summary boundary,
 * classified by whichever role (if any) claimed it. An entry whose LINE
 * sits inside some summary block's broad territory but whose specific
 * amountId no role assignment actually references is UNRESOLVED here —
 * block territory is never treated as sufficient explanation on its own
 * (FIX 15D): three monetary occurrences inside one summary block's line
 * span are three independent observations, not one.
 */
export function classifySummaryCoverage(
  ledger: LedgerEntry[],
  summaryRegionStart: number,
  assignments: SummaryRoleAssignment[]
): SummaryCoverageEntry[] {
  const roleByAmount = new Map<string, SummaryRole>();
  for (const a of assignments) {
    // First assignment wins for classification purposes — a SECOND
    // assignment on the same amountId is a duplicate-role attempt, surfaced
    // separately by findSummaryDuplicateRoles, not silently overwritten here.
    if (!roleByAmount.has(a.amountId)) roleByAmount.set(a.amountId, a.role);
  }

  const entries: SummaryCoverageEntry[] = [];
  for (const entry of ledger) {
    if (entry.lineIndex < summaryRegionStart) continue;
    if (!/[.,]\d{2}$/.test(entry.rawText)) continue; // bare-integer noise is never load-bearing, same rule as items region
    entries.push({
      amountId: entry.amountId,
      lineIndex: entry.lineIndex,
      role: roleByAmount.get(entry.amountId) ?? "UNRESOLVED",
    });
  }
  return entries;
}

export interface SummaryDuplicateRole {
  amountId: string;
  roles: SummaryRole[];
}

/** FIX 15B — exclusive financial role ownership: one observed amountId may
 *  back at most one summary role. This is the same "reconciliation can
 *  succeed through coincidental cancellation" class findDuplicateOwnership
 *  already guards against in the items region, applied to subtotal/tax/
 *  service/tip/discount/fee/total instead of item/modifier prices. */
export function findSummaryDuplicateRoles(assignments: SummaryRoleAssignment[]): SummaryDuplicateRole[] {
  const byAmount = new Map<string, SummaryRole[]>();
  for (const a of assignments) {
    const list = byAmount.get(a.amountId) ?? [];
    list.push(a.role);
    byAmount.set(a.amountId, list);
  }
  return [...byAmount.entries()]
    .filter(([, roles]) => roles.length > 1)
    .map(([amountId, roles]) => ({ amountId, roles }));
}

export interface SummaryValidityResult {
  valid: boolean;
  summaryMonetaryObservationCount: number;
  summaryClaimedAmountCount: number;
  summaryUnresolvedAmountCount: number;
  summaryDuplicateRoleAttemptCount: number;
}

/**
 * FIX 15E/F — a summary interpretation closes only when every load-bearing
 * summary monetary occurrence has an explicit, single role. Arithmetic
 * reconciliation success is never sufficient on its own and never overrides
 * this — callers must AND this into their final `reconciles`/`valid`
 * signal, the same way determineValidity already does for items-region
 * coverage; this function never looks at reconciliation itself.
 */
/**
 * FIX 15.3A — a receipt is never valid unless SOME observed amount was
 * actually resolved as GRAND_TOTAL. Full coverage (every occurrence has
 * some role) is not enough on its own: a receipt where the total-closure
 * search finds nothing to close against (validate.ts's resolveClosure
 * returning null for the total target — no name, no merchant, no language
 * involved) can reach 100% coverage with every remaining candidate
 * demoted to NON_CHARGE_INFORMATIONAL, INCLUDING the receipt's own real,
 * printed total — while the field the customer actually cares about stays
 * unset. Confirmed on a real receipt (Pai Northern Thai Kitchen): item
 * subtotal reconciled exactly, every summary-region value had a role, and
 * `reconciles` reported true while the printed total (376.97) was demoted
 * to "informational" next to the wrong 278.00 subtotal.
 *
 * No exception for an empty coverage set: if the summary region disclosed
 * nothing at all, there is no observed evidence of what the customer paid,
 * and this function must not call that state valid — `coverage.some(...)`
 * on an empty array is already `false`, so this requires no special case.
 */
export function determineSummaryValidity(
  coverage: SummaryCoverageEntry[],
  duplicates: SummaryDuplicateRole[]
): SummaryValidityResult {
  const unresolved = coverage.filter((c) => c.role === "UNRESOLVED").length;
  const hasGrandTotal = coverage.some((c) => c.role === "GRAND_TOTAL");
  return {
    valid: unresolved === 0 && duplicates.length === 0 && hasGrandTotal,
    summaryMonetaryObservationCount: coverage.length,
    summaryClaimedAmountCount: coverage.length - unresolved,
    summaryUnresolvedAmountCount: unresolved,
    summaryDuplicateRoleAttemptCount: duplicates.length,
  };
}

// ─── FIX 32 Part 2 — arithmetic saturation, with an independent base ───────
//
// FIX 29 tried "if the item sum already equals the printed total, no
// unclassified summary value can be a real, uncounted charge — summing
// anything more would break an equality that already holds." The logic was
// sound; the implementation was circular, because `GRAND_TOTAL` was ONLY
// ever assigned to a candidate whose own value already equalled
// itemSum + charges (validate.ts's resolveClosure) — the check re-derived
// the exact fact it claimed to prove, so it could never distinguish Quebra
// Mar's genuine VAT-rate table from the FIX 16 BP/BQ scenarios' real,
// missing charge.
//
// FIX 31 gives GRAND_TOTAL a source that never touches itemSum at all — a
// printed label or typographic emphasis, found in the raw OCR independent
// of any arithmetic. With that, the equality this function checks is no
// longer measuring its own premise: it is testing a claim (itemSum +
// charges equals an INDEPENDENTLY identified total) that could fail, and
// on BP/BQ's own shapes, does.
//
// Four guards, every one load-bearing — this function refuses (returns the
// coverage UNCHANGED) unless every one holds:
//   1. the total came from a witness (label/typography), never from
//      closure — otherwise the equality below is circular again, exactly
//      the FIX 29 trap.
//   2. itemSum + recognized charges EXACTLY equals that independently
//      identified total, in minor units, zero tolerance — this is the
//      actual proof: the books already balance, so nothing more can fit.
//   3. no UNRESOLVED summary value is LARGER than the total — this is what
//      catches BP (a real, missing 50.85 charge sitting unclaimed) even
//      when guard 2 might otherwise coincidentally hold on some other
//      shape; a real total is never smaller than a real charge that
//      belongs to it.
//   4. no UNRESOLVED value anywhere in the ITEMS region — Sulbarreiro's
//      six-to-nine stray decimals are real modifier prices an OCR-batched
//      layout dropped, never decoration, and this function must never
//      touch them; they keep blocking `valid` exactly as before, via the
//      unrelated items-region coverage check this function doesn't run.
export interface ProvenNonAdditiveResult {
  applied: boolean;
  /** How many summary-region UNRESOLVED entries were reclassified. 0 when
   *  `applied` is false. */
  count: number;
  /** Which guard refused, when `applied` is false — null only when applied
   *  is true. Purely diagnostic. */
  blockedBy:
    | "no_independent_total"
    | "sum_mismatch"
    | "larger_unresolved_value"
    | "items_region_unresolved"
    | null;
}

export function applyProvenNonAdditive(
  summaryCoverage: SummaryCoverageEntry[],
  ledgerByAmountId: Map<string, LedgerEntry>,
  /** Guard 1 — null means the total was never identified at all, or was
   *  identified by arithmetic closure (the circular case). Only "label" or
   *  "typography" (see totalWitness.ts) count as independent. */
  totalWitnessSource: "label" | "typography" | null,
  totalValueMinor: number | null,
  itemSumPlusChargesMinor: number,
  /** Guard 4 — `determineValidity`'s own `unresolvedLoadBearingCount` for
   *  the ITEMS region, computed by the caller exactly as it already was
   *  before this function existed; never recomputed here. */
  itemsRegionUnresolvedCount: number,
  /** Same currency-to-minor-units convention as reconcile.ts's own toMinor
   *  (100 per major unit, except a handful of zero-decimal currencies) —
   *  needed here only to compare each unresolved entry's own value against
   *  totalValueMinor on the same footing guard 2 already used. */
  toMinorFn: (value: number) => number | null
): { coverage: SummaryCoverageEntry[]; result: ProvenNonAdditiveResult } {
  const refuse = (blockedBy: ProvenNonAdditiveResult["blockedBy"]) => ({
    coverage: summaryCoverage,
    result: { applied: false, count: 0, blockedBy },
  });

  if (totalWitnessSource === null || totalValueMinor === null) return refuse("no_independent_total");
  if (itemSumPlusChargesMinor !== totalValueMinor) return refuse("sum_mismatch");

  const unresolvedEntries = summaryCoverage.filter((c) => c.role === "UNRESOLVED");
  const hasLargerOrphan = unresolvedEntries.some((c) => {
    const entry = ledgerByAmountId.get(c.amountId);
    if (!entry) return false;
    const entryMinor = toMinorFn(entry.value);
    return entryMinor !== null && entryMinor > totalValueMinor;
  });
  if (hasLargerOrphan) return refuse("larger_unresolved_value");

  if (itemsRegionUnresolvedCount > 0) return refuse("items_region_unresolved");

  const newCoverage = summaryCoverage.map((c) => (c.role === "UNRESOLVED" ? { ...c, role: "PROVEN_NON_ADDITIVE" as const } : c));
  return { coverage: newCoverage, result: { applied: true, count: unresolvedEntries.length, blockedBy: null } };
}
