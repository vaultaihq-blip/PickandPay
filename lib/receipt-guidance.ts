/**
 * Turns what the parser already reported into guidance the user can act on.
 *
 * Every fact here comes from the envelope — the canonical receipt's own
 * diagnosis (lib/receipt/model.ts) — never from a heuristic invented on the
 * client. The three signals used are:
 *
 *   - an item the normalizer could not price at all (no unitPrice AND no
 *     baseLineTotal; see normalizer.ts:deriveBaseTotal case 3, "line is
 *     unpriced; diagnostics will flag it"). A genuinely printed 0.00 has a
 *     baseLineTotal and is therefore NOT treated as unpriced.
 *   - unresolvedMonetaryLines — priced lines read but attributed to nothing.
 *   - validation.issues — the ranked diagnosis, each optionally pointing at
 *     the item it concerns via itemId.
 *
 * The canonical receipt is absent on the legacy (non-v2) payload path in
 * utils/parser.ts, so every function degrades to the legacy projection of the
 * same facts rather than going blank.
 */

import type { CanonicalReceipt, ReceiptIssue } from "@/lib/receipt";
import { moneyToMajorNumber } from "@/lib/receipt";

export type ReceiptProblemKind =
  | "no_total"
  | "unpriced_items"
  | "unexplained_values"
  | "sum_mismatch";

export interface ReceiptProblem {
  kind: ReceiptProblemKind;
  /** Plain-language sentence, ready to show. No technical vocabulary. */
  message: string;
}

export interface ReceiptGuidance {
  /** Ranked, most important first. Empty when nothing is known to be wrong. */
  problems: ReceiptProblem[];
  /** Ids of items that need attention, in receipt order. Stable per analysis. */
  attentionItemIds: string[];
  /** Why each queued item is queued, keyed by item id. */
  attentionReasons: Record<string, string>;
  /** True when the receipt printed no grand total to anchor against. */
  missingTotal: boolean;
}

/** Minimal view of the legacy item shape this module needs. */
export interface GuidanceItem {
  id: string;
  totalPrice: number;
}

export interface GuidanceInput {
  canonical: CanonicalReceipt | null;
  items: readonly GuidanceItem[];
  /** Printed grand total, or null when the receipt printed none. */
  printedTotal: number | null;
  /** Sum of the items as they currently stand. */
  itemsSum: number;
  /** Bill-level charges (service, tax, ...) that sit on top of the items. */
  chargesSum: number;
}

/** An item the normalizer could not price at all. */
function isUnpricedCanonicalItem(item: CanonicalReceipt["items"][number]): boolean {
  return item.unitPrice === undefined && item.baseLineTotal === undefined;
}

function issueItemIds(issues: readonly ReceiptIssue[]): Set<string> {
  const ids = new Set<string>();
  for (const issue of issues) {
    if (issue.itemId !== undefined) ids.add(issue.itemId);
  }
  return ids;
}

/**
 * Items needing attention, in receipt order: unpriced, pointed at by a
 * diagnosis, or sitting directly beneath a value nothing could explain.
 */
export function attentionItemIds(input: GuidanceInput): string[] {
  const { canonical, items } = input;

  if (canonical === null) {
    // Legacy path: an unpriced item projects to totalPrice 0 (adapter.ts
    // derives unitPrice/totalPrice from calculatedLineTotal, which is zero
    // for an unpriced line).
    return items.filter((item) => item.totalPrice === 0).map((item) => item.id);
  }

  const flagged = issueItemIds(canonical.validation.issues);
  const orphanTargets = new Set(
    canonical.unresolvedMonetaryLines
      .map((line) => line.nearestItemId)
      .filter((id): id is string => id !== undefined)
  );

  const needsAttention = new Set<string>();
  for (const item of canonical.items) {
    if (isUnpricedCanonicalItem(item) || flagged.has(item.id) || orphanTargets.has(item.id)) {
      needsAttention.add(item.id);
    }
  }

  // Walk the legacy list so the order matches what the user sees, and so an
  // item that only exists on one side is simply skipped rather than crashing.
  return items.filter((item) => needsAttention.has(item.id)).map((item) => item.id);
}

/**
 * Why each queued item is queued, in the same plain language as step 1. The
 * parser's own diagnosis wins when it has one; otherwise the reason is the
 * plain fact that put the item in the queue.
 */
