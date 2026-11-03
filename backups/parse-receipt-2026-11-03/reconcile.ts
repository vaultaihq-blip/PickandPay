/**
 * Minimal exact money helpers and server-side lightweight reconciliation.
 *
 * Extracted out of index.ts (which has Deno-only imports and can't be
 * loaded by a Node test) so tests can call the actual production function
 * instead of a parallel reimplementation. A prior version of the fixture
 * arithmetic test recomputed the sum itself rather than calling this
 * function — it passed while the real pipeline failed the same check, on
 * the same data, for a reason the reimplementation didn't share. This
 * module exists so that can't happen again: index.ts, the local debug
 * script, and the test suite all import the same function.
 *
 * Pure TypeScript — no Deno-specific imports.
 */

import type { RawPayload } from "./types.ts";

const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "CLP", "ISK"]);

function scaleFor(currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 1 : 100;
}

export function toMinor(value: unknown, currency: string): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const scaled = value * scaleFor(currency);
    const rounded = scaled < 0 ? -Math.round(Math.abs(scaled)) : Math.round(scaled);
    return Number.isSafeInteger(rounded) ? rounded : null;
  }
  if (typeof value === "string") {
    const cleaned = value.replace(/[^0-9.,-]/g, "").trim();
    if (cleaned.length === 0) return null;
    const normalized = cleaned.replace(",", ".");
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed)) return null;
    return toMinor(parsed, currency);
  }
  return null;
}

export function toMajor(minor: number, currency: string): number {
  return minor / scaleFor(currency);
}

export interface ServerReconciliation {
  currency: string;
  itemCount: number;
  calculatedSubtotalMinor: number;
  printedSubtotalMinor: number | null;
  subtotalDeltaMinor: number | null;
  printedTotalMinor: number | null;
  unresolvedCount: number;
  reconciles: boolean;
}

export function reconcile(payload: RawPayload): ServerReconciliation {
  const currency =
    typeof payload.currency === "string" && payload.currency.trim().length > 0
      ? payload.currency.trim().toUpperCase()
      : "EUR";

  const items = Array.isArray(payload.items) ? payload.items : [];
  let subtotalMinor = 0;

  for (const item of items) {
    const quantityRaw =
      typeof item.quantity === "number" ? Math.round(item.quantity) : 1;
    const quantity = Number.isFinite(quantityRaw) && quantityRaw >= 1 ? quantityRaw : 1;

    const unit = toMinor(item.unitPrice, currency);
    const lineTotal = toMinor(item.baseLineTotal, currency);

    let base = 0;
    if (unit !== null) base = unit * quantity;
    else if (lineTotal !== null) base = lineTotal;

    let modifiers = 0;
    for (const modifier of item.modifiers ?? []) {
      if (modifier.kind === "free") continue;
      const price = toMinor(modifier.price, currency);
      if (price !== null) modifiers += price;
    }

    const discount = toMinor(item.discount, currency) ?? 0;
    subtotalMinor += base + modifiers - Math.abs(discount);
  }

  const printedSubtotalMinor = toMinor(payload.printedSubtotal, currency);
  const printedTotalMinor = toMinor(payload.printedTotal, currency);
  const unresolved = Array.isArray(payload.unresolvedLines)
    ? payload.unresolvedLines
    : [];

  const subtotalDeltaMinor =
    printedSubtotalMinor === null ? null : printedSubtotalMinor - subtotalMinor;

  // Reconciliation is an arithmetic claim: the summed items match the
  // printed subtotal exactly. An unclaimed printed number (a table number,
  // a tax ID, a postal-code fragment) is normal receipt noise, not evidence
  // the arithmetic is wrong — reported separately via unresolvedCount,
  // never folded into this boolean. Almost every real receipt prints at
  // least one non-price number, so requiring zero orphans here made a
  // perfect reconciliation nearly unreachable in practice.
  const reconciles =
    subtotalDeltaMinor !== null &&
    subtotalDeltaMinor === 0;

  return {
    currency,
    itemCount: items.length,
    calculatedSubtotalMinor: subtotalMinor,
    printedSubtotalMinor,
    subtotalDeltaMinor,
    printedTotalMinor,
    unresolvedCount: unresolved.length,
    reconciles,
  };
}
