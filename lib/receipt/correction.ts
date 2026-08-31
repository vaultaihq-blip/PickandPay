/**
 * receiptCorrection — applies targeted user corrections and revalidates.
 *
 * Every mutation here is pure: it returns a new receipt with totals recomputed
 * and validation refreshed, so the UI can re-render live after each keystroke
 * and the user immediately sees whether the receipt now balances.
 *
 * Nothing in this module applies a correction on its own initiative. The
 * diagnostics engine proposes; the user disposes.
 */

import { type CurrencyCode, type Money, moneyFromMinor } from "./money";
import {
  type CanonicalReceipt,
  type CorrectionProposal,
  type ReceiptLineItem,
  type ReceiptModifier,
  nextEntityId,
} from "./model";
import { analyzeReceipt } from "./diagnostics";
import { computeLineTotal } from "./normalizer";

// ─── Edit primitives ──────────────────────────────────────────────────────────

export type ReceiptEdit =
  | { kind: "set_item_name"; itemId: string; name: string }
  | { kind: "set_item_quantity"; itemId: string; quantity: number }
  | { kind: "set_item_unit_price"; itemId: string; unitPrice: Money }
  | { kind: "set_item_discount"; itemId: string; discount?: Money }
  | { kind: "remove_item"; itemId: string }
  | {
      kind: "add_item";
      name: string;
      quantity: number;
      unitPrice: Money;
      category?: string;
    }
  | {
      kind: "add_modifier";
      itemId: string;
      name: string;
      price: Money;
      free?: boolean;
    }
  | {
      kind: "set_modifier_price";
      itemId: string;
      modifierId: string;
      price: Money;
    }
  | { kind: "set_modifier_name"; itemId: string; modifierId: string; name: string }
  | { kind: "set_modifier_free"; itemId: string; modifierId: string; free: boolean }
  | { kind: "remove_modifier"; itemId: string; modifierId: string }
  /** Attach an unresolved line to an item as a paid modifier and clear it. */
  | { kind: "resolve_orphan_as_modifier"; orphanId: string; itemId: string }
  /** Promote an unresolved line to a standalone item and clear it. */
  | { kind: "resolve_orphan_as_item"; orphanId: string; name?: string }
  /** Dismiss an unresolved line the user judges irrelevant. */
  | { kind: "dismiss_orphan"; orphanId: string };

export class CorrectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorrectionError";
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function requireItem(
  receipt: CanonicalReceipt,
  itemId: string
): ReceiptLineItem {
  const item = receipt.items.find((candidate) => candidate.id === itemId);
  if (item === undefined) {
    throw new CorrectionError(`Unknown item: ${itemId}`);
  }
  return item;
}

function mapItem(
  receipt: CanonicalReceipt,
  itemId: string,
  transform: (item: ReceiptLineItem) => ReceiptLineItem
): CanonicalReceipt {
  requireItem(receipt, itemId);
  return {
    ...receipt,
    items: receipt.items.map((item) =>
      item.id === itemId ? transform(item) : item
    ),
  };
}

function mapModifier(
  receipt: CanonicalReceipt,
  itemId: string,
  modifierId: string,
  transform: (modifier: ReceiptModifier) => ReceiptModifier
): CanonicalReceipt {
  const item = requireItem(receipt, itemId);
  if (!item.modifiers.some((modifier) => modifier.id === modifierId)) {
    throw new CorrectionError(`Unknown modifier: ${modifierId}`);
  }
  return mapItem(receipt, itemId, (current) => ({
    ...current,
    modifiers: current.modifiers.map((modifier) =>
      modifier.id === modifierId ? transform(modifier) : modifier
    ),
  }));
}

function assertCurrency(money: Money, currency: CurrencyCode): void {
  if (money.currency !== currency) {
    throw new CorrectionError(
      `Currency mismatch: expected ${currency}, received ${money.currency}`
    );
  }
}

function removeOrphan(
  receipt: CanonicalReceipt,
  orphanId: string
): CanonicalReceipt {
  return {
    ...receipt,
    unresolvedMonetaryLines: receipt.unresolvedMonetaryLines.filter(
      (line) => line.id !== orphanId
    ),
  };
}

