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
import { moneyToDecimalString } from "./money";
import type { Money } from "./money";

// Objective contradiction, not a guess: the model's own numeric field
// disagrees with the model's own cited text. High confidence is warranted.
const EVIDENCE_MISMATCH_CONFIDENCE = 0.95;

/**
 * Whether `amount` is recognisable as a substring of `lineText`, tolerant of
 * comma vs dot as the decimal separator — the same ambiguity
 * `parseMoneyString` resolves when parsing a whole string, applied here to
 * the printed side of the comparison since receipts use either convention.
 */
function amountAppearsIn(amount: Money, lineText: string): boolean {
  const dotForm = moneyToDecimalString(amount); // e.g. "23.75"
  const commaForm = dotForm.replace(".", ","); // e.g. "23,75"
  return lineText.includes(dotForm) || lineText.includes(commaForm);
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
      if (!amountAppearsIn(item.unitPrice, lineText)) {
        issues.push(evidenceMismatchIssue(item.unitPrice, lineText, item.id));
      }
    }

    for (const modifier of paidModifiers(item)) {
      const modifierLineText = modifier.sourceEvidence?.lineText;
      if (
        modifierLineText !== undefined &&
        !amountAppearsIn(modifier.price, modifierLineText)
      ) {
        issues.push(
          evidenceMismatchIssue(modifier.price, modifierLineText, item.id, modifier.id)
        );
      }
    }
  }

  return issues;
}
