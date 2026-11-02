/**
 * Bridge between the canonical receipt model and the legacy `ParsedReceipt`
 * shape used by the existing screens, store and database rows.
 *
 * The canonical model is the source of truth for reconciliation. This adapter
 * exists so the rest of the app can keep working unchanged while screens are
 * migrated one at a time.
 */

import type {
  Currency,
  GlobalCost,
  GlobalCostType,
  ItemCategory,
  ParsedReceipt,
  ReceiptItem,
} from "@/types";
import {
  type CurrencyCode,
  moneyFromMajorNumber,
  moneyToMajorNumber,
  normalizeCurrencyCode,
} from "./money";
import {
  type CanonicalReceipt,
  type ChargeKind,
  type ReceiptCharge,
  type ReceiptLineItem,
  paidModifiers,
} from "./model";

const CATEGORY_VALUES: ReadonlySet<string> = new Set([
  "starters",
  "mains",
  "drinks",
  "desserts",
  "others",
]);

function toCategory(value: string | undefined): ItemCategory {
  return value !== undefined && CATEGORY_VALUES.has(value)
    ? (value as ItemCategory)
    : "others";
}

const CHARGE_TO_GLOBAL_COST: Readonly<Record<ChargeKind, GlobalCostType>> = {
  service: "service_charge",
  tax: "tax",
  tip: "other",
  discount: "other",
  delivery: "delivery",
  bag: "bag",
  other: "other",
};

/**
 * Render a canonical item as a legacy `ReceiptItem`.
 *
 * `totalPrice` carries the fully reconciled line total *including paid
 * modifiers*, because downstream splitting logic sums `totalPrice` and would
 * otherwise silently drop every paid extra — the original defect.
 */
function toLegacyItem(item: ReceiptLineItem): ReceiptItem {
  const lineTotal = moneyToMajorNumber(item.calculatedLineTotal);
  const quantity = Math.max(1, item.quantity);

  const paid = paidModifiers(item);
  const modifierNotes = item.modifiers.map((modifier) =>
    modifier.kind === "paid"
      ? `${modifier.name} (+${moneyToMajorNumber(modifier.price).toFixed(2)})`
      : modifier.name
  );

  const notes = [...(item.notes ?? []), ...modifierNotes];

  return {
    id: item.id,
    name: item.name,
    category: toCategory(item.category),
    quantity,
    // Unit price is derived from the reconciled line total so that
    // unitPrice * quantity === totalPrice always holds for legacy validators.
    unitPrice: lineTotal / quantity,
    totalPrice: lineTotal,
    type: quantity > 1 ? "quantity" : "individual",
    notes: notes.length > 0 ? notes : undefined,
    addOns:
      paid.length > 0
        ? paid.map((modifier) => ({
            id: modifier.id,
            name: modifier.name,
            category: toCategory(item.category),
            quantity: 1,
            unitPrice: moneyToMajorNumber(modifier.price),
            // Already included in the parent's totalPrice; kept at zero so any
            // legacy code that sums add-ons separately cannot double-count.
            totalPrice: 0,
            type: "individual" as const,
          }))
        : undefined,
    confidence: item.confidence,
  };
}

function toGlobalCost(charge: ReceiptCharge): GlobalCost {
  const amount = moneyToMajorNumber(charge.amount);
  return {
    id: charge.id,
    name: charge.name,
    amount: charge.kind === "discount" ? -amount : amount,
    type: CHARGE_TO_GLOBAL_COST[charge.kind],
    splitByAll: true,
    editable: charge.kind !== "tax",
    status: charge.kind === "tax" || charge.kind === "service" ? "mandatory" : "included",
  };
}

/**
 * Project a canonical receipt onto the legacy shape.
 *
 * `validation.receiptTotal` is set from the *printed* total when the receipt
 * printed one, falling back to the calculated total. It is never set from the
 * model's own arithmetic — that fallback is what made the old validator
 * compare a number against itself and always report success.
 */
