/**
 * receiptDiagnostics — error localisation.
 *
 * When reconciliation fails, this module tries to answer *where* the parse went
 * wrong, and proposes the smallest correction that would explain the delta.
 *
 * Design rules:
 *  - Never force a diagnosis. Low-fit candidates are reported as `unclassified`
 *    with low confidence rather than a confident wrong guess.
 *  - Prefer the smallest plausible correction. A single missing modifier beats
 *    a three-line subset that happens to sum correctly.
 *  - Never mutate the receipt. Proposals are inert until the user applies them.
 */

import {
  type CurrencyCode,
  type Money,
  moneyFromMinor,
  moneyToDecimalString,
} from "./money";
import {
  type CanonicalReceipt,
  type ConfidenceLevel,
  type CorrectionProposal,
  type ReceiptIssue,
  type ReceiptIssueType,
  type ReceiptLineItem,
  type UnresolvedMonetaryLine,
  confidenceFromScore,
  nextEntityId,
} from "./model";
import { recomputeTotals } from "./normalizer";
import { chargeConsistencyDelta, reconcileReceipt } from "./reconciler";

// ─── Tunables ─────────────────────────────────────────────────────────────────

/** Largest orphan-line subset considered when explaining a delta. */
const MAX_SUBSET_SIZE = 3;

/** Candidates below this fit score are not surfaced as actionable. */
const MIN_REPORTABLE_CONFIDENCE = 0.2;

/** Maximum issues returned to the UI. */
const MAX_ISSUES = 5;

// ─── Candidate scaffolding ────────────────────────────────────────────────────

interface Candidate {
  type: ReceiptIssueType;
  /** 0..1 before penalties. Exact arithmetic fit scores 1. */
  fit: number;
  /** Multiplicative penalties for weak structure / large corrections. */
  penalties: number[];
  itemId?: string;
  modifierId?: string;
  sourceLine?: string;
  expectedDifference?: Money;
  message: string;
  proposal?: CorrectionProposal;
}

function scoreOf(candidate: Candidate): number {
  let score = candidate.fit;
  for (const penalty of candidate.penalties) score *= penalty;
  return Math.max(0, Math.min(1, score));
}

function formatAmount(money: Money): string {
  return `${moneyToDecimalString(money)} ${money.currency}`;
}

// ─── Subset search over unresolved lines ──────────────────────────────────────

interface Subset {
  lines: UnresolvedMonetaryLine[];
  total: number;
}

/**
 * Enumerate subsets of unresolved lines up to `MAX_SUBSET_SIZE`, returning
 * those whose sum equals `targetMinor` exactly.
 *
 * Bounded by construction: receipts carry a handful of orphan lines, and the
 * size cap keeps this well clear of combinatorial blow-up.
 */
function findExactSubsets(
  lines: readonly UnresolvedMonetaryLine[],
  targetMinor: number
): Subset[] {
  const results: Subset[] = [];
  const candidates = lines.filter((line) => line.amount.minor !== 0);

  const walk = (
    startIndex: number,
    picked: UnresolvedMonetaryLine[],
    total: number
  ): void => {
    if (picked.length > 0 && total === targetMinor) {
      results.push({ lines: [...picked], total });
      // Continue: a longer subset may exist but will rank lower anyway.
    }
    if (picked.length >= MAX_SUBSET_SIZE) return;

    for (let i = startIndex; i < candidates.length; i += 1) {
      const line = candidates[i];
      picked.push(line);
      walk(i + 1, picked, total + line.amount.minor);
      picked.pop();
    }
  };

  walk(0, [], 0);
  // Smallest subsets first — the minimal explanation is preferred.
  results.sort((a, b) => a.lines.length - b.lines.length);
  return results;
}

// ─── Candidate generators ─────────────────────────────────────────────────────

/**
 * The delta is exactly explained by one or more unattributed priced lines.
 * This is the highest-signal diagnosis available: the money was read off the
 * receipt correctly, it simply was not attached to anything.
 */
