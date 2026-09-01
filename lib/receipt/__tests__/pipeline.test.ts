import { moneyFromMajorNumber, moneyToDecimalString } from "../money";
import { evaluateReceipt, diagnoseReceipt } from "../diagnostics";
import { applyProposal, applyEdits } from "../correction";
import { normalizeRawReceipt, type RawReceiptPayload } from "../normalizer";
import { reconcileReceipt } from "../reconciler";
import type { CanonicalReceipt } from "../model";
import { assert, assertEqual, describe, it } from "./harness";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function build(raw: RawReceiptPayload): CanonicalReceipt {
  return evaluateReceipt(normalizeRawReceipt(raw));
}

function subtotalOf(receipt: CanonicalReceipt): string {
  return moneyToDecimalString(receipt.calculatedSubtotal);
}

// ─── Normalization ────────────────────────────────────────────────────────────

describe("normalizer: structure", () => {
  it("computes line totals from unit price and quantity", () => {
    const receipt = build({
      currency: "USD",
      items: [{ name: "Coffee", quantity: 3, unitPrice: 2.5 }],
      printedSubtotal: 7.5,
    });
    assertEqual(subtotalOf(receipt), "7.50");
    assertEqual(receipt.validation.status, "reconciled");
  });

  it("adds paid modifiers into the line total", () => {
    const receipt = build({
      currency: "CAD",
      items: [
        {
          name: "Green Curry",
          quantity: 1,
          unitPrice: 25.0,
          modifiers: [{ name: "Add Shrimp", price: 6.0, kind: "paid" }],
        },
      ],
      printedSubtotal: 31.0,
    });
    assertEqual(subtotalOf(receipt), "31.00");
    assertEqual(receipt.validation.status, "reconciled");
  });

  it("does not charge for free modifiers", () => {
    const receipt = build({
      currency: "CAD",
      items: [
        {
          name: "Pad Thai",
          quantity: 1,
          unitPrice: 23.75,
          modifiers: [
            { name: "No Spice", kind: "free" },
            { name: "Mild", kind: "free" },
          ],
        },
      ],
      printedSubtotal: 23.75,
    });
    assertEqual(subtotalOf(receipt), "23.75");
    assertEqual(receipt.validation.status, "reconciled");
  });

  it("handles multiple paid modifiers on one item", () => {
    const receipt = build({
      currency: "CAD",
      items: [
        {
          name: "Green Curry",
          quantity: 1,
          unitPrice: 25.0,
          modifiers: [
            { name: "GC Shrimp", price: 2.0, kind: "paid" },
            { name: "Add Shrimp", price: 6.0, kind: "paid" },
          ],
        },
      ],
      printedSubtotal: 33.0,
    });
    assertEqual(subtotalOf(receipt), "33.00");
    assertEqual(receipt.validation.status, "reconciled");
  });

  it("keeps a paid modifier with no readable price as unknown, not free", () => {
    const receipt = build({
      currency: "CAD",
      items: [
        {
          name: "Pad Thai",
          quantity: 1,
          unitPrice: 23.75,
          modifiers: [{ name: "PT Shrimp", kind: "paid" }],
        },
      ],
      printedSubtotal: 25.75,
    });
    assertEqual(receipt.items[0].modifiers[0].kind, "unknown");
    assertEqual(receipt.validation.status, "needs_review");
  });

  it("recovers a unit price from a printed line total when it divides exactly", () => {
    const receipt = build({
      currency: "CAD",
      items: [{ name: "Wine", quantity: 2, baseLineTotal: 96.0 }],
      printedSubtotal: 96.0,
    });
    assertEqual(moneyToDecimalString(receipt.items[0].unitPrice!), "48.00");
  });

  it("subtracts item-level discounts", () => {
    const receipt = build({
      currency: "EUR",
      items: [{ name: "Menu", quantity: 1, unitPrice: 20.0, discount: 5.0 }],
      printedSubtotal: 15.0,
    });
    assertEqual(subtotalOf(receipt), "15.00");
    assertEqual(receipt.validation.status, "reconciled");
  });

  it("parses EUR comma decimals from string amounts", () => {
    const receipt = build({
      currency: "EUR",
      items: [{ name: "Café", quantity: 2, unitPrice: "1,20" }],
      printedSubtotal: "2,40",
    });
    assertEqual(subtotalOf(receipt), "2.40");
    assertEqual(receipt.validation.status, "reconciled");
  });

  it("handles JPY zero-decimal amounts", () => {
    const receipt = build({
      currency: "JPY",
      items: [{ name: "Ramen", quantity: 2, unitPrice: 980 }],
      printedSubtotal: 1960,
    });
    assertEqual(subtotalOf(receipt), "1960");
    assertEqual(receipt.validation.status, "reconciled");
  });

  it("flags an assumed currency instead of silently defaulting", () => {
    const receipt = build({
      currency: "$",
      items: [{ name: "Item", quantity: 1, unitPrice: 10 }],
      printedSubtotal: 10,
    });
    assert(receipt.currencyAssumed, "ambiguous $ must be marked as assumed");
  });
});

