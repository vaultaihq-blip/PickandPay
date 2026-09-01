/**
 * End-to-end test of the v2 -> legacy bridge added in utils/parser.ts.
 *
 * This does NOT re-test the canonical pipeline itself (see pipeline.test.ts) —
 * it verifies the *bridge*: a raw v2 edge-function envelope goes through
 * normalizeRawReceipt -> evaluateReceipt -> toParsedReceipt -> normalizeReceipt,
 * exactly as utils/parser.ts's analyzeReceipt() now does for schemaVersion 2,
 * and that the canonical receipt is stored in canonicalReceiptStore along the
 * way. The historical bug this guards against: the legacy screens received
 * the v2 envelope directly, normalizeReceipt() found raw.categories
 * undefined, and every scan silently produced zero items.
 */

import { moneyToMajorNumber } from "../money";
import { evaluateReceipt } from "../diagnostics";
import { normalizeRawReceipt, type RawReceiptPayload } from "../normalizer";
import { toParsedReceipt } from "../adapter";
import { useCanonicalReceiptStore } from "@/store/canonicalReceiptStore";
import { normalizeReceipt } from "@/utils/parser";
import { validateReceiptOCR } from "@/lib/receipt-validator";
import { assert, assertEqual, describe, it } from "./harness";

// Toronto fixture: printed subtotal 374.25, service 67.36, tax 57.42, total
// 499.03 CAD. Same receipt as the "regression: Toronto receipt" suite in
// pipeline.test.ts, plus one paid modifier ("PT Shrimp") and one free
// modifier ("No Spice") on the same item, per the bridge test spec.
function buildV2Envelope(): { schemaVersion: 2; receipt: RawReceiptPayload } {
  return {
    schemaVersion: 2,
    receipt: {
      merchant: "Pai Northern Thai Kitchen",
      currency: "CAD",
      items: [
        { name: "Thai Chicken Wings", quantity: 1, unitPrice: 13.5 },
        { name: "Pad Gra Prow", quantity: 1, unitPrice: 23.0 },
        {
          name: "Chef Nuit Pad Thai",
          quantity: 1,
          unitPrice: 23.75,
          modifiers: [
            { name: "PT Shrimp", price: 2.0, kind: "paid" },
            { name: "No Spice", kind: "free" },
          ],
        },
        { name: "Spring Rolls", quantity: 1, unitPrice: 14.0 },
        {
          name: "Khao Soi",
          quantity: 1,
          unitPrice: 23.75,
          modifiers: [{ name: "KS Shrimp", price: 2.0, kind: "paid" }],
        },
        { name: "Sleeman Honey Lager", quantity: 1, unitPrice: 9.0 },
        { name: "Chef Nuit Pad Thai", quantity: 1, unitPrice: 23.75 },
        {
          name: "Green Curry",
          quantity: 1,
          unitPrice: 25.0,
          modifiers: [
            { name: "GC Shrimp", price: 2.0, kind: "paid" },
            { name: "Add Shrimp", price: 6.0, kind: "paid" },
          ],
        },
        { name: "BTL Campo Viejo Tempranillo", quantity: 2, unitPrice: 48.0 },
        { name: "Khao Soi", quantity: 1, unitPrice: 23.75 },
        { name: "Garlic Shrimp", quantity: 1, unitPrice: 17.0 },
        { name: "Pad See Ew", quantity: 1, unitPrice: 24.25 },
        { name: "Lowry", quantity: 1, unitPrice: 15.0 },
        { name: "Gai Satay", quantity: 1, unitPrice: 20.0 },
        { name: "Side", quantity: 1, unitPrice: 10.5 },
      ],
      charges: [
        { name: "Service (18%)", amount: 67.36, kind: "service" },
        { name: "Tax", amount: 57.42, kind: "tax" },
      ],
      printedSubtotal: 374.25,
      printedServiceCharge: 67.36,
      printedTax: 57.42,
      printedTotal: 499.03,
    },
  };
}

