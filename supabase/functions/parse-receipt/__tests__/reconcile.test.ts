import { describe, it, assertEqual } from "./harness";
import { reconcile } from "../reconcile";
import type { RawPayload } from "../types";

describe("reconcile(): arithmetic and resolution are independent signals", () => {
  it("reconciles when items sum exactly to the printed subtotal, even with unresolved orphans present", () => {
    // A real receipt almost always prints at least one number that isn't a
    // price (table number, tax ID, postal code). That must not invalidate
    // an otherwise-perfect reconciliation.
    const payload: RawPayload = {
      currency: "CAD",
      items: [
        { id: "i1", name: "A", quantity: 1, unitPrice: 40 },
        { id: "i2", name: "B", quantity: 1, unitPrice: 60 },
      ],
      printedSubtotal: 100,
      printedTotal: 100,
      unresolvedLines: [
        { id: "orphan_1", amount: 6, text: "6", lineIndex: 3 },
        { id: "orphan_2", amount: 110, text: "110", lineIndex: 50 },
      ],
    };
    const result = reconcile(payload);
    assertEqual(result.reconciles, true, "perfect arithmetic must reconcile regardless of unrelated unresolved noise");
    assertEqual(result.subtotalDeltaMinor, 0);
    assertEqual(result.unresolvedCount, 2, "unresolvedCount must still be reported — it's just no longer folded into reconciles");
  });

  it("does NOT reconcile when the subtotal delta is nonzero (regression guard)", () => {
    const payload: RawPayload = {
      currency: "CAD",
      items: [{ id: "i1", name: "A", quantity: 1, unitPrice: 40 }],
      printedSubtotal: 100, // items only sum to 40 — a real 60 discrepancy
      unresolvedLines: [],
    };
    const result = reconcile(payload);
    assertEqual(result.reconciles, false, "a genuine arithmetic mismatch must still fail reconciliation");
  });

  it("does NOT reconcile when there is no printed subtotal at all (regression guard)", () => {
    const payload: RawPayload = {
      currency: "CAD",
      items: [{ id: "i1", name: "A", quantity: 1, unitPrice: 40 }],
      printedSubtotal: null,
      unresolvedLines: [],
    };
    const result = reconcile(payload);
    assertEqual(result.reconciles, false, "with nothing printed to compare against, reconciliation cannot be claimed");
  });
});