function newItem(
  name: string,
  quantity: number,
  unitPrice: Money,
  currency: CurrencyCode,
  category?: string
): ReceiptLineItem {
  const item: ReceiptLineItem = {
    id: nextEntityId("item"),
    name,
    quantity: Math.max(1, Math.round(quantity)),
    unitPrice,
    modifiers: [],
    calculatedLineTotal: moneyFromMinor(0, currency),
    category,
  };
  return { ...item, calculatedLineTotal: computeLineTotal(item, currency) };
}

// ─── Edit application ─────────────────────────────────────────────────────────

/**
 * Apply a single edit without revalidating.
 * Use `applyEdits` unless you are batching and will revalidate yourself.
 */
export function applyEdit(
  receipt: CanonicalReceipt,
  edit: ReceiptEdit
): CanonicalReceipt {
  const { currency } = receipt;

  switch (edit.kind) {
    case "set_item_name":
      return mapItem(receipt, edit.itemId, (item) => ({
        ...item,
        name: edit.name.trim().length > 0 ? edit.name.trim() : item.name,
      }));

    case "set_item_quantity": {
      const quantity = Math.round(edit.quantity);
      if (!Number.isFinite(quantity) || quantity < 1) {
        throw new CorrectionError(`Invalid quantity: ${edit.quantity}`);
      }
      return mapItem(receipt, edit.itemId, (item) => ({ ...item, quantity }));
    }

    case "set_item_unit_price":
      assertCurrency(edit.unitPrice, currency);
      return mapItem(receipt, edit.itemId, (item) => ({
        ...item,
        unitPrice: edit.unitPrice,
        // A user-entered unit price supersedes any printed line total we read.
        baseLineTotal: undefined,
      }));

    case "set_item_discount":
      if (edit.discount !== undefined) assertCurrency(edit.discount, currency);
      return mapItem(receipt, edit.itemId, (item) => ({
        ...item,
        discount:
          edit.discount === undefined
            ? undefined
            : moneyFromMinor(Math.abs(edit.discount.minor), currency),
      }));

    case "remove_item":
      requireItem(receipt, edit.itemId);
      return {
        ...receipt,
        items: receipt.items.filter((item) => item.id !== edit.itemId),
      };

    case "add_item": {
      assertCurrency(edit.unitPrice, currency);
      const item = newItem(
        edit.name,
        edit.quantity,
        edit.unitPrice,
        currency,
        edit.category
      );
      return { ...receipt, items: [...receipt.items, item] };
    }

    case "add_modifier": {
      assertCurrency(edit.price, currency);
      const free = edit.free ?? edit.price.minor === 0;
      const modifier: ReceiptModifier = {
        id: nextEntityId("mod"),
        name: edit.name.trim().length > 0 ? edit.name.trim() : "Extra",
        price: free ? moneyFromMinor(0, currency) : edit.price,
        kind: free ? "free" : "paid",
      };
      return mapItem(receipt, edit.itemId, (item) => ({
        ...item,
        modifiers: [...item.modifiers, modifier],
      }));
    }

    case "set_modifier_price":
      assertCurrency(edit.price, currency);
      return mapModifier(receipt, edit.itemId, edit.modifierId, (modifier) => ({
        ...modifier,
        price: edit.price,
        // Pricing a modifier necessarily makes it paid.
        kind: edit.price.minor === 0 ? "free" : "paid",
      }));

    case "set_modifier_name":
      return mapModifier(receipt, edit.itemId, edit.modifierId, (modifier) => ({
        ...modifier,
        name: edit.name.trim().length > 0 ? edit.name.trim() : modifier.name,
      }));

    case "set_modifier_free":
      return mapModifier(receipt, edit.itemId, edit.modifierId, (modifier) => ({
        ...modifier,
        kind: edit.free ? "free" : "paid",
        price: edit.free ? moneyFromMinor(0, currency) : modifier.price,
      }));

    case "remove_modifier": {
      requireItem(receipt, edit.itemId);
      return mapItem(receipt, edit.itemId, (item) => ({
        ...item,
        modifiers: item.modifiers.filter(
          (modifier) => modifier.id !== edit.modifierId
        ),
      }));
    }

    case "resolve_orphan_as_modifier": {
      const orphan = receipt.unresolvedMonetaryLines.find(
        (line) => line.id === edit.orphanId
      );
      if (orphan === undefined) {
        throw new CorrectionError(`Unknown unresolved line: ${edit.orphanId}`);
      }
      const withModifier = applyEdit(receipt, {
        kind: "add_modifier",
        itemId: edit.itemId,
        name: orphan.text ?? "Extra",
        price: orphan.amount,
      });
      return removeOrphan(withModifier, edit.orphanId);
    }

    case "resolve_orphan_as_item": {
      const orphan = receipt.unresolvedMonetaryLines.find(
        (line) => line.id === edit.orphanId
      );
      if (orphan === undefined) {
        throw new CorrectionError(`Unknown unresolved line: ${edit.orphanId}`);
      }
      const withItem = applyEdit(receipt, {
        kind: "add_item",
        name: edit.name ?? orphan.text ?? "Item",
        quantity: 1,
        unitPrice: orphan.amount,
      });
      return removeOrphan(withItem, edit.orphanId);
    }

    case "dismiss_orphan":
      return removeOrphan(receipt, edit.orphanId);
  }
}