function orphanCandidates(
  receipt: CanonicalReceipt,
  deltaMinor: number
): Candidate[] {
  if (deltaMinor <= 0) return [];

  const subsets = findExactSubsets(receipt.unresolvedMonetaryLines, deltaMinor);
  const candidates: Candidate[] = [];

  for (const subset of subsets.slice(0, 3)) {
    for (const line of subset.lines) {
      const parent = line.nearestItemId
        ? receipt.items.find((item) => item.id === line.nearestItemId)
        : undefined;

      // Multi-line subsets are a weaker explanation than a single line.
      const sizePenalty = subset.lines.length === 1 ? 1 : 0.75;

      if (parent !== undefined) {
        candidates.push({
          type: "missing_paid_modifier",
          fit: 1,
          penalties: [sizePenalty],
          itemId: parent.id,
          sourceLine: line.text,
          expectedDifference: line.amount,
          message:
            `An unassigned ${formatAmount(line.amount)} line was found directly ` +
            `below "${parent.name}". It may be a paid extra that was not counted.`,
          proposal: {
            kind: "add_modifier",
            itemId: parent.id,
            name: line.text ?? "Extra",
            price: line.amount,
            resolvesOrphanId: line.id,
          },
        });
      } else {
        candidates.push({
          type: "orphan_price",
          fit: 1,
          penalties: [sizePenalty, 0.9],
          sourceLine: line.text,
          expectedDifference: line.amount,
          message:
            `A ${formatAmount(line.amount)} line was read from the receipt but ` +
            `could not be matched to any item.`,
          proposal: {
            kind: "add_item",
            name: line.text ?? "Unmatched item",
            quantity: 1,
            unitPrice: line.amount,
            resolvesOrphanId: line.id,
          },
        });
      }
    }
  }

  return candidates;
}

/**
 * A modifier the model flagged as paid but could not price. If the delta could
 * be that modifier's price, say so.
 */
function unpricedModifierCandidates(
  receipt: CanonicalReceipt,
  deltaMinor: number,
  currency: CurrencyCode
): Candidate[] {
  if (deltaMinor <= 0) return [];
  const candidates: Candidate[] = [];

  const unpriced = receipt.items.flatMap((item) =>
    item.modifiers
      .filter((modifier) => modifier.kind === "unknown")
      .map((modifier) => ({ item, modifier }))
  );

  if (unpriced.length === 0) return [];

  // With exactly one unpriced modifier, the whole delta is very likely its price.
  const soleCandidate = unpriced.length === 1;

  for (const { item, modifier } of unpriced) {
    candidates.push({
      type: "missing_paid_modifier",
      fit: soleCandidate ? 0.95 : 0.6,
      penalties: [],
      itemId: item.id,
      modifierId: modifier.id,
      sourceLine: modifier.sourceEvidence?.lineText,
      expectedDifference: moneyFromMinor(deltaMinor, currency),
      message:
        `"${modifier.name}" on "${item.name}" looks like a paid extra, but its ` +
        `price could not be read.`,
      proposal: {
        kind: "add_modifier",
        itemId: item.id,
        name: modifier.name,
        price: moneyFromMinor(deltaMinor, currency),
      },
    });
  }

  return candidates;
}

/**
 * The delta matches a change to a single item's unit price.
 * Ranked by how small the correction is relative to the item.
 */
function itemPriceCandidates(
  receipt: CanonicalReceipt,
  deltaMinor: number,
  currency: CurrencyCode
): Candidate[] {
  const candidates: Candidate[] = [];

  for (const item of receipt.items) {
    if (item.unitPrice === undefined) {
      // An unpriced item is itself a strong explanation for a shortfall.
      if (deltaMinor > 0) {
        candidates.push({
          type: "incorrect_item_price",
          fit: 0.7,
          penalties: [],
          itemId: item.id,
          sourceLine: item.sourceEvidence?.lineText,
          expectedDifference: moneyFromMinor(deltaMinor, currency),
          message: `No price was read for "${item.name}".`,
          proposal: {
            kind: "set_item_unit_price",
            itemId: item.id,
            unitPrice: moneyFromMinor(
              Math.round(deltaMinor / Math.max(1, item.quantity)),
              currency
            ),
          },
        });
      }
      continue;
    }

    // Correcting this item's unit price by delta/quantity closes the gap.
    if (deltaMinor % item.quantity !== 0) continue;
    const perUnitDelta = deltaMinor / item.quantity;
    const correctedMinor = item.unitPrice.minor + perUnitDelta;
    if (correctedMinor <= 0) continue;

    // Prefer small relative corrections; a 10x change is implausible.
    const ratio = Math.abs(perUnitDelta) / Math.max(1, item.unitPrice.minor);
    if (ratio > 2) continue;
    const magnitudePenalty = ratio <= 0.5 ? 1 : 0.7;

    // Digit-level OCR confusions (23.00 vs 28.00, 15.00 vs 45.00) are much
    // likelier than arbitrary changes.
    const digitPenalty = isPlausibleDigitConfusion(
      item.unitPrice.minor,
      correctedMinor
    )
      ? 1
      : 0.55;

    const confidencePenalty =
      item.confidence !== undefined && item.confidence < 0.6 ? 1 : 0.85;

    candidates.push({
      type: "incorrect_item_price",
      fit: 0.75,
      penalties: [magnitudePenalty, digitPenalty, confidencePenalty],
      itemId: item.id,
      sourceLine: item.sourceEvidence?.lineText,
      expectedDifference: moneyFromMinor(deltaMinor, currency),
      message:
        `Changing "${item.name}" from ` +
        `${formatAmount(item.unitPrice)} to ` +
        `${formatAmount(moneyFromMinor(correctedMinor, currency))} would make the ` +
        `receipt add up.`,
      proposal: {
        kind: "set_item_unit_price",
        itemId: item.id,
        unitPrice: moneyFromMinor(correctedMinor, currency),
      },
    });
  }

  return candidates;
}

