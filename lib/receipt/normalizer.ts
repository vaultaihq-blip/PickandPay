/**
 * receiptNormalizer — converts the vision model's raw JSON into the canonical
 * receipt model.
 *
 * Hard rule: arithmetic reported by the model is never trusted. Every derived
 * amount (line totals, subtotal, total) is recomputed here from the atomic
 * values. The model is treated purely as a structural reader of the image.
 */

import {
  type CurrencyCode,
  type Money,
  coerceMoney,
  moneyFromMinor,
  multiplyMoney,
  normalizeCurrencyCode,
  subtractMoney,
  sumMoney,
  zeroMoney,
} from "./money";
import {
  type ChargeKind,
  type CanonicalReceipt,
  type ModifierKind,
  type ReceiptCharge,
  type ReceiptLineItem,
  type ReceiptModifier,
  type SourceEvidence,
  type UnresolvedMonetaryLine,
  nextEntityId,
  paidModifiers,
} from "./model";

// ─── Raw wire shapes ──────────────────────────────────────────────────────────
// Everything is `unknown`-tolerant: the model can and does return malformed
// fields, and a malformed field must degrade one entity, not the whole parse.

export interface RawReceiptPayload {
  merchant?: unknown;
  restaurant?: unknown;
  date?: unknown;
  currency?: unknown;
  items?: unknown;
  charges?: unknown;
  unresolvedLines?: unknown;
  printedSubtotal?: unknown;
  printedServiceCharge?: unknown;
  printedTax?: unknown;
  printedTip?: unknown;
  printedDiscount?: unknown;
  printedTotal?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asPositiveInteger(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    const rounded = Math.round(value);
    return rounded >= 1 ? rounded : fallback;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed >= 1) return parsed;
  }
  return fallback;
}