/**
 * Apply one or more edits and revalidate.
 *
 * This is the function the correction UI calls. The returned receipt carries a
 * fresh validation block, so the caller can immediately show either
 * "reconciled" or the next most likely issue.
 */
export function applyEdits(
  receipt: CanonicalReceipt,
  edits: readonly ReceiptEdit[]
): CanonicalReceipt {
  let next = receipt;
  for (const edit of edits) next = applyEdit(next, edit);
  return analyzeReceipt(next);
}

// ─── Proposals ────────────────────────────────────────────────────────────────

/** Translate a diagnostics proposal into the equivalent concrete edit. */
export function editFromProposal(proposal: CorrectionProposal): ReceiptEdit {
  switch (proposal.kind) {
    case "add_modifier":
      // When the proposal came from an unresolved line, resolving that line is
      // the same operation — doing both separately would leave the receipt
      // flagged for money it has already accounted for.
      if (proposal.resolvesOrphanId !== undefined) {
        return {
          kind: "resolve_orphan_as_modifier",
          orphanId: proposal.resolvesOrphanId,
          itemId: proposal.itemId,
        };
      }
      return {
        kind: "add_modifier",
        itemId: proposal.itemId,
        name: proposal.name,
        price: proposal.price,
      };
    case "set_item_unit_price":
      return {
        kind: "set_item_unit_price",
        itemId: proposal.itemId,
        unitPrice: proposal.unitPrice,
      };
    case "set_item_quantity":
      return {
        kind: "set_item_quantity",
        itemId: proposal.itemId,
        quantity: proposal.quantity,
      };
    case "add_item":
      if (proposal.resolvesOrphanId !== undefined) {
        return {
          kind: "resolve_orphan_as_item",
          orphanId: proposal.resolvesOrphanId,
          name: proposal.name,
        };
      }
      return {
        kind: "add_item",
        name: proposal.name,
        quantity: proposal.quantity,
        unitPrice: proposal.unitPrice,
      };
    case "remove_item":
      return { kind: "remove_item", itemId: proposal.itemId };
  }
}

/**
 * Apply a proposed correction on explicit user confirmation, then revalidate.
 */
export function applyProposal(
  receipt: CanonicalReceipt,
  proposal: CorrectionProposal
): CanonicalReceipt {
  return applyEdits(receipt, [editFromProposal(proposal)]);
}

/**
 * Preview the effect of a proposal without committing it.
 * Lets the UI show "this would balance the receipt" before the user accepts.
 */
export function previewProposal(
  receipt: CanonicalReceipt,
  proposal: CorrectionProposal
): { receipt: CanonicalReceipt; reconciles: boolean } {
  const next = applyProposal(receipt, proposal);
  return { receipt: next, reconciles: next.validation.status === "reconciled" };
}
