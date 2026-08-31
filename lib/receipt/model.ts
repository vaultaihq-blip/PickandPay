/**
 * Canonical receipt model.
 *
 * This is the intermediate representation that sits between the vision model's
 * raw JSON and everything downstream (reconciliation, diagnostics, UI, DB).
 * It is deliberately independent of the legacy `ParsedReceipt` shape in
 * `types/index.ts` so that reconciliation logic cannot be corrupted by
 * presentation concerns.
 */

import type { CurrencyCode, Money } from "./money";

// ─── Source evidence ──────────────────────────────────────────────────────────

/**
 * Links a parsed entity back to the receipt as it was actually printed.
 * Only structured, non-sensitive evidence is retained — never model reasoning.
 */
export interface SourceEvidence {
  /** Zero-based index of the line in the model's own line inventory. */
  lineIndex?: number;
  /** Verbatim text of the receipt line, as read. */
  lineText?: string;
  /** Line index of the parent item, when this entity is a child line. */
  parentLineIndex?: number;
  /** Normalised bounding box [x0, y0, x1, y1] in 0..1, when available. */
  boundingBox?: readonly [number, number, number, number];
}

/** Coarse confidence bucket used throughout diagnostics and UI. */
export type ConfidenceLevel = "high" | "medium" | "low";

export function confidenceFromScore(score: number): ConfidenceLevel {
  if (score >= 0.75) return "high";
  if (score >= 0.45) return "medium";
  return "low";
}

// ─── Items and modifiers ──────────────────────────────────────────────────────

export type ModifierKind = "paid" | "free" | "unknown";

export interface ReceiptModifier {
  id: string;
  name: string;
  /** Zero for free modifiers. Never null — absence is expressed by `kind`. */
  price: Money;
  kind: ModifierKind;
  sourceEvidence?: SourceEvidence;
  confidence?: number;
}

export interface ReceiptLineItem {
  id: string;
  name: string;
  /** Always >= 1 after normalization. */
  quantity: number;
  /** Price of a single unit, excluding modifiers. */
  unitPrice?: Money;
  /** Printed line total for the base item, excluding modifiers, when shown. */
  baseLineTotal?: Money;
  modifiers: ReceiptModifier[];
  /** Item-level discount, stored as a positive amount that is subtracted. */
  discount?: Money;
  /**
   * Authoritative contribution of this line to the subtotal:
   *   quantity * unitPrice + paid modifiers - discount
   * Computed by the normalizer; never taken from the model directly.
   */
  calculatedLineTotal: Money;
  category?: string;
  notes?: string[];
  sourceEvidence?: SourceEvidence;
  confidence?: number;
}

// ─── Bill-level charges ───────────────────────────────────────────────────────

export type ChargeKind =
  | "service"
  | "tax"
  | "tip"
  | "discount"
  | "delivery"
  | "bag"
  | "other";

export interface ReceiptCharge {
  id: string;
  name: string;
  amount: Money;
  kind: ChargeKind;
  sourceEvidence?: SourceEvidence;
}

// ─── Unresolved monetary lines ────────────────────────────────────────────────

/**
 * A priced line the model read but could not attribute to any item, modifier
 * or bill-level charge. These are never discarded: they are the strongest
 * signal available when reconciliation fails.
 */
export interface UnresolvedMonetaryLine {
  id: string;
  amount: Money;
  text?: string;
  lineIndex?: number;
  /** Line index of the item this line appears directly beneath, if any. */
  nearestItemLineIndex?: number;
  /** Id of the item this line appears directly beneath, if resolvable. */
  nearestItemId?: string;
}

// ─── Validation ───────────────────────────────────────────────────────────────

export type ValidationStatus = "reconciled" | "needs_review" | "unverifiable";

export interface ReceiptValidation {
  status: ValidationStatus;
  /** printedSubtotal - calculatedSubtotal. Positive means items are missing. */
  subtotalDelta?: Money;
  /** printedTotal - calculatedTotal. */
  totalDelta?: Money;
  /** True when the receipt printed no subtotal to reconcile against. */
  missingPrintedSubtotal: boolean;
  /** True when the receipt printed no grand total to reconcile against. */
  missingPrintedTotal: boolean;
  /** Ranked probable causes; empty when reconciled. */
  issues: ReceiptIssue[];
}

// ─── Issues ───────────────────────────────────────────────────────────────────

export type ReceiptIssueType =
  | "missing_paid_modifier"
  | "incorrect_item_price"
  | "incorrect_quantity"
  | "orphan_price"
  | "missing_item"
  | "wrong_parent_item"
  | "possible_duplicate"
  | "discount_error"
  | "tax_error"
  | "service_error"
  | "total_error"
  | "unclassified";

/**
 * A concrete, user-applicable correction proposed by the diagnostics engine.
 * Corrections are only ever applied on explicit user confirmation.
 */
export type CorrectionProposal =
  | {
      kind: "add_modifier";
      itemId: string;
      name: string;
      price: Money;
      /**
       * Set when this proposal originated from an unresolved monetary line.
       * Applying it consumes that line, so the money is attributed exactly
       * once rather than being both counted and left outstanding.
       */
      resolvesOrphanId?: string;
    }
  | {
      kind: "set_item_unit_price";
      itemId: string;
      unitPrice: Money;
    }
  | {
      kind: "set_item_quantity";
      itemId: string;
      quantity: number;
    }
  | {
      kind: "add_item";
      name: string;
      quantity: number;
      unitPrice: Money;
      resolvesOrphanId?: string;
    }
  | {
      kind: "remove_item";
      itemId: string;
    };

export interface ReceiptIssue {
  id: string;
  type: ReceiptIssueType;
  /** 0..1 fit score. Use `confidenceLevel` for anything user-facing. */
  confidence: number;
  confidenceLevel: ConfidenceLevel;
  /** Item the issue points at, when localised. */
  itemId?: string;
  modifierId?: string;
  /** Verbatim receipt line backing this diagnosis, when available. */
  sourceLine?: string;
  /** The amount this issue would account for if corrected. */
  expectedDifference?: Money;
  /** Short, non-alarming, user-facing explanation. */
  message: string;
  /** Machine-applicable fix. Absent when we can only point, not propose. */
  proposal?: CorrectionProposal;
}

// ─── Receipt ──────────────────────────────────────────────────────────────────

export interface CanonicalReceipt {
  merchantName?: string;
  date?: string;
  currency: CurrencyCode;
  /** True when currency was assumed rather than read from the receipt. */
  currencyAssumed: boolean;

  items: ReceiptLineItem[];
  charges: ReceiptCharge[];
  unresolvedMonetaryLines: UnresolvedMonetaryLine[];

  /** Values as printed on the receipt. Absent when not printed. */
  printedSubtotal?: Money;
  printedServiceCharge?: Money;
  printedTax?: Money;
  printedTip?: Money;
  printedDiscount?: Money;
  printedTotal?: Money;

  /** Values derived from `items` and `charges`. Always present. */
  calculatedSubtotal: Money;
  calculatedTotal: Money;

  validation: ReceiptValidation;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function paidModifiers(
  item: ReceiptLineItem
): ReceiptModifier[] {
  return item.modifiers.filter((m) => m.kind === "paid" && m.price.minor !== 0);
}

export function findItemById(
  receipt: CanonicalReceipt,
  itemId: string
): ReceiptLineItem | undefined {
  return receipt.items.find((item) => item.id === itemId);
}

let idCounter = 0;

/** Stable-enough unique id generator for parsed entities. */
export function nextEntityId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}