function asConfidence(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function asLineIndex(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  return rounded >= 0 ? rounded : undefined;
}

function parseEvidence(value: unknown): SourceEvidence | undefined {
  if (!isRecord(value)) return undefined;
  const evidence: SourceEvidence = {};
  const lineIndex = asLineIndex(value.lineIndex);
  if (lineIndex !== undefined) evidence.lineIndex = lineIndex;
  const lineText = asTrimmedString(value.lineText);
  if (lineText !== undefined) evidence.lineText = lineText;
  const parentLineIndex = asLineIndex(value.parentLineIndex);
  if (parentLineIndex !== undefined) evidence.parentLineIndex = parentLineIndex;

  const box = value.boundingBox;
  if (Array.isArray(box) && box.length === 4) {
    const nums = box.map((n) => (typeof n === "number" && Number.isFinite(n) ? n : null));
    if (nums.every((n): n is number => n !== null)) {
      evidence.boundingBox = [nums[0], nums[1], nums[2], nums[3]] as const;
    }
  }

  return Object.keys(evidence).length > 0 ? evidence : undefined;
}

const MODIFIER_KINDS: ReadonlySet<string> = new Set(["paid", "free", "unknown"]);
const CHARGE_KINDS: ReadonlySet<string> = new Set([
  "service",
  "tax",
  "tip",
  "discount",
  "delivery",
  "bag",
  "other",
]);

// ─── Modifiers ────────────────────────────────────────────────────────────────

function normalizeModifier(
  raw: unknown,
  currency: CurrencyCode
): ReceiptModifier | null {
  if (!isRecord(raw)) return null;

  const name = asTrimmedString(raw.name) ?? "Modifier";
  const price = coerceMoney(raw.price, currency);

  const declaredKind = asTrimmedString(raw.kind)?.toLowerCase();
  let kind: ModifierKind;
  if (declaredKind !== undefined && MODIFIER_KINDS.has(declaredKind)) {
    kind = declaredKind as ModifierKind;
  } else {
    kind = price === null ? "free" : "paid";
  }

  // A modifier the model called "paid" but gave no readable price for is a
  // known-unknown, not a free modifier. Keep it visible as `unknown` so
  // diagnostics can flag it rather than silently zeroing the amount.
  if (kind === "paid" && price === null) kind = "unknown";
  if (kind === "free" && price !== null && price.minor !== 0) kind = "paid";

  return {
    id: asTrimmedString(raw.id) ?? nextEntityId("mod"),
    name,
    price: price ?? zeroMoney(currency),
    kind,
    sourceEvidence: parseEvidence(raw.sourceEvidence),
    confidence: asConfidence(raw.confidence),
  };
}

// ─── Items ────────────────────────────────────────────────────────────────────

/**
 * Derive the base (pre-modifier) contribution of a line.
 *
 * Preference order:
 *   1. unitPrice * quantity   — atomic, most reliable
 *   2. printed baseLineTotal  — when no unit price was printed
 *   3. zero                   — line is unpriced; diagnostics will flag it
 */
function deriveBaseTotal(
  unitPrice: Money | null,
  baseLineTotal: Money | null,
  quantity: number,
  currency: CurrencyCode
): { base: Money; unitPrice?: Money; baseLineTotal?: Money } {
  if (unitPrice !== null) {
    return {
      base: multiplyMoney(unitPrice, quantity),
      unitPrice,
      baseLineTotal: baseLineTotal ?? undefined,
    };
  }
  if (baseLineTotal !== null) {
    // Recover a unit price when it divides exactly; otherwise leave it absent
    // rather than inventing a rounded value.
    const exact =
      quantity > 0 && baseLineTotal.minor % quantity === 0
        ? moneyFromMinor(baseLineTotal.minor / quantity, currency)
        : undefined;
    return { base: baseLineTotal, unitPrice: exact, baseLineTotal };
  }
  return { base: zeroMoney(currency) };
}

function normalizeItem(
  raw: unknown,
  currency: CurrencyCode
): ReceiptLineItem | null {
  if (!isRecord(raw)) return null;

  const name = asTrimmedString(raw.name);
  const quantity = asPositiveInteger(raw.quantity, 1);

  const unitPrice = coerceMoney(raw.unitPrice, currency);
  const baseLineTotal = coerceMoney(raw.baseLineTotal ?? raw.totalPrice, currency);
  const discountRaw = coerceMoney(raw.discount, currency);
  // Discounts are stored as positive magnitudes and subtracted explicitly.
  const discount =
    discountRaw !== null
      ? moneyFromMinor(Math.abs(discountRaw.minor), currency)
      : undefined;

  const modifiers = asArray(raw.modifiers)
    .map((m) => normalizeModifier(m, currency))
    .filter((m): m is ReceiptModifier => m !== null);

  const derived = deriveBaseTotal(unitPrice, baseLineTotal, quantity, currency);

  const notes = asArray(raw.notes)
    .map((n) => asTrimmedString(n))
    .filter((n): n is string => n !== undefined);

  const item: ReceiptLineItem = {
    id: asTrimmedString(raw.id) ?? nextEntityId("item"),
    name: name ?? "Unnamed item",
    quantity,
    unitPrice: derived.unitPrice,
    baseLineTotal: derived.baseLineTotal,
    modifiers,
    discount,
    // Placeholder; recomputed immediately below so the invariant is enforced
    // in exactly one place.
    calculatedLineTotal: zeroMoney(currency),
    category: asTrimmedString(raw.category),
    notes: notes.length > 0 ? notes : undefined,
    sourceEvidence: parseEvidence(raw.sourceEvidence),
    confidence: asConfidence(raw.confidence),
  };

  item.calculatedLineTotal = computeLineTotal(item, currency);
  return item;
}

/**
 * The single source of truth for a line's contribution to the subtotal.
 * Exported so the correction engine recomputes identically after every edit.
 */
export function computeLineTotal(
  item: ReceiptLineItem,
  currency: CurrencyCode
): Money {
  const base =
    item.unitPrice !== undefined
      ? multiplyMoney(item.unitPrice, item.quantity)
      : (item.baseLineTotal ?? zeroMoney(currency));

  const modifierTotal = sumMoney(
    paidModifiers(item).map((m) => m.price),
    currency
  );

  const withModifiers = moneyFromMinor(base.minor + modifierTotal.minor, currency);
  return item.discount !== undefined
    ? subtractMoney(withModifiers, item.discount)
    : withModifiers;
}

// ─── Charges ──────────────────────────────────────────────────────────────────

function normalizeCharge(
  raw: unknown,
  currency: CurrencyCode
): ReceiptCharge | null {
  if (!isRecord(raw)) return null;

  const amount = coerceMoney(raw.amount, currency);
  if (amount === null) return null;

  const declaredKind = asTrimmedString(raw.kind)?.toLowerCase();
  const kind: ChargeKind =
    declaredKind !== undefined && CHARGE_KINDS.has(declaredKind)
      ? (declaredKind as ChargeKind)
      : "other";

  // Discounts are stored as positive magnitudes; the reconciler subtracts them.
  const normalizedAmount =
    kind === "discount"
      ? moneyFromMinor(Math.abs(amount.minor), currency)
      : amount;

  return {
    id: asTrimmedString(raw.id) ?? nextEntityId("charge"),
    name: asTrimmedString(raw.name) ?? kind,
    amount: normalizedAmount,
    kind,
    sourceEvidence: parseEvidence(raw.sourceEvidence),
  };
}

// ─── Unresolved lines ─────────────────────────────────────────────────────────

function normalizeUnresolvedLine(
  raw: unknown,
  currency: CurrencyCode
): UnresolvedMonetaryLine | null {
  if (!isRecord(raw)) return null;
  const amount = coerceMoney(raw.amount, currency);
  if (amount === null) return null;

  return {
    id: asTrimmedString(raw.id) ?? nextEntityId("orphan"),
    amount,
    text: asTrimmedString(raw.text),
    lineIndex: asLineIndex(raw.lineIndex),
    nearestItemLineIndex: asLineIndex(raw.nearestItemLineIndex),
    nearestItemId: asTrimmedString(raw.nearestItemId),
  };
}

/**
 * Resolve `nearestItemId` for orphan lines that only reported a line index,
 * by matching against item source evidence. Proximity is what makes an orphan
 * line actionable in the UI, so it is worth reconstructing here.
 */
function attachOrphansToItems(
  orphans: UnresolvedMonetaryLine[],
  items: readonly ReceiptLineItem[]
): UnresolvedMonetaryLine[] {
  const itemsByLine = new Map<number, ReceiptLineItem>();
  for (const item of items) {
    const line = item.sourceEvidence?.lineIndex;
    if (line !== undefined) itemsByLine.set(line, item);
  }
  if (itemsByLine.size === 0) return orphans;

  const sortedLines = Array.from(itemsByLine.keys()).sort((a, b) => a - b);

  return orphans.map((orphan) => {
    if (orphan.nearestItemId !== undefined) return orphan;

    const anchor = orphan.nearestItemLineIndex ?? orphan.lineIndex;
    if (anchor === undefined) return orphan;

    // Nearest item line at or above the orphan line.
    let candidate: number | undefined;
    for (const line of sortedLines) {
      if (line <= anchor) candidate = line;
      else break;
    }
    if (candidate === undefined) return orphan;

    const item = itemsByLine.get(candidate);
    if (item === undefined) return orphan;

    return {
      ...orphan,
      nearestItemId: item.id,
      nearestItemLineIndex: orphan.nearestItemLineIndex ?? candidate,
    };
  });
}

// ─── Totals ───────────────────────────────────────────────────────────────────

export function computeSubtotal(
  items: readonly ReceiptLineItem[],
  currency: CurrencyCode
): Money {
  return sumMoney(
    items.map((item) => item.calculatedLineTotal),
    currency
  );
}

/**
 * calculatedTotal = subtotal + service + tax + tip + other - discounts
 *
 * Prefers printed charge values when the receipt printed them, because a
 * printed service/tax line is a stronger signal than a re-derived one.
 */
export function computeTotal(
  subtotal: Money,
  charges: readonly ReceiptCharge[],
  currency: CurrencyCode
): Money {
  let total = subtotal.minor;
  for (const charge of charges) {
    if (charge.kind === "discount") total -= charge.amount.minor;
    else total += charge.amount.minor;
  }
  return moneyFromMinor(total, currency);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export interface NormalizeOptions {
  /**
   * Currency to assume when the receipt does not state one.
   * The result flags `currencyAssumed` so the UI can ask the user.
   */
  fallbackCurrency?: CurrencyCode;
}

/**
 * Build the canonical receipt from raw model output.
 *
 * The returned receipt has fully computed `calculatedSubtotal` /
 * `calculatedTotal` but a placeholder validation block — run the reconciler
 * to populate it.
 */
export function normalizeRawReceipt(
  raw: RawReceiptPayload,
  options: NormalizeOptions = {}
): CanonicalReceipt {
  const detected = normalizeCurrencyCode(
    typeof raw.currency === "string" ? raw.currency : undefined
  );
  const currency: CurrencyCode = detected ?? options.fallbackCurrency ?? "EUR";
  const currencyAssumed = detected === null;

  const items = asArray(raw.items)
    .map((item) => normalizeItem(item, currency))
    .filter((item): item is ReceiptLineItem => item !== null);

  const charges = asArray(raw.charges)
    .map((charge) => normalizeCharge(charge, currency))
    .filter((charge): charge is ReceiptCharge => charge !== null);

  const rawOrphans = asArray(raw.unresolvedLines)
    .map((line) => normalizeUnresolvedLine(line, currency))
    .filter((line): line is UnresolvedMonetaryLine => line !== null);
  const unresolvedMonetaryLines = attachOrphansToItems(rawOrphans, items);

  const calculatedSubtotal = computeSubtotal(items, currency);
  const calculatedTotal = computeTotal(calculatedSubtotal, charges, currency);

  const printedSubtotal = coerceMoney(raw.printedSubtotal, currency) ?? undefined;
  const printedServiceCharge =
    coerceMoney(raw.printedServiceCharge, currency) ?? undefined;
  const printedTax = coerceMoney(raw.printedTax, currency) ?? undefined;
  const printedTip = coerceMoney(raw.printedTip, currency) ?? undefined;
  const printedDiscountRaw = coerceMoney(raw.printedDiscount, currency);
  const printedDiscount =
    printedDiscountRaw !== null
      ? moneyFromMinor(Math.abs(printedDiscountRaw.minor), currency)
      : undefined;
  const printedTotal = coerceMoney(raw.printedTotal, currency) ?? undefined;

  return {
    merchantName:
      asTrimmedString(raw.merchant) ?? asTrimmedString(raw.restaurant),
    date: asTrimmedString(raw.date),
    currency,
    currencyAssumed,
    items,
    charges,
    unresolvedMonetaryLines,
    printedSubtotal,
    printedServiceCharge,
    printedTax,
    printedTip,
    printedDiscount,
    printedTotal,
    calculatedSubtotal,
    calculatedTotal,
    validation: {
      status: "unverifiable",
      missingPrintedSubtotal: printedSubtotal === undefined,
      missingPrintedTotal: printedTotal === undefined,
      issues: [],
    },
  };
}

/**
 * Recompute every derived amount on a receipt after items or charges changed.
 * Cheap enough to call on every keystroke in the correction UI.
 */
export function recomputeTotals(receipt: CanonicalReceipt): CanonicalReceipt {
  const items = receipt.items.map((item) => ({
    ...item,
    calculatedLineTotal: computeLineTotal(item, receipt.currency),
  }));
  const calculatedSubtotal = computeSubtotal(items, receipt.currency);
  const calculatedTotal = computeTotal(
    calculatedSubtotal,
    receipt.charges,
    receipt.currency
  );
  return { ...receipt, items, calculatedSubtotal, calculatedTotal };
}