/**
 * Two prices are a plausible OCR confusion when they have the same number of
 * digits and differ in exactly one position.
 */
function isPlausibleDigitConfusion(a: number, b: number): boolean {
  const sa = Math.abs(a).toString();
  const sb = Math.abs(b).toString();
  if (sa.length !== sb.length) return false;
  let diffs = 0;
  for (let i = 0; i < sa.length; i += 1) {
    if (sa[i] !== sb[i]) diffs += 1;
    if (diffs > 1) return false;
  }
  return diffs === 1;
}

/**
 * The delta is an exact multiple of an item's unit price, i.e. the quantity
 * was misread.
 */
function quantityCandidates(
  receipt: CanonicalReceipt,
  deltaMinor: number,
  currency: CurrencyCode
): Candidate[] {
  const candidates: Candidate[] = [];

  for (const item of receipt.items) {
    if (item.unitPrice === undefined || item.unitPrice.minor === 0) continue;
    if (deltaMinor % item.unitPrice.minor !== 0) continue;

    const extraUnits = deltaMinor / item.unitPrice.minor;
    const newQuantity = item.quantity + extraUnits;
    if (newQuantity < 1 || newQuantity === item.quantity) continue;
    // Quantity corrections beyond a few units are not credible on a bill.
    if (Math.abs(extraUnits) > 10) continue;

    // Source text hinting at a different quantity is a strong signal.
    const hinted = quantityHintFromEvidence(item);
    const hintBonus = hinted === newQuantity ? 1 : 0.7;

    candidates.push({
      type: "incorrect_quantity",
      fit: 0.7,
      penalties: [hintBonus],
      itemId: item.id,
      sourceLine: item.sourceEvidence?.lineText,
      expectedDifference: moneyFromMinor(deltaMinor, currency),
      message:
        `"${item.name}" may have been ordered ${newQuantity}× rather than ` +
        `${item.quantity}×.`,
      proposal: {
        kind: "set_item_quantity",
        itemId: item.id,
        quantity: newQuantity,
      },
    });
  }

  return candidates;
}

/** Look for a leading quantity marker such as "2 x " in the source line. */
function quantityHintFromEvidence(item: ReceiptLineItem): number | undefined {
  const text = item.sourceEvidence?.lineText;
  if (text === undefined) return undefined;
  const match = /^\s*(\d{1,2})\s*[x×]?\s/i.exec(text);
  if (match === null) return undefined;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : undefined;
}

/**
 * A negative delta (we counted more than the receipt says) is most often a
 * duplicated line.
 */
function duplicateCandidates(
  receipt: CanonicalReceipt,
  deltaMinor: number,
  currency: CurrencyCode
): Candidate[] {
  if (deltaMinor >= 0) return [];
  const surplus = -deltaMinor;
  const candidates: Candidate[] = [];

  const byKey = new Map<string, ReceiptLineItem[]>();
  for (const item of receipt.items) {
    const key = `${item.name.trim().toLowerCase()}|${item.calculatedLineTotal.minor}`;
    const bucket = byKey.get(key);
    if (bucket === undefined) byKey.set(key, [item]);
    else bucket.push(item);
  }

  for (const [, group] of byKey) {
    if (group.length < 2) continue;
    const duplicate = group[group.length - 1];
    if (duplicate.calculatedLineTotal.minor !== surplus) continue;

    candidates.push({
      type: "possible_duplicate",
      fit: 0.9,
      penalties: [],
      itemId: duplicate.id,
      sourceLine: duplicate.sourceEvidence?.lineText,
      expectedDifference: moneyFromMinor(deltaMinor, currency),
      message:
        `"${duplicate.name}" appears more than once and may have been counted twice.`,
      proposal: { kind: "remove_item", itemId: duplicate.id },
    });
  }

  // Any single item whose total equals the surplus is a weaker duplicate/extra
  // candidate.
  for (const item of receipt.items) {
    if (item.calculatedLineTotal.minor !== surplus) continue;
    if (candidates.some((candidate) => candidate.itemId === item.id)) continue;
    candidates.push({
      type: "possible_duplicate",
      fit: 0.55,
      penalties: [],
      itemId: item.id,
      sourceLine: item.sourceEvidence?.lineText,
      expectedDifference: moneyFromMinor(deltaMinor, currency),
      message:
        `Removing "${item.name}" would make the receipt add up — check whether ` +
        `it belongs on this bill.`,
      proposal: { kind: "remove_item", itemId: item.id },
    });
  }

  return candidates;
}

