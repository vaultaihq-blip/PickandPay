/**
 * FIX 41 — comparing two independent structuring passes over the SAME OCR.
 *
 * Line reconstruction is deterministic (FIX 38 measured it directly: ten
 * runs against a frozen fixture, byte-identical every time). GPT's own
 * structuring call is not — the same OCR text, the same prompt, the same
 * schema, can return meaningfully different blocks call to call (Sulbarreiro
 * 80% approval, Mad God 45-98 blocks on one image, Quebra Mar 21-53 blocks
 * under FIX 39's own reconstruction). Five prior rounds tried to route
 * around that instability with deterministic rules; none eliminated it.
 *
 * The idea here is not to fix the instability but to MEASURE it: run the
 * structuring pass twice, compare what the two runs actually mean for the
 * receipt (never block IDs, block counts, or arrival order — those vary
 * without consequence), and treat disagreement as what it is — genuine
 * ambiguity — rather than something to silently resolve. Never a vote:
 * with two readings there is no majority, and choosing between two
 * disagreeing readings would be guessing which one is right, exactly the
 * failure mode FIX 29 (and others since) exists to avoid.
 */

import type { StructureBlock } from "./schema.ts";
import type { SummaryRoleAssignment } from "./coverage.ts";

export interface ComparableItem {
  name: string | null;
  quantity: number | null;
  /** The amountId the item's own price resolved to — never the block's own
   *  ID, which is an arbitrary per-call label GPT invents and which two
   *  independent, AGREEING reads have no reason to reuse. */
  priceAmountId: string | null;
  /** Every modifier's own resolved amountId, sorted — order and blockId are
   *  not part of what the receipt actually says. */
  modifierAmountIds: string[];
}

export interface ComparableRole {
  role: string;
  amountId: string;
}

export interface ComparableStructure {
  items: ComparableItem[];
  roles: ComparableRole[];
  printedTotal: number | null;
  printedSubtotal: number | null;
}

/**
 * Builds the user-relevant, order-independent view of a structuring pass's
 * OWN output (after deterministic ownership/offset-arbitration has already
 * resolved each block's amountId — this function reads that result, it
 * does not compute ownership itself). Two calls to this on genuinely
 * agreeing structures produce deep-equal results even when block IDs,
 * block counts, or block order differ between the two passes.
 */
export function extractComparableStructure(
  blocks: StructureBlock[],
  summaryRoleAssignments: SummaryRoleAssignment[],
  printedTotal: number | null,
  printedSubtotal: number | null
): ComparableStructure {
  const items: ComparableItem[] = blocks
    .filter((b) => b.kind === "item")
    .map((item) => {
      const modifierAmountIds = blocks
        .filter((m) => m.kind === "modifier" && m.parentBlockId === item.blockId)
        .map((m) => m.amountId)
        .filter((id): id is string => id !== null)
        .sort();
      return { name: item.name, quantity: item.quantity, priceAmountId: item.amountId, modifierAmountIds };
    })
    // Measured directly (Ramires, real fixture, both flag configurations):
    // a free/comp item ("OFERTA") with NO price of its own (priceAmountId
    // null) and no priced modifiers sometimes gets its own explicit item
    // block on one read and no block at all on the other — a structural
    // choice with ZERO financial consequence (nothing it could have
    // claimed exists either way). Without this filter, every such case
    // read as a disagreement despite both reads landing on the identical
    // printedTotal/printedSubtotal and every REAL priced item matching
    // exactly. An item with a real price (even 0.00, a genuinely printed
    // zero — see FIX 33) always HAS an amountId, so this never hides an
    // actual missing price; it only drops items that never had one to
    // begin with, on either side.
    .filter((item) => item.priceAmountId !== null || item.modifierAmountIds.length > 0)
    .sort((a, b) => {
      const byName = (a.name ?? "").localeCompare(b.name ?? "");
      if (byName !== 0) return byName;
      return (a.priceAmountId ?? "").localeCompare(b.priceAmountId ?? "");
    });

  const roles: ComparableRole[] = summaryRoleAssignments
    .map((r) => ({ role: r.role as string, amountId: r.amountId }))
    .sort((a, b) => a.role.localeCompare(b.role) || a.amountId.localeCompare(b.amountId));

  return { items, roles, printedTotal, printedSubtotal };
}

export interface StructureDisagreement {
  kind: "item" | "role" | "total" | "subtotal";
  detail: string;
}

/**
 * Compares two ComparableStructures. Returns an empty array when they
 * agree (deep-equal on the fields above), or a list of every point where
 * they diverge — used only for diagnostics (which class of instability
 * dominates), never to decide which reading to prefer.
 */
export function findStructureDisagreements(a: ComparableStructure, b: ComparableStructure): StructureDisagreement[] {
  const disagreements: StructureDisagreement[] = [];

  if (a.printedTotal !== b.printedTotal) {
    disagreements.push({ kind: "total", detail: `printedTotal ${a.printedTotal ?? "null"} vs ${b.printedTotal ?? "null"}` });
  }
  if (a.printedSubtotal !== b.printedSubtotal) {
    disagreements.push({ kind: "subtotal", detail: `printedSubtotal ${a.printedSubtotal ?? "null"} vs ${b.printedSubtotal ?? "null"}` });
  }

  const aItemsKey = JSON.stringify(a.items);
  const bItemsKey = JSON.stringify(b.items);
  if (aItemsKey !== bItemsKey) {
    disagreements.push({
      kind: "item",
      detail: `${a.items.length} vs ${b.items.length} items, or differing name/quantity/priceAmountId/modifiers`,
    });
  }

  const aRolesKey = JSON.stringify(a.roles);
  const bRolesKey = JSON.stringify(b.roles);
  if (aRolesKey !== bRolesKey) {
    disagreements.push({ kind: "role", detail: `${a.roles.length} vs ${b.roles.length} summary roles, or differing role/amountId` });
  }

  return disagreements;
}

/** Convenience wrapper — true only when findStructureDisagreements finds
 *  nothing at all. */
export function structuresAgree(a: ComparableStructure, b: ComparableStructure): boolean {
  return findStructureDisagreements(a, b).length === 0;
}