/** Mirrors the schemaVersion===2 branch of utils/parser.ts:analyzeReceipt(). */
function runBridge(envelope: { schemaVersion: number; receipt?: RawReceiptPayload }) {
  if (envelope.schemaVersion !== 2 || envelope.receipt === undefined) {
    throw new Error("test fixture must be a v2 envelope");
  }
  const canonical = evaluateReceipt(normalizeRawReceipt(envelope.receipt));
  const legacy = toParsedReceipt(canonical);

  useCanonicalReceiptStore.getState().setReceipt(canonical);

  const receipt = normalizeReceipt({
    ...legacy,
    printed_total:
      canonical.printedTotal !== undefined
        ? moneyToMajorNumber(canonical.printedTotal)
        : undefined,
  });

  return { receipt, canonical };
}

describe("bridge: v2 envelope -> legacy ParsedReceipt", () => {
  it("never reports 'error' status when every modifier is attributed", () => {
    const { receipt } = runBridge(buildV2Envelope());
    assert(
      receipt.validation.status !== "error",
      `expected status !== "error", got "${receipt.validation.status}"`
    );
  });

  it("reports 'ok' status for a receipt with real tax/service that fully reconciles", () => {
    // Regression: normalizeReceipt used to compare printed_total (grand
    // total, incl. tax+service) against itemsSum alone, ignoring
    // finalGlobalCosts — so any receipt with real tax/service (like this one,
    // 67.36 service + 57.42 tax) always showed a 124.78 gap and never
    // reported "ok", regardless of whether the items were correct.
    const { receipt } = runBridge(buildV2Envelope());
    assertEqual(receipt.validation.status, "ok");
  });

  it("keeps the paid modifier's price in the final subtotal", () => {
    const { receipt } = runBridge(buildV2Envelope());
    // 15 items totalling 374.25 including the 2.00 PT Shrimp folded in —
    // the historical bug dropped exactly this kind of line.
    assertEqual(receipt.validation.computedTotal, 374.25);
  });

  it("does not let the free modifier change the total", () => {
    const { receipt } = runBridge(buildV2Envelope());
    const allItems = [
      ...receipt.categories.starters,
      ...receipt.categories.mains,
      ...receipt.categories.drinks,
      ...receipt.categories.desserts,
      ...receipt.categories.others,
    ];
    const padThaiWithModifiers = allItems.find(
      (i) => i.name === "Chef Nuit Pad Thai" && i.notes?.includes("No Spice")
    );
    assert(
      padThaiWithModifiers !== undefined,
      "expected to find the Chef Nuit Pad Thai item carrying the free 'No Spice' note"
    );
    // 23.75 base + 2.00 paid PT Shrimp; the free "No Spice" note contributes 0.
    assertEqual(padThaiWithModifiers!.totalPrice, 25.75);
  });

  it("does not leave every category empty (the original defect)", () => {
    const { receipt } = runBridge(buildV2Envelope());
    const totalItems =
      receipt.categories.starters.length +
      receipt.categories.mains.length +
      receipt.categories.drinks.length +
      receipt.categories.desserts.length +
      receipt.categories.others.length;
    assertEqual(totalItems, 15);
  });

  it("routes to /(app)/review, not review-receipt, for a fully reconciled receipt", () => {
    // Regression: validateReceiptOCR compared receipt.validation.difference
    // (items-only, ignoring globalCosts) against TOTAL_TOLERANCE — so any
    // receipt with real tax/service (67.36 + 57.42 here) was always flagged
    // isWarning/isValid=false and scan.tsx/receipt-preview.tsx always routed
    // to review-receipt.tsx instead of review.tsx, even though items and
    // status were already correct.
    const { receipt } = runBridge(buildV2Envelope());
    const validation = validateReceiptOCR(receipt);
    assertEqual(validation.isValid, true);
    assertEqual(validation.isWarning, false);
    // Mirrors scan.tsx:165 / receipt-preview.tsx:111 exactly.
    const nextRoute =
      validation.isValid && !validation.isWarning ? "/(app)/review" : "/(app)/review-receipt";
    assertEqual(nextRoute, "/(app)/review");
  });

  it("stores the canonical receipt in canonicalReceiptStore for the review screen", () => {
    const { canonical } = runBridge(buildV2Envelope());
    const stored = useCanonicalReceiptStore.getState().receipt;
    assert(stored !== null, "expected canonicalReceiptStore to hold a receipt");
    assertEqual(stored, canonical);
  });
});
