import { ParsedReceipt, ReceiptItem } from "@/types";

// ─── Precise Arithmetic ────────────────────────────────────────────────────────
// Avoid floating-point issues by working in integer cents

export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

export function fromCents(cents: number): number {
  return cents / 100;
}

export function addAmounts(...amounts: number[]): number {
  return fromCents(amounts.reduce((sum, a) => sum + toCents(a), 0));
}

export function subtractAmounts(a: number, b: number): number {
  return fromCents(toCents(a) - toCents(b));
}

export function divideAmount(amount: number, divisor: number): number {
  if (divisor === 0) return 0;
  return fromCents(Math.round(toCents(amount) / divisor));
}

// ─── Receipt Validation ────────────────────────────────────────────────────────

export interface ValidationResult {
  receiptTotal: number;
  computedTotal: number;
  difference: number;
  status: "ok" | "warning" | "error";
}

export function validateReceipt(receipt: ParsedReceipt): ValidationResult {
  let computedCents = 0;

  // Sum all category items
  for (const category of Object.values(receipt.categories)) {
    for (const item of category) {
      computedCents += toCents(item.totalPrice);
      // Add add-ons
      if (item.addOns) {
        for (const addon of item.addOns) {
          computedCents += toCents(addon.totalPrice);
        }
      }
    }
  }

  // Sum global costs
  for (const cost of receipt.globalCosts) {
    computedCents += toCents(cost.amount);
  }

  // Add tip if selected
  if (receipt.selectedTip) {
    computedCents += toCents(receipt.selectedTip);
  }

  const receiptTotal = receipt.validation.receiptTotal;
  const computedTotal = fromCents(computedCents);
  const difference = Math.abs(subtractAmounts(receiptTotal, computedTotal));

  let status: "ok" | "warning" | "error";
  if (difference === 0) {
    status = "ok";
  } else if (difference <= 0.05) {
    status = "warning";
  } else {
    status = "error";
  }

  return { receiptTotal, computedTotal, difference, status };
}

export function getAllItems(receipt: ParsedReceipt): ReceiptItem[] {
  return [
    ...receipt.categories.starters,
    ...receipt.categories.mains,
    ...receipt.categories.drinks,
    ...receipt.categories.desserts,
    ...receipt.categories.others,
  ];
}

export function countAllItems(receipt: ParsedReceipt): number {
  return getAllItems(receipt).length;
}
