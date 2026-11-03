/**
 * Which "values with no owner" (unresolved monetary lines) are explained, so
 * they are neither listed as problems nor queue the item above them.
 *
 * AV-1 (03-11-2026): on the Oligark receipt the guided review listed 4 such
 * values — "05" and "16" (a table number and a time, no decimals) and the two
 * VAT bases 659,02 + 6.040.08, which also queued "Art of Bosphorus". None is a
 * price to check.
 *
 * - A number written without decimals, in a currency that has them, is not a
 *   price (table, time, quantity, code).
 * - 2 or 3 values that together make the printed total, and not the items, are
 *   a VAT/tax breakdown printed under the total — the R2 VAT clue's shape
 *   (lib/receipt/printedTotalGap.ts), but stricter, because here the values
 *   are hidden, not just a suggestion: at most 3 values, within 0.02% (the
 *   Oligark misread 6.040,98 as 6.040.08: 0.013% off). With 4 values and
 *   0.2%, random values on a long receipt (VRO) matched by chance.
 */

import type { CanonicalReceipt, UnresolvedMonetaryLine } from "./model";
import { currencyExponent } from "./money";

// Any separator followed by a digit counts ("34,502" may be a misread 34,50).
const HAS_DECIMALS = /\d[.,]\d/;

function writtenWithoutDecimals(line: UnresolvedMonetaryLine): boolean {
  // Only a text that shows the number ("Tax" alone says nothing about it).
  return line.text !== undefined && /\d/.test(line.text) && !HAS_DECIMALS.test(line.text);
}

/** The ids of 2–3 lines whose amounts reach the printed total (and not the items). */
function vatBreakdownIds(lines: UnresolvedMonetaryLine[], printedMinor: number, itemsMinor: number): Set<string> {
  const margin = (target: number) => Math.max(2, Math.round(target * 0.0002));
  const near = (sum: number, target: number) => Math.abs(sum - target) <= margin(target);
  const pool = lines.filter((l) => l.amount.minor > 0 && l.amount.minor < printedMinor * 0.999).slice(0, 12);
  const n = pool.length;
  for (let mask = 1; mask < 1 << n; mask++) {
    const picked: UnresolvedMonetaryLine[] = [];
    let sum = 0;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        picked.push(pool[i]);
        sum += pool[i].amount.minor;
      }
    }
    if (picked.length < 2 || picked.length > 3) continue;
    if (near(sum, printedMinor) && !near(sum, itemsMinor)) return new Set(picked.map((l) => l.id));
  }
  return new Set();
}

export function explainedOrphanIds(receipt: CanonicalReceipt): Set<string> {
  const lines = receipt.unresolvedMonetaryLines;
  const explained = new Set<string>();
  if (currencyExponent(receipt.currency) > 0) {
    for (const line of lines) if (writtenWithoutDecimals(line)) explained.add(line.id);
  }
  if (receipt.printedTotal !== undefined && receipt.printedTotal.minor > 0) {
    const rest = lines.filter((l) => !explained.has(l.id));
    for (const id of vatBreakdownIds(rest, receipt.printedTotal.minor, receipt.calculatedSubtotal.minor)) explained.add(id);
  }
  return explained;
}

/** The unresolved lines still worth showing. */
export function meaningfulOrphans(receipt: CanonicalReceipt): UnresolvedMonetaryLine[] {
  const explained = explainedOrphanIds(receipt);
  return receipt.unresolvedMonetaryLines.filter((l) => !explained.has(l.id));
}
