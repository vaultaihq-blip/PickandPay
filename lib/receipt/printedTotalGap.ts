/**
 * R2 — the split always adds up to the printed total.
 *
 * When the items plus the charges that have their own line do not reach the
 * printed total, the difference is either a charge with no line (Oligark,
 * 30-10-2026: 6.100 of items, ₺ 6.700 printed) or an item the read missed
 * (Augustiner's first read: 3 × Currywurst). The numbers alone cannot tell
 * the two apart, so the host answers; this module only measures the gap,
 * suggests the likely answer from clues on the receipt, and turns a confirmed
 * answer into a charge split in proportion to what each person picked.
 */
import type { GlobalCost } from "@/types";

export type GapKind = "none" | "under" | "over";

/** What the host confirmed for the current gap. */
export interface GapAnswer {
  /** "charge" closes an "under" gap, "discount" an "over" gap. */
  answer: "charge" | "discount";
  /** As the host named it; shown in each person's share. */
  name: string;
  /** The gap (always positive) this answer was confirmed for. */
  amount: number;
}

export interface PrintedTotalGap {
  kind: GapKind;
  /** Always positive, two decimals; 0 when kind is "none". */
  amount: number;
}

/** Id of the charge an answered gap becomes on the receipt. */
export const UNLINED_COST_ID = "unlined_gap";

const toCents = (v: number) => Math.round(v * 100);

/**
 * items + charges with their own line, against the printed total. Without a
 * printed total there is nothing to compare, and no gap is reported (the
 * guided flow asks for the total first).
 */
export function printedTotalGap(
  itemsSum: number,
  linedChargesSum: number,
  printedTotal: number | null
): PrintedTotalGap {
  if (printedTotal === null || !(printedTotal > 0)) return { kind: "none", amount: 0 };
  const diff = toCents(printedTotal) - toCents(itemsSum) - toCents(linedChargesSum);
  if (diff === 0) return { kind: "none", amount: 0 };
  return { kind: diff > 0 ? "under" : "over", amount: Math.abs(diff) / 100 };
}

/** The answer still holds only for the gap it was confirmed for. */
export function answerHolds(gap: PrintedTotalGap, answer: GapAnswer | null): boolean {
  if (gap.kind === "none" || answer === null) return false;
  const expected = gap.kind === "under" ? "charge" : "discount";
  return answer.answer === expected && toCents(answer.amount) === toCents(gap.amount);
}

export interface GapClues {
  /** Text of the receipt lines no item or charge claimed. */
  texts: string[];
  /** Amounts on those lines. */
  amounts: number[];
  printedTotal: number;
  itemsSum: number;
}

export type GapSuggestion = "charge" | "discount" | null;

// Tip words are left out on purpose: "suggested tip" lines name a tip that
// was not charged.
const CHARGE_WORDS = /servi[cçs]|service|couvert|coperto|cubierto|bedienung/i;
const DISCOUNT_WORDS = /desconto|discount|descuento|remise|rabatt|promo|oferta|indirim|iskonto/i;

/**
 * Whether some of the unclaimed amounts (2 to 4 of them) add up to the
 * printed total and not to the items — the shape of VAT bases printed under
 * the total (Oligark: 659,02 + 6.040,98 = 6.700,00). A small margin is kept
 * because OCR misreads digits there (it read 6.040,98 as 6.040.08).
 */
function vatBasesReachPrintedTotal(clues: GapClues): boolean {
  const margin = (target: number) => Math.max(0.05, target * 0.002);
  const near = (sum: number, target: number) => Math.abs(sum - target) <= margin(target);
  const pool = clues.amounts
    .filter((a) => a > 0 && a < clues.printedTotal * 0.999)
    .slice(0, 12);
  const n = pool.length;
  for (let mask = 1; mask < 1 << n; mask++) {
    let count = 0;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        count++;
        sum += pool[i];
      }
    }
    if (count < 2 || count > 4) continue;
    if (near(sum, clues.printedTotal) && !near(sum, clues.itemsSum)) return true;
  }
  return false;
}

/**
 * The answer to pre-select, or null when the receipt gives no clue. Only a
 * suggestion: the host always confirms (R2).
 */
export function suggestGapAnswer(gap: PrintedTotalGap, clues: GapClues): GapSuggestion {
  if (gap.kind === "under") {
    if (clues.texts.some((t) => CHARGE_WORDS.test(t))) return "charge";
    if (vatBasesReachPrintedTotal(clues)) return "charge";
    return null;
  }
  if (gap.kind === "over") {
    return clues.texts.some((t) => DISCOUNT_WORDS.test(t)) ? "discount" : null;
  }
  return null;
}

/**
 * The receipt's charges with the answered gap added (or replaced, if the host
 * answered again). An unanswered gap adds nothing.
 */
export function withGapCost(costs: GlobalCost[], answer: GapAnswer | null): GlobalCost[] {
  const others = costs.filter((c) => c.id !== UNLINED_COST_ID);
  if (answer === null) return others;
  const signed = answer.answer === "charge" ? answer.amount : -answer.amount;
  return [
    ...others,
    {
      id: UNLINED_COST_ID,
      name: answer.name.trim(),
      amount: Math.round(signed * 100) / 100,
      type: "other",
      splitByAll: true,
      split: "proportional",
      editable: false,
      status: "included",
    },
  ];
}