// ─── Charges and totals ───────────────────────────────────────────────────────

describe("reconciler: charges", () => {
  it("adds tax and service to reach the grand total", () => {
    const receipt = build({
      currency: "CAD",
      items: [{ name: "Food", quantity: 1, unitPrice: 100 }],
      charges: [
        { name: "Service", amount: 18, kind: "service" },
        { name: "Tax", amount: 13, kind: "tax" },
      ],
      printedSubtotal: 100,
      printedTotal: 131,
    });
    assertEqual(moneyToDecimalString(receipt.calculatedTotal), "131.00");
    assertEqual(receipt.validation.status, "reconciled");
  });

  it("includes a tip in the total", () => {
    const receipt = build({
      currency: "USD",
      items: [{ name: "Food", quantity: 1, unitPrice: 50 }],
      charges: [{ name: "Tip", amount: 10, kind: "tip" }],
      printedSubtotal: 50,
      printedTotal: 60,
    });
    assertEqual(receipt.validation.status, "reconciled");
  });

  it("subtracts a bill-level discount", () => {
    const receipt = build({
      currency: "EUR",
      items: [{ name: "Food", quantity: 1, unitPrice: 50 }],
      charges: [{ name: "Voucher", amount: 10, kind: "discount" }],
      printedSubtotal: 50,
      printedTotal: 40,
    });
    assertEqual(receipt.validation.status, "reconciled");
  });

  it("reports needs_review when the printed total disagrees", () => {
    const receipt = build({
      currency: "USD",
      items: [{ name: "Food", quantity: 1, unitPrice: 50 }],
      charges: [{ name: "Tax", amount: 5, kind: "tax" }],
      printedSubtotal: 50,
      printedTotal: 60,
    });
    assertEqual(receipt.validation.status, "needs_review");
    assertEqual(moneyToDecimalString(receipt.validation.totalDelta!), "5.00");
  });

  it("marks a receipt with no printed anchors as unverifiable, never reconciled", () => {
    const receipt = build({
      currency: "USD",
      items: [{ name: "Food", quantity: 1, unitPrice: 50 }],
    });
    assertEqual(receipt.validation.status, "unverifiable");
  });
});

// ─── Diagnostics ──────────────────────────────────────────────────────────────

