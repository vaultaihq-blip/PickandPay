/**
 * receiptReconciler — deterministic reconciliation of calculated vs printed
 * amounts.
 *
 * This module answers one question and nothing else: does the receipt add up?
 * It never mutates amounts and never "fixes" anything. Localisation of the
 * error lives in `diagnostics.ts`.
 */

import {
  type CurrencyCode,
  type Money,
  moneyFromMinor,
  subtractMoney,
  zeroMoney,
} from "./money";
import type {
  CanonicalReceipt,
  ReceiptValidation,
  ValidationStatus,
} from "./model";
import { recomputeTotals } from "./normalizer";

/**
 * Tolerance in minor units.
 *
 * Set to zero: a receipt either adds up or it does not. Any non-zero delta is
 * a real discrepancy the user should see, not rounding noise — all arithmetic
 * upstream is exact integer arithmetic, so genuine rounding error cannot occur.
 * A per-currency override exists only for receipts that print rounded totals
 * (e.g. cash rounding to the nearest 5 cents in some jurisdictions).
 */
const DEFAULT_TOLERANCE_MINOR = 0;

const CURRENCY_TOLERANCE_MINOR: Readonly<Record<string, number>> = {
  // Swiss cash rounding to 0.05 is routinely printed on receipts.
  CHF: 5,
};

export function toleranceForCurrency(currency: CurrencyCode): number {
  return CURRENCY_TOLERANCE_MINOR[currency] ?? DEFAULT_TOLERANCE_MINOR;
}

export interface ReconciliationResult {
  status: ValidationStatus;
  /** printedSubtotal - calculatedSubtotal. Positive => items are missing. */
  subtotalDelta?: Money;
  /** printedTotal - calculatedTotal. */
  totalDelta?: Money;
  subtotalReconciles: boolean;
  totalReconciles: boolean;
  missingPrintedSubtotal: boolean;
  missingPrintedTotal: boolean;
  /** True when a priced line was read but attributed to nothing. */
  hasUnresolvedLines: boolean;
}

function withinTolerance(delta: Money, currency: CurrencyCode): boolean {
  return Math.abs(delta.minor) <= toleranceForCurrency(currency);
}

/**
 * Reconcile a receipt.
 *
 * Status semantics:
 *   reconciled    — every printed anchor matches, no unattributed money
 *   needs_review  — at least one anchor disagrees, or money is unattributed
 *   unverifiable  — the receipt printed nothing to reconcile against
 *
 * `unverifiable` is deliberately distinct from `reconciled`: a receipt with no
 * printed subtotal has not been verified, and must never render as a green
 * "totals match" state.
 */
export function reconcileReceipt(
  receipt: CanonicalReceipt
): ReconciliationResult {
  const { currency } = receipt;

  const missingPrintedSubtotal = receipt.printedSubtotal === undefined;
  const missingPrintedTotal = receipt.printedTotal === undefined;
  const hasUnresolvedLines = receipt.unresolvedMonetaryLines.some(
    (line) => line.amount.minor !== 0
  );

  const subtotalDelta =
    receipt.printedSubtotal !== undefined
      ? subtractMoney(receipt.printedSubtotal, receipt.calculatedSubtotal)
      : undefined;

  const totalDelta =
    receipt.printedTotal !== undefined
      ? subtractMoney(receipt.printedTotal, receipt.calculatedTotal)
      : undefined;

  const subtotalReconciles =
    subtotalDelta === undefined ? false : withinTolerance(subtotalDelta, currency);
  const totalReconciles =
    totalDelta === undefined ? false : withinTolerance(totalDelta, currency);

  let status: ValidationStatus;
  if (missingPrintedSubtotal && missingPrintedTotal) {
    status = "unverifiable";
  } else if (hasUnresolvedLines) {
    // Unattributed money means the parse is incomplete even if the arithmetic
    // happens to line up.
    status = "needs_review";
  } else {
    const anchors: boolean[] = [];
    if (!missingPrintedSubtotal) anchors.push(subtotalReconciles);
    if (!missingPrintedTotal) anchors.push(totalReconciles);
    status = anchors.every(Boolean) ? "reconciled" : "needs_review";
  }

  return {
    status,
    subtotalDelta,
    totalDelta,
    subtotalReconciles,
    totalReconciles,
    missingPrintedSubtotal,
    missingPrintedTotal,
    hasUnresolvedLines,
  };
}

/**
 * Cross-check the printed subtotal against printed charges and the printed
 * total. Detects the case where the item list is correct but a bill-level
 * charge (service / tax) was misread.
 *
 * Returns the discrepancy between `printedSubtotal + charges` and
 * `printedTotal`, or undefined when the receipt lacks the anchors to tell.
 */
export function chargeConsistencyDelta(
  receipt: CanonicalReceipt
): Money | undefined {
  const { printedSubtotal, printedTotal, currency } = receipt;
  if (printedSubtotal === undefined || printedTotal === undefined) {
    return undefined;
  }

  let expected = printedSubtotal.minor;
  const printedCharges: Array<Money | undefined> = [
    receipt.printedServiceCharge,
    receipt.printedTax,
    receipt.printedTip,
  ];
  let sawAny = false;
  for (const charge of printedCharges) {
    if (charge !== undefined) {
      expected += charge.minor;
      sawAny = true;
    }
  }
  if (receipt.printedDiscount !== undefined) {
    expected -= receipt.printedDiscount.minor;
    sawAny = true;
  }
  if (!sawAny) return undefined;

  return subtractMoney(printedTotal, moneyFromMinor(expected, currency));
}

/**
 * Total of every monetary line the parse failed to attribute.
 * A strong candidate explanation for a subtotal shortfall.
 */
export function unresolvedTotal(receipt: CanonicalReceipt): Money {
  let sum = 0;
  for (const line of receipt.unresolvedMonetaryLines) sum += line.amount.minor;
  return sum === 0 ? zeroMoney(receipt.currency) : moneyFromMinor(sum, receipt.currency);
}

/**
 * Recompute totals, reconcile, and write the validation block back onto the
 * receipt. Issues are left untouched — `diagnoseReceipt` populates them.
 */
export function applyReconciliation(
  receipt: CanonicalReceipt
): CanonicalReceipt {
  const withTotals = recomputeTotals(receipt);
  const result = reconcileReceipt(withTotals);

  const validation: ReceiptValidation = {
    status: result.status,
    subtotalDelta: result.subtotalDelta,
    totalDelta: result.totalDelta,
    missingPrintedSubtotal: result.missingPrintedSubtotal,
    missingPrintedTotal: result.missingPrintedTotal,
    issues: withTotals.validation.issues,
  };

  return { ...withTotals, validation };
}
