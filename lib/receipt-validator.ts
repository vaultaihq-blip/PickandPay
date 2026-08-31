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
  const cur = receipt.currency ?? "EUR";

  const items = allReceiptItems(receipt);
  const computedTotal = receipt.validation.computedTotal;
  const rawDiff = receipt.validation.difference ?? 0;
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
    Math.round(items.reduce((s, i) => s + i.totalPrice, 0) * 100) / 100;
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