export function toParsedReceipt(receipt: CanonicalReceipt): ParsedReceipt {
  const items = receipt.items.map(toLegacyItem);

  const grouped: ParsedReceipt["categories"] = {
    starters: [],
    mains: [],
    drinks: [],
    desserts: [],
    others: [],
  };
  for (const item of items) grouped[item.category].push(item);

  const computedTotal = moneyToMajorNumber(receipt.calculatedTotal);
  const printedTotal =
    receipt.printedTotal !== undefined
      ? moneyToMajorNumber(receipt.printedTotal)
      : computedTotal;

  const difference = Math.round((computedTotal - printedTotal) * 100) / 100;

  const status: ParsedReceipt["validation"]["status"] =
    receipt.validation.status === "reconciled"
      ? "ok"
      : receipt.validation.status === "unverifiable"
        ? "warning"
        : "error";

  return {
    restaurant: receipt.merchantName ?? "Unknown Restaurant",
    date: receipt.date,
    // The receipt's own currency, whatever it is (it used to become EUR
    // outside EUR/USD/CAD/GBP — currency point, 02-11-2026).
    currency: receipt.currency,
    ...(receipt.currencyAssumed ? { currencyAssumed: true } : {}),
    categories: grouped,
    globalCosts: receipt.charges
      .filter((charge) => charge.kind !== "tip")
      .map(toGlobalCost),
    suggestedTips: [],
    tipMode: "equal",
    selectedTip: 0,
    validation: {
      receiptTotal: printedTotal,
      computedTotal,
      difference,
      status,
    },
  };
}

/**
 * Lift a legacy receipt back into the canonical model.
 *
 * Used when loading a session that was persisted before the canonical model
 * existed, so it can be reconciled with the new engine.
 */
export function fromParsedReceipt(legacy: ParsedReceipt): CanonicalReceipt {
  const currency: CurrencyCode =
    normalizeCurrencyCode(legacy.currency) ?? "EUR";

  const legacyItems: ReceiptItem[] = [
    ...legacy.categories.starters,
    ...legacy.categories.mains,
    ...legacy.categories.drinks,
    ...legacy.categories.desserts,
    ...legacy.categories.others,
  ];

  const items: ReceiptLineItem[] = legacyItems.map((item) => {
    const quantity = Math.max(1, Math.round(item.quantity));
    const unitPrice = moneyFromMajorNumber(item.unitPrice, currency);
    const total = moneyFromMajorNumber(item.totalPrice, currency);
    return {
      id: item.id,
      name: item.name,
      quantity,
      unitPrice,
      baseLineTotal: total,
      modifiers: [],
      // Trust the persisted line total; it was already reconciled when saved.
      calculatedLineTotal: total,
      category: item.category,
      notes: item.notes,
      confidence: item.confidence,
    };
  });

  const charges: ReceiptCharge[] = legacy.globalCosts.map((cost) => {
    const kind: ChargeKind =
      cost.type === "tax"
        ? "tax"
        : cost.type === "service_charge" || cost.type === "mandatory_service"
          ? "service"
          : cost.type === "delivery"
            ? "delivery"
            : cost.type === "bag"
              ? "bag"
              : "other";
    return {
      id: cost.id,
      name: cost.name,
      amount: moneyFromMajorNumber(Math.abs(cost.amount), currency),
      kind: cost.amount < 0 ? "discount" : kind,
    };
  });

  let subtotalMinor = 0;
  for (const item of items) subtotalMinor += item.calculatedLineTotal.minor;
  const calculatedSubtotal = { minor: subtotalMinor, currency } as const;

  let totalMinor = subtotalMinor;
  for (const charge of charges) {
    totalMinor +=
      charge.kind === "discount" ? -charge.amount.minor : charge.amount.minor;
  }

  const printedTotal =
    legacy.validation.receiptTotal > 0
      ? moneyFromMajorNumber(legacy.validation.receiptTotal, currency)
      : undefined;

  return {
    merchantName: legacy.restaurant,
    date: legacy.date,
    currency,
    currencyAssumed: legacy.currencyAssumed === true,
    items,
    charges,
    unresolvedMonetaryLines: [],
    printedTotal,
    calculatedSubtotal,
    calculatedTotal: { minor: totalMinor, currency },
    validation: {
      status: "unverifiable",
      missingPrintedSubtotal: true,
      missingPrintedTotal: printedTotal === undefined,
      issues: [],
    },
  };
}
