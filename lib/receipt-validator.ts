import { ParsedReceipt, ReceiptItem } from "@/types";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ValidationError {
  itemId?: string;
  severity: "critical" | "high" | "medium";
  message: string;
}

export interface ValidationWarning {
  message: string;
}

export interface ValidationResult {
  isValid: boolean;
  isWarning: boolean;   // true when total diff is small (0.50–5.00) but no other errors
  errors: ValidationError[];
  warnings: ValidationWarning[];
  totalDifference: number;
}

// Hard block if diff > $5.  Warning banner (allow continue) if diff > $0.50.
const TOTAL_TOLERANCE = 5.00;
const WARN_THRESHOLD  = 0.50;
const ITEM_MATH_TOLERANCE = 0.01;

/**
 * FIX 44 — the three-field edit rule (quantity/unitPrice/totalPrice) lets a
 * user set totalPrice directly and derives unitPrice from it by division,
 * ROUNDED to 2 decimals for display (totalPrice stays exactly as typed —
 * it's the ground truth, unitPrice is informational). That rounding means
 * quantity * unitPrice can legitimately differ from totalPrice by up to half
 * a cent per unit (e.g. 10.00 / 3 -> 3.33, 3 * 3.33 = 9.99, off by 0.01) —
 * a flat 0.01 tolerance would flag normal, correct use of that feature as a
 * critical math error and lock the user out. Scales with quantity so it
 * stays exact for any divisor, never loosens for an actually-wrong value.
 */
