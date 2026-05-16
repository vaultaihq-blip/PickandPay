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
  errors: ValidationError[];
  warnings: ValidationWarning[];
  totalDifference: number;
}

// Tolerance: 0.01€ to allow for floating-point rounding only.
// Any difference above this must be fixed by the user.
const TOTAL_TOLERANCE = 0.01;
const ITEM_MATH_TOLERANCE = 0.01;

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

// ─── ParsedReceipt validator (called immediately after OCR in scan.tsx) ───────

export function validateReceiptOCR(receipt: ParsedReceipt): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  const items = allReceiptItems(receipt);
  const receiptTotal = receipt.validation.receiptTotal;
  const computedTotal = receipt.validation.computedTotal;
  const diff = Math.abs(computedTotal - receiptTotal);

  // ── Total must match exactly ───────────────────────────────────────────────
  if (diff > TOTAL_TOLERANCE) {
    const sign = computedTotal - receiptTotal > 0 ? "+" : "";
    errors.push({
      severity: "critical",
      message:
        `Items sum to ${computedTotal.toFixed(2)}€ but receipt shows ${receiptTotal.toFixed(2)}€ ` +
        `(difference: ${sign}${(computedTotal - receiptTotal).toFixed(2)}€). ` +
        `You must fix this before continuing.`,
    });
  }

  // ── Each item's math must be exact ────────────────────────────────────────
  for (const item of items) {
    if (item.type === "combo") continue; // combo price is a package deal, skip math check

    if (!item.name || item.name.trim() === "") {
      errors.push({ itemId: item.id, severity: "critical", message: `Item "${item.id}" has no name` });
    }
    if (item.quantity <= 0) {
      errors.push({ itemId: item.id, severity: "critical", message: `"${item.name}" has invalid quantity: ${item.quantity}` });
    }
    if (item.unitPrice <= 0) {
      errors.push({ itemId: item.id, severity: "critical", message: `"${item.name}" has invalid unit price: ${item.unitPrice.toFixed(2)}€` });
    }

    const expected = Math.round(item.quantity * item.unitPrice * 100) / 100;
    if (Math.abs(expected - item.totalPrice) > ITEM_MATH_TOLERANCE) {
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
            `${Array.from(prices).map((p) => p.toFixed(2) + "€").join(", ")} — verify which applies to each person`,
        });
      }
    }
  }

  return {
    isValid: errors.length === 0,
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
}

export function validateEditableItems(
  items: EditableItem[],
  receiptTotal: number
): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  const computedTotal =
    Math.round(items.reduce((s, i) => s + i.totalPrice, 0) * 100) / 100;
  const diff = Math.abs(computedTotal - receiptTotal);

  // ── Total must match exactly ───────────────────────────────────────────────
  if (diff > TOTAL_TOLERANCE) {
    const sign = computedTotal - receiptTotal > 0 ? "+" : "";
    errors.push({
      severity: "critical",
      message:
        `Items sum to ${computedTotal.toFixed(2)}€ but receipt shows ${receiptTotal.toFixed(2)}€ ` +
        `(${sign}${(computedTotal - receiptTotal).toFixed(2)}€)`,
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

    const expected = Math.round(item.quantity * item.unitPrice * 100) / 100;
    if (Math.abs(expected - item.totalPrice) > ITEM_MATH_TOLERANCE) {
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
      const prices = new Set(group.map((i) => i.unitPrice));
      if (prices.size > 1) {
        warnings.push({
          message: `"${group[0].name}" has ${prices.size} different prices: ${Array.from(prices).map((p) => p.toFixed(2) + "€").join(", ")}`,
        });
      }
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    totalDifference: diff,
  };
}