export function attentionReasons(input: GuidanceInput): Record<string, string> {
  const { canonical, items } = input;
  const reasons: Record<string, string> = {};

  if (canonical === null) {
    for (const item of items) {
      if (item.totalPrice === 0) {
        reasons[item.id] = "Não consegui ler o preço deste prato.";
      }
    }
    return reasons;
  }

  const orphanTargets = new Set(
    canonical.unresolvedMonetaryLines
      .map((line) => line.nearestItemId)
      .filter((id): id is string => id !== undefined)
  );

  for (const item of canonical.items) {
    if (isUnpricedCanonicalItem(item)) {
      reasons[item.id] = "Não consegui ler o preço deste prato.";
    } else if (orphanTargets.has(item.id)) {
      reasons[item.id] = "Havia um valor por atribuir mesmo ao lado deste prato.";
    }
  }

  // A diagnosis message is more specific than either of the above, so it
  // overwrites them when one exists for this item.
  for (const issue of canonical.validation.issues) {
    if (issue.itemId !== undefined) reasons[issue.itemId] = issue.message;
  }

  return reasons;
}

/**
 * Ranked problems, worst first. `formatMoney` renders an amount the way the
 * rest of the screen does, so this module never owns currency formatting.
 */
export function receiptProblems(
  input: GuidanceInput,
  formatMoney: (value: number) => string
): ReceiptProblem[] {
  const { canonical, items, printedTotal, itemsSum, chargesSum } = input;
  const problems: ReceiptProblem[] = [];

  const missingTotal =
    canonical !== null ? canonical.validation.missingPrintedTotal : printedTotal === null;

  // Worst first: with no total there is nothing to validate anything against.
  if (missingTotal) {
    problems.push({
      kind: "no_total",
      message: "Não consegui identificar o total da fatura.",
    });
  }

  const unpricedCount =
    canonical !== null
      ? canonical.items.filter(isUnpricedCanonicalItem).length
      : items.filter((item) => item.totalPrice === 0).length;

  if (unpricedCount > 0) {
    problems.push({
      kind: "unpriced_items",
      message:
        unpricedCount === 1
          ? "Não consegui ler o preço de 1 prato."
          : `Não consegui ler o preço de ${unpricedCount} pratos.`,
    });
  }

  const orphans = canonical?.unresolvedMonetaryLines ?? [];
  if (orphans.length === 1) {
    problems.push({
      kind: "unexplained_values",
      message: `Encontrei um valor de ${formatMoney(
        moneyToMajorNumber(orphans[0].amount)
      )} que não consegui atribuir.`,
    });
  } else if (orphans.length > 1) {
    problems.push({
      kind: "unexplained_values",
      message: `Encontrei ${orphans.length} valores que não consegui atribuir.`,
    });
  }

  // Only meaningful when there IS a printed total to disagree with.
  if (!missingTotal && printedTotal !== null) {
    const difference = Math.round((itemsSum + chargesSum - printedTotal) * 100) / 100;
    if (Math.abs(difference) >= 0.01) {
      problems.push({
        kind: "sum_mismatch",
        message: `A soma dos pratos dá ${formatMoney(
          itemsSum
        )}, mas o total da fatura é ${formatMoney(printedTotal)}.`,
      });
    }
  }

  return problems;
}

export function buildReceiptGuidance(
  input: GuidanceInput,
  formatMoney: (value: number) => string
): ReceiptGuidance {
  const missingTotal =
    input.canonical !== null
      ? input.canonical.validation.missingPrintedTotal
      : input.printedTotal === null;

  return {
    problems: receiptProblems(input, formatMoney),
    attentionItemIds: attentionItemIds(input),
    attentionReasons: attentionReasons(input),
    missingTotal,
  };
}

/**
 * The headline plus how many other problems there are, for the first step:
 * "diz o principal e quantos mais há".
 */
export function summarizeProblems(problems: readonly ReceiptProblem[]): {
  headline: string;
  extraCount: number;
} {
  if (problems.length === 0) {
    return { headline: "Há uma diferença entre os valores lidos e o total.", extraCount: 0 };
  }
  return { headline: problems[0].message, extraCount: problems.length - 1 };
}