function itemMathTolerance(quantity: number): number {
  return ITEM_MATH_TOLERANCE + Math.abs(quantity) * 0.005;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function allReceiptItems(receipt: ParsedReceipt): ReceiptItem[] {
  return [
    ...receipt.categories.starters,
    ...receipt.categories.mains,
    ...receipt.categories.drinks,
    ...receipt.categories.desserts,
    ...receipt.categories.others,
  ];
}

/**
 * Sum of an item's paid add-ons (modifiers). Zero for items with no add-ons,
 * and a no-op when a producer (e.g. the canonical adapter) already folds the
 * add-on price into totalPrice and zeroes addOns[].totalPrice to signal that.
 */
function paidAddOnsTotal(item: { addOns?: { totalPrice: number }[] }): number {
  return (item.addOns ?? []).reduce((s, a) => s + (a.totalPrice ?? 0), 0);
}

/**
 * Value a single paid modifier contributes to its parent item's total. The
 * canonical adapter folds a modifier's price into the parent's totalPrice
 * and zeroes the modifier's own totalPrice to stop legacy code summing it
 * twice (see lib/receipt/adapter.ts:toLegacyItem) — its real value lives in
 * unitPrice instead. A source that populates totalPrice directly (a future
 * legacy producer) is respected as-is.
 */
function modifierValue(addOn: { unitPrice?: number; totalPrice: number }): number {
  return addOn.totalPrice !== 0 ? addOn.totalPrice : (addOn.unitPrice ?? 0);
}

/**
 * The item's price with paid modifiers stripped out — the menu base price.
 * Two orders of the same dish with different paid add-ons (e.g. one with
 * "extra shrimp", one without) legitimately have different totalPrice even
 * though this base is identical; comparing bases (not totals) is what tells
 * a normal group-order variation apart from an actual misread.
 */
function itemBasePrice(item: { totalPrice: number; addOns?: { unitPrice?: number; totalPrice: number }[] }): number {
  const modifiersSum = (item.addOns ?? []).reduce((s, a) => s + modifierValue(a), 0);
  return Math.round((item.totalPrice - modifiersSum) * 100) / 100;
}

// ─── ParsedReceipt validator (called immediately after OCR in scan.tsx) ───────

export function validateReceiptOCR(receipt: ParsedReceipt): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  const cur = receipt.currency ?? "EUR";

  const items = allReceiptItems(receipt);
  const computedTotal = receipt.validation.computedTotal;

  // receipt.validation.difference is items-only (printed total minus itemsSum,
  // ignoring globalCosts) — comparing it against printed_total always shows a
  // gap equal to tax/service for any receipt that has them (the normal case
  // for USD/CAD). Recompute against items + globalCosts, mirroring the same
  // fix already applied to normalizeReceipt's own validation.status.
  const globalCostsSum = receipt.globalCosts.reduce((s, gc) => s + (gc.amount ?? 0), 0);
  const printedTotal = receipt.validation.receiptTotal;
  const rawDiff = Math.round((printedTotal - (computedTotal + globalCostsSum)) * 100) / 100;
  const diff = Math.abs(rawDiff);

  // ── Total check ───────────────────────────────────────────────────────────
  if (diff > TOTAL_TOLERANCE) {
    const sign = rawDiff > 0 ? "+" : "";
    errors.push({
      severity: "critical",
      message:
        `Item total mismatch: ${sign}${rawDiff.toFixed(2)} ${cur} ` +
        `(items sum to ${computedTotal.toFixed(2)} ${cur}). ` +
        `You must fix this before continuing.`,
    });
  } else if (diff > WARN_THRESHOLD) {
    const sign = rawDiff > 0 ? "+" : "";
    warnings.push({
      message:
        `Small discrepancy: items sum to ${computedTotal.toFixed(2)} ${cur} ` +
        `but receipt subtotal differs by ${sign}${rawDiff.toFixed(2)} ${cur}. ` +
        `Possibly add-ons or rounding. You can continue or retry the scan.`,
    });
  }

  // ── Each item's math must be exact ────────────────────────────────────────
  for (const item of items) {
    if (item.type === "combo") continue;

    if (!item.name || item.name.trim() === "") {
      errors.push({ itemId: item.id, severity: "critical", message: `Item "${item.id}" has no name` });
    }
    if (item.quantity <= 0) {
      errors.push({ itemId: item.id, severity: "critical", message: `"${item.name}" has invalid quantity: ${item.quantity}` });
    }
    if (item.unitPrice <= 0) {
      errors.push({ itemId: item.id, severity: "critical", message: `"${item.name}" has invalid unit price: ${item.unitPrice.toFixed(2)} ${cur}` });
    }

    const addOnsSum = paidAddOnsTotal(item);
    const expected = Math.round((item.quantity * item.unitPrice + addOnsSum) * 100) / 100;
    if (Math.abs(expected - item.totalPrice) > itemMathTolerance(item.quantity)) {
      errors.push({
        itemId: item.id,
        severity: "critical",
        message: `"${item.name}": ${item.unitPrice.toFixed(2)} × ${item.quantity} = ${expected.toFixed(2)} but shows ${item.totalPrice.toFixed(2)}`,
      });
    }
  }

  // ── Price variants — informational only ───────────────────────────────────
  const byName = new Map<string, ReceiptItem[]>();
  for (const item of items) {
    const key = item.name.trim().toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key)!.push(item);
  }
  for (const [, group] of byName) {
    if (group.length > 1) {
      const prices = new Set(group.map((i) => i.unitPrice));
      if (prices.size > 1) {
        warnings.push({
          message:
            `"${group[0].name}" appears with ${prices.size} different unit prices: ` +
            `${Array.from(prices).map((p) => `${p.toFixed(2)} ${cur}`).join(", ")} — verify which applies to each person`,
        });
      }
    }
  }

  // isWarning only when there are no hard errors and the total diff is in the warning range
  const isWarning = errors.length === 0 && diff > WARN_THRESHOLD && diff <= TOTAL_TOLERANCE;

  return {
    isValid: errors.length === 0,
    isWarning,
    errors,
    warnings,
    totalDifference: diff,
  };
}

// ─── Editable item validator (live validation in review-receipt screen) ────────