describe("diagnostics: orphan lines", () => {
  it("attributes an orphan line under an item as a missing paid modifier", () => {
    const receipt = build({
      currency: "USD",
      items: [
        {
          id: "i1",
          name: "Pad Thai",
          quantity: 1,
          unitPrice: 23,
          sourceEvidence: { lineIndex: 4 },
        },
      ],
      unresolvedLines: [
        { id: "o1", amount: 2.0, text: "PT Shrimp", lineIndex: 5 },
      ],
      printedSubtotal: 25.0,
    });

    const issue = receipt.validation.issues[0];
    assertEqual(receipt.validation.status, "needs_review");
    assertEqual(issue.type, "missing_paid_modifier");
    assertEqual(issue.confidenceLevel, "high");
    assertEqual(moneyToDecimalString(issue.expectedDifference!), "2.00");
    assertEqual(issue.itemId, "i1");
  });

  it("applying the proposal reconciles the receipt", () => {
    const receipt = build({
      currency: "USD",
      items: [
        {
          id: "i1",
          name: "Pad Thai",
          quantity: 1,
          unitPrice: 23,
          sourceEvidence: { lineIndex: 4 },
        },
      ],
      unresolvedLines: [
        { id: "o1", amount: 2.0, text: "PT Shrimp", lineIndex: 5 },
      ],
      printedSubtotal: 25.0,
    });

    const proposal = receipt.validation.issues[0].proposal;
    assert(proposal !== undefined, "expected an applicable proposal");
    const corrected = applyProposal(receipt, proposal!);

    assertEqual(subtotalOf(corrected), "25.00");
    assertEqual(corrected.validation.status, "reconciled");
    assertEqual(corrected.validation.issues.length, 0);
  });

  it("never reports reconciled while a priced line is unattributed", () => {
    // Subtotal agrees, but money was read and attached to nothing: the parse
    // is still incomplete and must not show a green state.
    const receipt = build({
      currency: "USD",
      items: [{ name: "Food", quantity: 1, unitPrice: 25 }],
      unresolvedLines: [{ id: "o1", amount: 3.0, text: "Extra" }],
      printedSubtotal: 25.0,
    });
    assertEqual(receipt.validation.status, "needs_review");
    assertEqual(receipt.validation.issues[0].type, "orphan_price");
  });

  it("explains a delta using a two-line subset when no single line fits", () => {
    const receipt = build({
      currency: "USD",
      items: [
        { id: "i1", name: "Curry", quantity: 1, unitPrice: 25, sourceEvidence: { lineIndex: 1 } },
      ],
      unresolvedLines: [
        { id: "o1", amount: 2.0, text: "Shrimp", lineIndex: 2 },
        { id: "o2", amount: 6.0, text: "Add Shrimp", lineIndex: 3 },
      ],
      printedSubtotal: 33.0,
    });
    assertEqual(receipt.validation.status, "needs_review");
    assert(
      receipt.validation.issues.some((i) => i.type === "missing_paid_modifier"),
      "expected a missing modifier diagnosis"
    );
  });
});