/**
 * A positive delta equal to a plausible whole item that simply was not read.
 * Only reported when nothing more specific fits, hence the low base fit.
 */
function missingItemCandidates(
  receipt: CanonicalReceipt,
  deltaMinor: number,
  currency: CurrencyCode
): Candidate[] {
  if (deltaMinor <= 0) return [];

  // If the delta matches an existing item's total exactly, a second unit of
  // that item is the most economical explanation.
  const candidates: Candidate[] = [];
  for (const item of receipt.items) {
    if (item.calculatedLineTotal.minor !== deltaMinor) continue;
    candidates.push({
      type: "missing_item",
      fit: 0.6,
      penalties: [],
      itemId: item.id,
      sourceLine: item.sourceEvidence?.lineText,
      expectedDifference: moneyFromMinor(deltaMinor, currency),
      message:
        `The missing ${formatAmount(moneyFromMinor(deltaMinor, currency))} matches ` +
        `"${item.name}" — a second one may not have been counted.`,
      proposal: {
        kind: "add_item",
        name: item.name,
        quantity: 1,
        unitPrice: item.unitPrice ?? moneyFromMinor(deltaMinor, currency),
      },
    });
  }

  return candidates;
}

/** The item list is fine but a bill-level charge does not agree. */
function chargeCandidates(receipt: CanonicalReceipt): Candidate[] {
  const delta = chargeConsistencyDelta(receipt);
  if (delta === undefined || delta.minor === 0) return [];

  const hasTax = receipt.printedTax !== undefined;
  const hasService = receipt.printedServiceCharge !== undefined;

  let type: ReceiptIssueType = "total_error";
  if (hasTax && !hasService) type = "tax_error";
  else if (hasService && !hasTax) type = "service_error";

  return [
    {
      type,
      fit: 0.65,
      penalties: [],
      expectedDifference: delta,
      message:
        `The printed subtotal plus service and tax does not match the printed ` +
        `total (off by ${formatAmount(delta)}). One of the charge lines may have ` +
        `been misread.`,
    },
  ];
}

// ─── Ranking and assembly ─────────────────────────────────────────────────────

/**
 * Order in which issue types break ties at equal score. Earlier is preferred:
 * corrections that add information the receipt already contains rank above
 * speculative edits to values we did read.
 */
const TYPE_PRIORITY: readonly ReceiptIssueType[] = [
  "missing_paid_modifier",
  "orphan_price",
  "possible_duplicate",
  "incorrect_quantity",
  "incorrect_item_price",
  "missing_item",
  "wrong_parent_item",
  "discount_error",
  "tax_error",
  "service_error",
  "total_error",
  "unclassified",
];

function typeRank(type: ReceiptIssueType): number {
  const index = TYPE_PRIORITY.indexOf(type);
  return index === -1 ? TYPE_PRIORITY.length : index;
}

function dedupeCandidates(candidates: Candidate[]): Candidate[] {
  const seen = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const key = `${candidate.type}|${candidate.itemId ?? ""}|${
      candidate.modifierId ?? ""
    }|${candidate.expectedDifference?.minor ?? ""}`;
    const existing = seen.get(key);
    if (existing === undefined || scoreOf(candidate) > scoreOf(existing)) {
      seen.set(key, candidate);
    }
  }
  return Array.from(seen.values());
}

function toIssue(candidate: Candidate): ReceiptIssue {
  const score = scoreOf(candidate);
  const level: ConfidenceLevel = confidenceFromScore(score);
  return {
    id: nextEntityId("issue"),
    type: candidate.type,
    confidence: score,
    confidenceLevel: level,
    itemId: candidate.itemId,
    modifierId: candidate.modifierId,
    sourceLine: candidate.sourceLine,
    expectedDifference: candidate.expectedDifference,
    message: candidate.message,
    // A proposal is only offered when we are reasonably sure. Below that the
    // issue still points at the item, but the user edits it themselves.
    proposal: level === "low" ? undefined : candidate.proposal,
  };
}