export interface EditableItem {
  id: string;
  category: string;
  name: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  /** Paid modifiers, when the caller has them available. Optional — existing
   *  callers that don't populate this keep behaving exactly as before. */
  addOns?: { unitPrice?: number; totalPrice: number }[];
  /** FIX 44 — carried through so the reviewed mark survives edit/rebuild. */
  reviewed?: boolean;
}

export function validateEditableItems(
  items: EditableItem[],
  subtotalTarget: number,
  currency: string = "EUR"
): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  const cur = currency;

  const computedTotal =
    Math.round(items.reduce((s, i) => s + i.totalPrice + paidAddOnsTotal(i), 0) * 100) / 100;
  const rawDiff = computedTotal - subtotalTarget;
  const diff = Math.abs(rawDiff);

  // ── Total check ───────────────────────────────────────────────────────────
  if (diff > TOTAL_TOLERANCE) {
    const sign = rawDiff > 0 ? "+" : "";
    errors.push({
      severity: "critical",
      message:
        `Items sum to ${computedTotal.toFixed(2)} ${cur} but expected ${subtotalTarget.toFixed(2)} ${cur} ` +
        `(${sign}${rawDiff.toFixed(2)} ${cur})`,
    });
  } else if (diff > WARN_THRESHOLD) {
    const sign = rawDiff > 0 ? "+" : "";
    warnings.push({
      message:
        `Small discrepancy: items sum to ${computedTotal.toFixed(2)} ${cur} ` +
        `vs expected ${subtotalTarget.toFixed(2)} ${cur} (${sign}${rawDiff.toFixed(2)} ${cur}). ` +
        `May be add-ons or rounding.`,
    });
  }

  // ── Each item's math ──────────────────────────────────────────────────────
  for (const item of items) {
    if (!item.name || item.name.trim() === "") {
      errors.push({ itemId: item.id, severity: "critical", message: `Item #${items.indexOf(item) + 1} has no name` });
      continue;
    }
    if (item.quantity <= 0) {
      errors.push({ itemId: item.id, severity: "critical", message: `"${item.name}" has invalid quantity` });
    }
    if (item.unitPrice <= 0) {
      errors.push({ itemId: item.id, severity: "critical", message: `"${item.name}" has no price` });
    }

    const addOnsSum = paidAddOnsTotal(item);
    const expected = Math.round((item.quantity * item.unitPrice + addOnsSum) * 100) / 100;
    if (Math.abs(expected - item.totalPrice) > itemMathTolerance(item.quantity)) {
      errors.push({
        itemId: item.id,
        severity: "critical",
        message: `"${item.name}": ${item.unitPrice.toFixed(2)} × ${item.quantity} = ${expected.toFixed(2)} ≠ ${item.totalPrice.toFixed(2)}`,
      });
    }
  }

  // ── Price variants ────────────────────────────────────────────────────────
  const byName = new Map<string, EditableItem[]>();
  for (const item of items) {
    const key = item.name.trim().toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key)!.push(item);
  }
  for (const [, group] of byName) {
    if (group.length > 1) {
      // Gate on the BASE price (total minus paid modifiers), not the raw
      // unitPrice — two orders of the same dish with different paid add-ons
      // are expected to have different totals. Only a differing base signals
      // an actual misread.
      const bases = new Set(group.map((i) => itemBasePrice(i)));
      if (bases.size > 1) {
        const prices = new Set(group.map((i) => i.unitPrice));
        warnings.push({
          message: `"${group[0].name}" has ${prices.size} different prices: ${Array.from(prices).map((p) => `${p.toFixed(2)} ${cur}`).join(", ")}`,
        });
      }
    }
  }

  const isWarning = errors.length === 0 && diff > WARN_THRESHOLD && diff <= TOTAL_TOLERANCE;

  return {
    isValid: errors.length === 0,
    isWarning,
    errors,
    warnings,
    totalDifference: diff,
  };
}