describe("diagnostics: item-level errors", () => {
  it("detects a misread price as a single-digit confusion", () => {
    const receipt = build({
      currency: "USD",
      items: [{ id: "i1", name: "Steak", quantity: 1, unitPrice: 23.0 }],
      printedSubtotal: 28.0,
    });
    const issue = receipt.validation.issues[0];
    assertEqual(issue.type, "incorrect_item_price");
    assertEqual(issue.itemId, "i1");

    const corrected = applyProposal(receipt, issue.proposal!);
    assertEqual(corrected.validation.status, "reconciled");
  });

  it("detects a misread quantity", () => {
    const receipt = build({
      currency: "USD",
      items: [
        {
          id: "i1",
          name: "Beer",
          quantity: 1,
          unitPrice: 9.0,
          sourceEvidence: { lineText: "2 x Beer" },
        },
      ],
      printedSubtotal: 18.0,
    });
    const issue = receipt.validation.issues[0];
    assertEqual(issue.type, "incorrect_quantity");

    const corrected = applyProposal(receipt, issue.proposal!);
    assertEqual(subtotalOf(corrected), "18.00");
    assertEqual(corrected.validation.status, "reconciled");
  });

  it("detects a duplicated item when we counted too much", () => {
    const receipt = build({
      currency: "USD",
      items: [
        { id: "i1", name: "Khao Soi", quantity: 1, unitPrice: 23.75 },
        { id: "i2", name: "Khao Soi", quantity: 1, unitPrice: 23.75 },
      ],
      printedSubtotal: 23.75,
    });
    const issue = receipt.validation.issues[0];
    assertEqual(issue.type, "possible_duplicate");

    const corrected = applyProposal(receipt, issue.proposal!);
    assertEqual(subtotalOf(corrected), "23.75");
    assertEqual(corrected.validation.status, "reconciled");
  });

  it("flags an item with no readable price", () => {
    const receipt = build({
      currency: "USD",
      items: [
        { id: "i1", name: "Priced", quantity: 1, unitPrice: 10 },
        { id: "i2", name: "Unpriced", quantity: 1 },
      ],
      printedSubtotal: 25.0,
    });
    assert(
      receipt.validation.issues.some(
        (i) => i.type === "incorrect_item_price" && i.itemId === "i2"
      ),
      "expected the unpriced item to be flagged"
    );
  });

  it("prices an unknown-kind modifier when it is the only candidate", () => {
    const receipt = build({
      currency: "CAD",
      items: [
        {
          id: "i1",
          name: "Pad Thai",
          quantity: 1,
          unitPrice: 23.75,
          modifiers: [{ id: "m1", name: "PT Shrimp", kind: "paid" }],
        },
      ],
      printedSubtotal: 25.75,
    });
    const issue = receipt.validation.issues[0];
    assertEqual(issue.type, "missing_paid_modifier");
    assertEqual(issue.modifierId, "m1");

    const corrected = applyProposal(receipt, issue.proposal!);
    assertEqual(corrected.validation.status, "reconciled");
  });

  it("stays honest when nothing explains the delta", () => {
    const receipt = build({
      currency: "USD",
      items: [{ id: "i1", name: "Item", quantity: 3, unitPrice: 10 }],
      printedSubtotal: 137.77,
    });
    const issue = receipt.validation.issues[0];
    assertEqual(issue.type, "unclassified");
    assertEqual(issue.confidenceLevel, "low");
    assertEqual(issue.proposal, undefined);
  });

  it("detects a charge line that does not agree with the printed total", () => {
    const receipt = build({
      currency: "CAD",
      items: [{ name: "Food", quantity: 1, unitPrice: 100 }],
      charges: [
        { name: "Service", amount: 18, kind: "service" },
        { name: "Tax", amount: 13, kind: "tax" },
      ],
      printedSubtotal: 100,
      printedServiceCharge: 18,
      printedTax: 13,
      printedTotal: 140,
    });
    assert(
      receipt.validation.issues.some(
        (i) =>
          i.type === "tax_error" ||
          i.type === "service_error" ||
          i.type === "total_error"
      ),
      "expected a charge-level diagnosis"
    );
  });
});

// ─── Iterative correction ─────────────────────────────────────────────────────

describe("correction: iterative flow", () => {
  it("re-ranks the remaining issue after the first fix", () => {
    const receipt = build({
      currency: "USD",
      items: [
        { id: "i1", name: "A", quantity: 1, unitPrice: 10, sourceEvidence: { lineIndex: 1 } },
        { id: "i2", name: "B", quantity: 1, unitPrice: 20, sourceEvidence: { lineIndex: 3 } },
      ],
      unresolvedLines: [{ id: "o1", amount: 5.0, text: "Extra", lineIndex: 2 }],
      printedSubtotal: 40.0,
    });

    // Two defects: an unattributed 5.00 line and a further 5.00 shortfall.
    assertEqual(receipt.validation.status, "needs_review");

    const afterFirst = applyEdits(receipt, [
      { kind: "resolve_orphan_as_modifier", orphanId: "o1", itemId: "i1" },
    ]);
    assertEqual(subtotalOf(afterFirst), "35.00");
    assertEqual(afterFirst.validation.status, "needs_review");
    assert(
      afterFirst.validation.issues.length > 0,
      "a second issue should now be surfaced"
    );

    const afterSecond = applyEdits(afterFirst, [
      {
        kind: "set_item_unit_price",
        itemId: "i2",
        unitPrice: moneyFromMajorNumber(25, "USD"),
      },
    ]);
    assertEqual(subtotalOf(afterSecond), "40.00");
    assertEqual(afterSecond.validation.status, "reconciled");
    assertEqual(afterSecond.validation.issues.length, 0);
  });

  it("clears speculative issues once the receipt balances", () => {
    const receipt = build({
      currency: "USD",
      items: [{ id: "i1", name: "Item", quantity: 1, unitPrice: 10 }],
      printedSubtotal: 15.0,
    });
    assert(receipt.validation.issues.length > 0, "expected issues");

    const corrected = applyEdits(receipt, [
      {
        kind: "set_item_unit_price",
        itemId: "i1",
        unitPrice: moneyFromMajorNumber(15, "USD"),
      },
    ]);
    assertEqual(corrected.validation.issues.length, 0);
  });

  it("supports manual modifier editing", () => {
    let receipt = build({
      currency: "EUR",
      items: [{ id: "i1", name: "Burger", quantity: 1, unitPrice: 12 }],
      printedSubtotal: 14.5,
    });

    receipt = applyEdits(receipt, [
      {
        kind: "add_modifier",
        itemId: "i1",
        name: "Bacon",
        price: moneyFromMajorNumber(2.5, "EUR"),
      },
    ]);
    assertEqual(subtotalOf(receipt), "14.50");
    assertEqual(receipt.validation.status, "reconciled");

    receipt = applyEdits(receipt, [
      {
        kind: "set_modifier_free",
        itemId: "i1",
        modifierId: receipt.items[0].modifiers[0].id,
        free: true,
      },
    ]);
    assertEqual(subtotalOf(receipt), "12.00");
    assertEqual(receipt.validation.status, "needs_review");
  });

  it("removes an unresolved line when the user dismisses it", () => {
    const receipt = build({
      currency: "USD",
      items: [{ id: "i1", name: "Item", quantity: 1, unitPrice: 25 }],
      unresolvedLines: [{ id: "o1", amount: 3.0, text: "?" }],
      printedSubtotal: 25.0,
    });
    assertEqual(receipt.validation.status, "needs_review");

    const corrected = applyEdits(receipt, [
      { kind: "dismiss_orphan", orphanId: "o1" },
    ]);
    assertEqual(corrected.validation.status, "reconciled");
  });
});