export interface DiagnosisResult {
  issues: ReceiptIssue[];
  /** Highest-ranked issue, when one was found. */
  topIssue?: ReceiptIssue;
  /** True when reconciliation failed but nothing could be localised. */
  inconclusive: boolean;
}

/**
 * Diagnose a receipt that failed reconciliation.
 *
 * Returns an empty result for receipts that reconcile — callers should not
 * surface speculative warnings on a balanced receipt.
 */
export function diagnoseReceipt(receipt: CanonicalReceipt): DiagnosisResult {
  const reconciliation = reconcileReceipt(receipt);
  if (reconciliation.status === "reconciled") {
    return { issues: [], inconclusive: false };
  }

  const { currency } = receipt;
  const candidates: Candidate[] = [];

  const subtotalDelta = reconciliation.subtotalDelta;

  if (subtotalDelta !== undefined && subtotalDelta.minor !== 0) {
    const deltaMinor = subtotalDelta.minor;
    candidates.push(...orphanCandidates(receipt, deltaMinor));
    candidates.push(...unpricedModifierCandidates(receipt, deltaMinor, currency));
    candidates.push(...duplicateCandidates(receipt, deltaMinor, currency));
    candidates.push(...quantityCandidates(receipt, deltaMinor, currency));
    candidates.push(...itemPriceCandidates(receipt, deltaMinor, currency));
    candidates.push(...missingItemCandidates(receipt, deltaMinor, currency));
  }

  // Unattributed money is a defect even when the subtotal happens to agree.
  if (
    reconciliation.hasUnresolvedLines &&
    (subtotalDelta === undefined || subtotalDelta.minor === 0)
  ) {
    for (const line of receipt.unresolvedMonetaryLines) {
      if (line.amount.minor === 0) continue;
      candidates.push({
        type: "orphan_price",
        fit: 0.5,
        penalties: [],
        sourceLine: line.text,
        expectedDifference: line.amount,
        message:
          `A ${formatAmount(line.amount)} line was read from the receipt but not ` +
          `matched to any item. Please check it.`,
      });
    }
  }

  candidates.push(...chargeCandidates(receipt));

  const ranked = dedupeCandidates(candidates)
    .filter((candidate) => scoreOf(candidate) >= MIN_REPORTABLE_CONFIDENCE)
    .sort((a, b) => {
      const diff = scoreOf(b) - scoreOf(a);
      if (Math.abs(diff) > 1e-9) return diff;
      return typeRank(a.type) - typeRank(b.type);
    });

  if (ranked.length === 0) {
    // Reconciliation failed and nothing fits. Say exactly that rather than
    // inventing a culprit.
    const delta = subtotalDelta ?? reconciliation.totalDelta;
    const issue: ReceiptIssue = {
      id: nextEntityId("issue"),
      type: "unclassified",
      confidence: 0.1,
      confidenceLevel: "low",
      expectedDifference: delta,
      message:
        delta !== undefined
          ? `The items do not add up to the printed amount (off by ` +
            `${formatAmount(delta)}). We could not identify the exact cause — ` +
            `please review the items below.`
          : `This receipt could not be verified automatically. Please review the ` +
            `items below.`,
    };
    return { issues: [issue], topIssue: issue, inconclusive: true };
  }

  const issues = ranked.slice(0, MAX_ISSUES).map(toIssue);
  return { issues, topIssue: issues[0], inconclusive: false };
}

/**
 * Reconcile and diagnose in one pass, writing both onto the receipt.
 * This is the function the app should call after every parse and every edit.
 */
export function evaluateReceipt(receipt: CanonicalReceipt): CanonicalReceipt {
  // Derived amounts are recomputed first: callers hand us receipts whose items
  // have just been edited, and reconciling against stale line totals would
  // report success on a receipt that no longer adds up.
  const fresh = recomputeTotals(receipt);
  const reconciliation = reconcileReceipt(fresh);
  const diagnosis =
    reconciliation.status === "reconciled"
      ? { issues: [] as ReceiptIssue[] }
      : diagnoseReceipt(fresh);

  return {
    ...fresh,
    validation: {
      status: reconciliation.status,
      subtotalDelta: reconciliation.subtotalDelta,
      totalDelta: reconciliation.totalDelta,
      missingPrintedSubtotal: reconciliation.missingPrintedSubtotal,
      missingPrintedTotal: reconciliation.missingPrintedTotal,
      issues: diagnosis.issues,
    },
  };
}
