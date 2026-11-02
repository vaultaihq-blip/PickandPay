/**
 * Cross-checks a parsed monetary value against the exact receipt text the
 * model itself cited as its source (`sourceEvidence.lineText`).
 *
 * This is deliberately independent of reconciliation (reconciler.ts /
 * diagnostics.ts), which only looks at whether totals add up. A misread
 * value can, by coincidence, still let the subtotal reconcile — e.g. two
 * errors cancelling out — so this check must run unconditionally rather
 * than only when reconciliation fails.
 */

import { paidModifiers, nextEntityId, confidenceFromScore } from "./model";
import type { CanonicalReceipt, ReceiptIssue } from "./model";
import { moneyToDecimalString, parseMoneyString } from "./money";
import type { CurrencyCode, Money } from "./money";

// Objective contradiction, not a guess: the model's own numeric field
// disagrees with the model's own cited text. High confidence is warranted.
const EVIDENCE_MISMATCH_CONFIDENCE = 0.95;

/**
 * Every amount printed on `lineText`, read by value with `parseMoneyString`
 * (the same algorithm as the ledger's `parseAmbiguousNumber`), in minor
 * units. A substring test missed "1.100,00" for 1100 and flagged five
 * correct Oligark lines (false warnings point, 2026-11-01).
 *
 * A space joins two runs only as a thousands mark — a run of 1–3 digits
 * followed by exactly three digits (and optional decimals): "1 100,00" is
 * 1100, but "1 1.100,00" stays quantity 1 and 1100.
 */
export function amountsOnLine(lineText: string, currency: CurrencyCode): number[] {
  const tokens = lineText.split(/[\s\u00A0\u202F]+/).filter((tok) => /\d/.test(tok));
  const candidates = [...tokens];
  for (let i = 0; i + 1 < tokens.length; i++) {
    if (/^\d{1,3}$/.test(tokens[i]) && /^\d{3}([.,]\d{1,2})?$/.test(tokens[i + 1])) {
      candidates.push(tokens[i] + tokens[i + 1]);
    }
  }
  const values: number[] = [];
  for (const tok of candidates) {
    const money = parseMoneyString(tok.replace(/[^\d.,()-]/g, ""), currency);
    if (money !== null) values.push(Math.abs(money.minor));
  }
  return values;
}

/**
 * Whether `amount` is printed on the line — on its own, or as the line
 * total of `quantity` units ("3 Uni SAFATA DE PAO 5,25" prints 5,25 for a
 * unit price of 1,75). Compared by value, so any separator style matches.
 */
function amountAppearsIn(amount: Money, lineText: string, quantity = 1): boolean {
  const printed = amountsOnLine(lineText, amount.currency);
  const unit = Math.abs(amount.minor);
  return printed.includes(unit) || (quantity > 1 && printed.includes(unit * quantity));
}

function evidenceMismatchIssue(
  amount: Money,
  lineText: string,
  itemId?: string,
  modifierId?: string
): ReceiptIssue {
  const value = moneyToDecimalString(amount);
  return {
    id: nextEntityId("issue"),
    type: "unverifiable_value",
    confidence: EVIDENCE_MISMATCH_CONFIDENCE,
    confidenceLevel: confidenceFromScore(EVIDENCE_MISMATCH_CONFIDENCE),
    itemId,
    modifierId,
    sourceLine: lineText,
    message: `The value read (${value}) does not match the cited line text ("${lineText}") — likely a misread.`,
  };
}

/**
 * Checks every item's `unitPrice` and every paid modifier's `price` against
 * the line text cited for it. Only entities carrying BOTH a price and cited
 * text are checked — a missing citation is not itself a defect, only a
 * contradiction between the two is. Free modifiers are skipped: their price
 * is zero by definition and their line text rarely states one, so checking
 * them would only produce noise, not signal.
 */
export function checkPriceEvidence(receipt: CanonicalReceipt): ReceiptIssue[] {
  const issues: ReceiptIssue[] = [];

  for (const item of receipt.items) {
    const lineText = item.sourceEvidence?.lineText;
    if (item.unitPrice !== undefined && lineText !== undefined) {
      if (!amountAppearsIn(item.unitPrice, lineText, item.quantity)) {
        issues.push(evidenceMismatchIssue(item.unitPrice, lineText, item.id));
      }
    }

    for (const modifier of paidModifiers(item)) {
      const modifierLineText = modifier.sourceEvidence?.lineText;
      if (
        modifierLineText !== undefined &&
        !amountAppearsIn(modifier.price, modifierLineText, item.quantity)
      ) {
        issues.push(
          evidenceMismatchIssue(modifier.price, modifierLineText, item.id, modifier.id)
        );
      }
    }
  }

  return issues;
}