// ─── Regression: Toronto receipt ──────────────────────────────────────────────

describe("regression: Toronto receipt", () => {
  // Printed anchors: subtotal 374.25, service 67.36, tax 57.42, total 499.03.
  // Used purely as a fixture; no value here is special-cased anywhere in the
  // pipeline.
  const printed = {
    subtotal: 374.25,
    service: 67.36,
    tax: 57.42,
    total: 499.03,
  };

  const charges = [
    { name: "Service (18%)", amount: printed.service, kind: "service" },
    { name: "Tax", amount: printed.tax, kind: "tax" },
  ];

  it("reconciles when every modifier is attributed", () => {
    const receipt = build({
      currency: "CAD",
      merchant: "Pai Northern Thai Kitchen",
      items: [
        { name: "Thai Chicken Wings", quantity: 1, unitPrice: 13.5 },
        { name: "Pad Gra Prow", quantity: 1, unitPrice: 23.0 },
        {
          name: "Chef Nuit Pad Thai",
          quantity: 1,
          unitPrice: 23.75,
          modifiers: [{ name: "PT Shrimp", price: 2.0, kind: "paid" }],
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
      charges,
      printedSubtotal: printed.subtotal,
      printedServiceCharge: printed.service,
      printedTax: printed.tax,
      printedTotal: printed.total,
    });

    assertEqual(subtotalOf(receipt), "374.25");
    assertEqual(moneyToDecimalString(receipt.calculatedTotal), "499.03");
    assertEqual(receipt.validation.status, "reconciled");
    assertEqual(receipt.validation.issues.length, 0);
  });

  it("detects, localises and repairs a dropped modifier", () => {
    // Same receipt with the 8.25 of extras dropped: the historical failure.
    const receipt = build({
      currency: "CAD",
      merchant: "Pai Northern Thai Kitchen",
      items: [
        { id: "wings", name: "Thai Chicken Wings", quantity: 1, unitPrice: 13.5 },
        { id: "pgp", name: "Pad Gra Prow", quantity: 1, unitPrice: 23.0 },
        {
          id: "pt1",
          name: "Chef Nuit Pad Thai",
          quantity: 1,
          unitPrice: 23.75,
          sourceEvidence: { lineIndex: 10 },
        },
        { id: "rolls", name: "Spring Rolls", quantity: 1, unitPrice: 14.0 },
        {
          id: "ks1",
          name: "Khao Soi",
          quantity: 1,
          unitPrice: 23.75,
          modifiers: [{ name: "KS Shrimp", price: 2.0, kind: "paid" }],
        },
        { id: "beer", name: "Sleeman Honey Lager", quantity: 1, unitPrice: 9.0 },
        { id: "pt2", name: "Chef Nuit Pad Thai", quantity: 1, unitPrice: 23.75 },
        {
          id: "curry",
          name: "Green Curry",
          quantity: 1,
          unitPrice: 25.0,
          modifiers: [
            { name: "GC Shrimp", price: 2.0, kind: "paid" },
            { name: "Add Shrimp", price: 6.0, kind: "paid" },
          ],
        },
        { id: "wine", name: "BTL Campo Viejo Tempranillo", quantity: 2, unitPrice: 48.0 },
        { id: "ks2", name: "Khao Soi", quantity: 1, unitPrice: 23.75 },
        { id: "shrimp", name: "Garlic Shrimp", quantity: 1, unitPrice: 17.0 },
        { id: "psew", name: "Pad See Ew", quantity: 1, unitPrice: 24.25 },
        { id: "lowry", name: "Lowry", quantity: 1, unitPrice: 15.0 },
        { id: "satay", name: "Gai Satay", quantity: 1, unitPrice: 20.0 },
        { id: "side", name: "Side", quantity: 1, unitPrice: 10.5 },
      ],
      // The 2.00 PT Shrimp line was read but not attached to its parent.
      unresolvedLines: [
        { id: "orphan-pt", amount: 2.0, text: "PT Shrimp", lineIndex: 11 },
      ],
      charges,
      printedSubtotal: printed.subtotal,
      printedServiceCharge: printed.service,
      printedTax: printed.tax,
      printedTotal: printed.total,
    });

    // 1. mismatch detected — not silently accepted
    assertEqual(receipt.validation.status, "needs_review");
    // 2. exact delta computed
    assertEqual(moneyToDecimalString(receipt.validation.subtotalDelta!), "2.00");

    // 3 & 4. localised to the right item, ranked first
    const top = receipt.validation.issues[0];
    assertEqual(top.type, "missing_paid_modifier");
    assertEqual(top.itemId, "pt1");
    assertEqual(top.confidenceLevel, "high");

    // 5 & 6. correction applied, receipt recalculated and now balances
    const corrected = applyProposal(receipt, top.proposal!);
    assertEqual(subtotalOf(corrected), "374.25");
    assertEqual(moneyToDecimalString(corrected.calculatedTotal), "499.03");
    assertEqual(corrected.validation.status, "reconciled");
  });

  it("does not report success when items are short", () => {
    // The historical bug: a 366.00 item list against a 374.25 printed subtotal
    // used to render a green "totals match" banner.
    const receipt = build({
      currency: "CAD",
      items: [{ name: "Everything", quantity: 1, unitPrice: 366.0 }],
      charges,
      printedSubtotal: printed.subtotal,
      printedTotal: printed.total,
    });

    assertEqual(receipt.validation.status, "needs_review");
    assertEqual(moneyToDecimalString(receipt.validation.subtotalDelta!), "8.25");
    assert(receipt.validation.issues.length > 0, "expected at least one issue");
  });
});

// ─── Reconciler directly ──────────────────────────────────────────────────────

describe("reconciler: status semantics", () => {
  it("uses zero tolerance so real discrepancies are never absorbed", () => {
    const receipt = normalizeRawReceipt({
      currency: "EUR",
      items: [{ name: "Item", quantity: 1, unitPrice: 10.0 }],
      printedSubtotal: 10.01,
    });
    const result = reconcileReceipt(receipt);
    assertEqual(result.status, "needs_review");
    assertEqual(result.subtotalDelta?.minor, 1);
  });

  it("reports an empty diagnosis for a reconciled receipt", () => {
    const receipt = normalizeRawReceipt({
      currency: "EUR",
      items: [{ name: "Item", quantity: 1, unitPrice: 10.0 }],
      printedSubtotal: 10.0,
    });
    const diagnosis = diagnoseReceipt(receipt);
    assertEqual(diagnosis.issues.length, 0);
    assertEqual(diagnosis.inconclusive, false);
  });
});
