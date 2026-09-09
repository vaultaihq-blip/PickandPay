import { describe, it, assert, assertEqual } from "./harness";
import type { LedgerEntry } from "../ledger";
import type { StructureBlock, Assignment } from "../schema";
import {
  validateAssignments,
  findSuspiciousEvidence,
  findReconciliationSuspects,
  buildFinalPayload,
  OCR_CONFIDENCE_THRESHOLD,
} from "../validate";

function entry(
  overrides: Partial<LedgerEntry> & { amountId: string; value: number; lineIndex: number }
): LedgerEntry {
  return {
    wordId: `W_${overrides.amountId}`,
    rawText: String(overrides.value),
    ocrConfidence: 0.95,
    boundingBox: { vertices: [] },
    source: "ocr",
    ...overrides,
  };
}

describe("validate: ownership", () => {
  it("accepts an amountId that is genuinely within the claiming block's eligible range", () => {
    const ledger: LedgerEntry[] = [entry({ amountId: "A1", value: 23.75, lineIndex: 5 })];
    const blocks: StructureBlock[] = [
      { blockId: "B1", kind: "item", lineIndices: [5], parentBlockId: null, name: "Khao Soi", amountId: "A1", quantity: 1, priceKind: "unit" },
    ];
    const assignments: Assignment[] = [{ blockId: "B1", amountId: "A1", quantity: 1, priceKind: "unit" }];
    const [v] = validateAssignments(blocks, assignments, ledger);
    assertEqual(v.existsInLedger, true);
    assertEqual(v.ownershipValid, true);
  });

  it("rejects a schema-valid amountId that belongs to a distant, unrelated block (Test B)", () => {
    const ledger: LedgerEntry[] = [
      entry({ amountId: "A1", value: 23.75, lineIndex: 5 }),
      entry({ amountId: "A2", value: 57.42, lineIndex: 40 }), // e.g. tax, far away
    ];
    const blocks: StructureBlock[] = [
      { blockId: "B1", kind: "item", lineIndices: [5], parentBlockId: null, name: "Khao Soi", amountId: "A2", quantity: 1, priceKind: "unit" },
    ];
    // Semantic step picked a real, ledger-valid ID — just the wrong one.
    const assignments: Assignment[] = [{ blockId: "B1", amountId: "A2", quantity: 1, priceKind: "unit" }];
    const [v] = validateAssignments(blocks, assignments, ledger);
    assertEqual(v.existsInLedger, true, "A2 is a real ledger entry");
    assertEqual(v.ownershipValid, false, "but it does not belong to this item's neighbourhood");
  });

  it("rejects an amountId that does not exist in the ledger at all", () => {
    const ledger: LedgerEntry[] = [entry({ amountId: "A1", value: 23.75, lineIndex: 5 })];
    const blocks: StructureBlock[] = [
      { blockId: "B1", kind: "item", lineIndices: [5], parentBlockId: null, name: "Khao Soi", amountId: "A999", quantity: 1, priceKind: "unit" },
    ];
    const assignments: Assignment[] = [{ blockId: "B1", amountId: "A999", quantity: 1, priceKind: "unit" }];
    const [v] = validateAssignments(blocks, assignments, ledger);
    assertEqual(v.existsInLedger, false);
  });
});

describe("validate: suspicious evidence escalation", () => {
  it("flags an ownership failure for verification", () => {
    const ledger: LedgerEntry[] = [entry({ amountId: "A1", value: 23.75, lineIndex: 5 }), entry({ amountId: "A2", value: 57.42, lineIndex: 40 })];
    const blocks: StructureBlock[] = [
      { blockId: "B1", kind: "item", lineIndices: [5], parentBlockId: null, name: "X", amountId: "A2", quantity: 1, priceKind: "unit" },
    ];
    const assignments: Assignment[] = [{ blockId: "B1", amountId: "A2", quantity: 1, priceKind: "unit" }];
    const validations = validateAssignments(blocks, assignments, ledger);
    const suspicious = findSuspiciousEvidence(blocks, validations);
    assert(suspicious.some((s) => s.reason === "ownership_invalid"), "expected an ownership_invalid escalation");
  });

  it("flags a load-bearing value whose OCR confidence is below threshold", () => {
    const ledger: LedgerEntry[] = [entry({ amountId: "A1", value: 16.75, lineIndex: 5, ocrConfidence: 0.4 })];
    const blocks: StructureBlock[] = [
      { blockId: "B1", kind: "item", lineIndices: [5], parentBlockId: null, name: "X", amountId: "A1", quantity: 1, priceKind: "unit" },
    ];
    const assignments: Assignment[] = [{ blockId: "B1", amountId: "A1", quantity: 1, priceKind: "unit" }];
    const validations = validateAssignments(blocks, assignments, ledger);
    const suspicious = findSuspiciousEvidence(blocks, validations);
    assert(
      suspicious.some((s) => s.reason === "low_confidence" && s.amountId === "A1"),
      "a load-bearing value below the OCR confidence threshold must be escalated, never accepted outright"
    );
  });

  it("does NOT escalate a high-confidence, ownership-valid assignment", () => {
    const ledger: LedgerEntry[] = [entry({ amountId: "A1", value: 23.75, lineIndex: 5, ocrConfidence: 0.98 })];
    const blocks: StructureBlock[] = [
      { blockId: "B1", kind: "item", lineIndices: [5], parentBlockId: null, name: "X", amountId: "A1", quantity: 1, priceKind: "unit" },
    ];
    const assignments: Assignment[] = [{ blockId: "B1", amountId: "A1", quantity: 1, priceKind: "unit" }];
    const validations = validateAssignments(blocks, assignments, ledger);
    const suspicious = findSuspiciousEvidence(blocks, validations);
    assertEqual(suspicious.length, 0);
  });

  it("does not escalate a low-confidence value on a non-load-bearing (unclassified) block", () => {
    const ledger: LedgerEntry[] = [entry({ amountId: "A1", value: 5, lineIndex: 2, ocrConfidence: 0.3 })];
    const blocks: StructureBlock[] = [
      { blockId: "B1", kind: "unclassified", lineIndices: [2], parentBlockId: null, name: null, amountId: "A1", quantity: null, priceKind: null },
    ];
    const assignments: Assignment[] = [{ blockId: "B1", amountId: "A1", quantity: null, priceKind: null }];
    const validations = validateAssignments(blocks, assignments, ledger);
    const suspicious = findSuspiciousEvidence(blocks, validations);
    assertEqual(suspicious.length, 0, "an unclassified block's low-confidence value is not worth a verification call");
  });

  it("threshold boundary: a value exactly at OCR_CONFIDENCE_THRESHOLD is trusted, just below it is not", () => {
    const atThreshold = entry({ amountId: "A1", value: 10, lineIndex: 1, ocrConfidence: OCR_CONFIDENCE_THRESHOLD });
    const belowThreshold = entry({ amountId: "A2", value: 10, lineIndex: 2, ocrConfidence: OCR_CONFIDENCE_THRESHOLD - 0.01 });
    const blocks: StructureBlock[] = [
      { blockId: "B1", kind: "item", lineIndices: [1], parentBlockId: null, name: "X", amountId: "A1", quantity: 1, priceKind: "unit" },
      { blockId: "B2", kind: "item", lineIndices: [2], parentBlockId: null, name: "Y", amountId: "A2", quantity: 1, priceKind: "unit" },
    ];
    const assignments: Assignment[] = [
      { blockId: "B1", amountId: "A1", quantity: 1, priceKind: "unit" },
      { blockId: "B2", amountId: "A2", quantity: 1, priceKind: "unit" },
    ];
    const validations = validateAssignments(blocks, assignments, [atThreshold, belowThreshold]);
    const suspicious = findSuspiciousEvidence(blocks, validations);
    assertEqual(suspicious.length, 1);
    assertEqual(suspicious[0].amountId, "A2");
  });
});

describe("validate: reconciliation-triggered verification", () => {
  it("flags every load-bearing assigned block, even high-confidence ones, when arithmetic does not reconcile", () => {
    const ledger: LedgerEntry[] = [
      entry({ amountId: "A1", value: 23.75, lineIndex: 4, ocrConfidence: 0.98 }),
      entry({ amountId: "A2", value: 5.0, lineIndex: 9, ocrConfidence: 0.98 }),
    ];
    const blocks: StructureBlock[] = [
      { blockId: "I1", kind: "item", lineIndices: [4], parentBlockId: null, name: "X", amountId: "A1", quantity: 1, priceKind: "unit" },
      { blockId: "I2", kind: "item", lineIndices: [9], parentBlockId: null, name: "Y", amountId: "A2", quantity: 1, priceKind: "unit" },
    ];
    const assignments: Assignment[] = [
      { blockId: "I1", amountId: "A1", quantity: 1, priceKind: "unit" },
      { blockId: "I2", amountId: "A2", quantity: 1, priceKind: "unit" },
    ];
    const validations = validateAssignments(blocks, assignments, ledger);
    const suspects = findReconciliationSuspects(blocks, validations, new Set());
    assertEqual(
      suspects.length,
      2,
      "high OCR confidence is not proof — both values feeding failing arithmetic are candidates"
    );
    assert(suspects.every((s) => s.reason === "reconciliation_failed"));
  });

  it("excludes an amountId already checked earlier this request, to avoid a redundant re-read", () => {
    const ledger: LedgerEntry[] = [entry({ amountId: "A1", value: 23.75, lineIndex: 4, ocrConfidence: 0.98 })];
    const blocks: StructureBlock[] = [
      { blockId: "I1", kind: "item", lineIndices: [4], parentBlockId: null, name: "X", amountId: "A1", quantity: 1, priceKind: "unit" },
    ];
    const assignments: Assignment[] = [{ blockId: "I1", amountId: "A1", quantity: 1, priceKind: "unit" }];
    const validations = validateAssignments(blocks, assignments, ledger);
    const suspects = findReconciliationSuspects(blocks, validations, new Set(["A1"]));
    assertEqual(suspects.length, 0);
  });

  it("does not flag a non-load-bearing (unclassified) block", () => {
    const ledger: LedgerEntry[] = [entry({ amountId: "A1", value: 3, lineIndex: 2, ocrConfidence: 0.98 })];
    const blocks: StructureBlock[] = [
      { blockId: "B1", kind: "unclassified", lineIndices: [2], parentBlockId: null, name: null, amountId: "A1", quantity: null, priceKind: null },
    ];
    const assignments: Assignment[] = [{ blockId: "B1", amountId: "A1", quantity: null, priceKind: null }];
    const validations = validateAssignments(blocks, assignments, ledger);
    const suspects = findReconciliationSuspects(blocks, validations, new Set());
    assertEqual(suspects.length, 0);
  });

  it("does not flag a block with no assigned amount (nothing to re-read)", () => {
    const ledger: LedgerEntry[] = [];
    const blocks: StructureBlock[] = [
      { blockId: "I1", kind: "item", lineIndices: [4], parentBlockId: null, name: "X", amountId: null, quantity: null, priceKind: null },
    ];
    const assignments: Assignment[] = [{ blockId: "I1", amountId: null, quantity: null, priceKind: null }];
    const validations = validateAssignments(blocks, assignments, ledger);
    const suspects = findReconciliationSuspects(blocks, validations, new Set());
    assertEqual(suspects.length, 0);
  });
});

describe("validate: buildFinalPayload assembly", () => {
  it("assembles an item with a paid modifier and a free modifier", () => {
    const ledger: LedgerEntry[] = [
      entry({ amountId: "A1", value: 23.75, lineIndex: 4 }),
      entry({ amountId: "A2", value: 2.0, lineIndex: 5 }),
    ];
    const blocks: StructureBlock[] = [
      { blockId: "I1", kind: "item", lineIndices: [4], parentBlockId: null, name: "Chef Nuit Pad Thai", amountId: "A1", quantity: 1, priceKind: "unit" },
      { blockId: "M1", kind: "modifier", lineIndices: [5], parentBlockId: "I1", name: "PT Shrimp", amountId: "A2", quantity: null, priceKind: null },
      { blockId: "M2", kind: "modifier", lineIndices: [6], parentBlockId: "I1", name: "No Spice", amountId: null, quantity: null, priceKind: null },
    ];
    const assignments: Assignment[] = [
      { blockId: "I1", amountId: "A1", quantity: 1, priceKind: "unit" },
      { blockId: "M1", amountId: "A2", quantity: null, priceKind: null },
      { blockId: "M2", amountId: null, quantity: null, priceKind: null },
    ];
    const validations = validateAssignments(blocks, assignments, ledger);
    const lines = ["", "", "", "", "1 Chef Nuit Pad Thai  23.75", "  PT Shrimp  2.00", "  No Spice"];
    const { payload } = buildFinalPayload(null, "CAD", lines, blocks, validations, ledger);
    assertEqual(payload.items?.length, 1);
    const item = payload.items![0];
    assertEqual(item.unitPrice, 23.75);
    assertEqual(item.modifiers?.length, 2);
    assertEqual(item.modifiers![0].kind, "paid");
    assertEqual(item.modifiers![0].price, 2.0);
    assertEqual(item.modifiers![1].kind, "free");
    assertEqual(item.modifiers![1].price, null);
  });

  it("classifies summary blocks into printed fields and charges (FIX 10: subtotal/total identified by arithmetic closure, not name)", () => {
    // Real Toronto figures: one item summing to the subtotal, so
    // item-sum(374.25) + service(67.36) + tax(57.42) genuinely closes
    // against 499.03 — the identity FIX 10's closure test relies on.
    const ledger: LedgerEntry[] = [
      entry({ amountId: "I1", value: 374.25, lineIndex: 10 }),
      entry({ amountId: "S1", value: 374.25, lineIndex: 30 }),
      entry({ amountId: "S2", value: 67.36, lineIndex: 31 }),
      entry({ amountId: "S3", value: 57.42, lineIndex: 32 }),
      entry({ amountId: "S4", value: 499.03, lineIndex: 33 }),
    ];
    const blocks: StructureBlock[] = [
      { blockId: "ITEM", kind: "item", lineIndices: [10], parentBlockId: null, name: "Everything", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "SUB", kind: "summary", lineIndices: [30], parentBlockId: null, name: "Subtotal", amountId: "S1", quantity: null, priceKind: null },
      { blockId: "SVC", kind: "summary", lineIndices: [31], parentBlockId: null, name: "Service (18%)", amountId: "S2", quantity: null, priceKind: null },
      { blockId: "TAX", kind: "summary", lineIndices: [32], parentBlockId: null, name: "Tax", amountId: "S3", quantity: null, priceKind: null },
      { blockId: "TOT", kind: "summary", lineIndices: [33], parentBlockId: null, name: "Total", amountId: "S4", quantity: null, priceKind: null },
    ];
    const assignments: Assignment[] = [
      { blockId: "ITEM", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "SUB", amountId: "S1", quantity: null, priceKind: null },
      { blockId: "SVC", amountId: "S2", quantity: null, priceKind: null },
      { blockId: "TAX", amountId: "S3", quantity: null, priceKind: null },
      { blockId: "TOT", amountId: "S4", quantity: null, priceKind: null },
    ];
    const validations = validateAssignments(blocks, assignments, ledger);
    const { payload } = buildFinalPayload(null, "CAD", [], blocks, validations, ledger);
    assertEqual(payload.printedSubtotal, 374.25);
    assertEqual(payload.printedServiceCharge, 67.36);
    assertEqual(payload.printedTax, 57.42);
    assertEqual(payload.printedTotal, 499.03);
    assertEqual(payload.charges?.length, 2, "service and tax become charges; subtotal/total do not");
  });
});

describe("validate: FIX 10 — total/subtotal identified by arithmetic closure, not name", () => {
  it("S — a summary block with name:null and the correct value is identified as the total by arithmetic closure", () => {
    const ledger: LedgerEntry[] = [
      entry({ amountId: "I1", value: 100, lineIndex: 1 }),
      entry({ amountId: "TAX1", value: 10, lineIndex: 5 }),
      entry({ amountId: "T1", value: 110, lineIndex: 6 }),
    ];
    const blocks: StructureBlock[] = [
      { blockId: "ITEM", kind: "item", lineIndices: [1], parentBlockId: null, name: "Widget", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "TAX", kind: "summary", lineIndices: [5], parentBlockId: null, name: "Tax", amountId: "TAX1", quantity: null, priceKind: null },
      { blockId: "TOT", kind: "summary", lineIndices: [6], parentBlockId: null, name: null, amountId: "T1", quantity: null, priceKind: null },
    ];
    const assignments: Assignment[] = [
      { blockId: "ITEM", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "TAX", amountId: "TAX1", quantity: null, priceKind: null },
      { blockId: "TOT", amountId: "T1", quantity: null, priceKind: null },
    ];
    const validations = validateAssignments(blocks, assignments, ledger);
    const { payload } = buildFinalPayload(null, "CAD", [], blocks, validations, ledger);
    assertEqual(payload.printedTotal, 110, "the unnamed block must still be identified as the total via closure");
    assertEqual(payload.printedTax, 10);
  });

  it("T — multiple candidates match /total/ by name; only the one that closes is chosen (Mad God: 363.55 vs 239.35)", () => {
    const ledger: LedgerEntry[] = [
      entry({ amountId: "I1", value: 363.55, lineIndex: 1 }),
      entry({ amountId: "T1", value: 239.35, lineIndex: 10 }),
      entry({ amountId: "T2", value: 363.55, lineIndex: 20 }),
    ];
    const blocks: StructureBlock[] = [
      { blockId: "ITEM", kind: "item", lineIndices: [1], parentBlockId: null, name: "Everything", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "TOT1", kind: "summary", lineIndices: [10], parentBlockId: null, name: "Total", amountId: "T1", quantity: null, priceKind: null },
      { blockId: "TOT2", kind: "summary", lineIndices: [20], parentBlockId: null, name: "Total liq.", amountId: "T2", quantity: null, priceKind: null },
    ];
    const assignments: Assignment[] = [
      { blockId: "ITEM", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "TOT1", amountId: "T1", quantity: null, priceKind: null },
      { blockId: "TOT2", amountId: "T2", quantity: null, priceKind: null },
    ];
    const validations = validateAssignments(blocks, assignments, ledger);
    const { payload } = buildFinalPayload(null, "CAD", [], blocks, validations, ledger);
    assertEqual(payload.printedTotal, 363.55, "must pick the candidate that actually closes, not the last (or first) name match");
    const stillSurfaced = payload.unresolvedLines?.some((u) => u.amount === 239.35);
    assert(stillSurfaced === true, "the non-closing 'Total'-named candidate must still be surfaced, not silently dropped");
  });

  it("U — two candidates close with the same value → resolved without ambiguity (Augustiner: Total and Bar both 96.50)", () => {
    const ledger: LedgerEntry[] = [
      entry({ amountId: "I1", value: 96.5, lineIndex: 1 }),
      entry({ amountId: "T1", value: 96.5, lineIndex: 10 }),
      entry({ amountId: "T2", value: 96.5, lineIndex: 20 }),
    ];
    const blocks: StructureBlock[] = [
      { blockId: "ITEM", kind: "item", lineIndices: [1], parentBlockId: null, name: "Everything", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "TOT", kind: "summary", lineIndices: [10], parentBlockId: null, name: "Total", amountId: "T1", quantity: null, priceKind: null },
      { blockId: "BAR", kind: "summary", lineIndices: [20], parentBlockId: null, name: "Bar", amountId: "T2", quantity: null, priceKind: null },
    ];
    const assignments: Assignment[] = [
      { blockId: "ITEM", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "TOT", amountId: "T1", quantity: null, priceKind: null },
      { blockId: "BAR", amountId: "T2", quantity: null, priceKind: null },
    ];
    const validations = validateAssignments(blocks, assignments, ledger);
    const { payload } = buildFinalPayload(null, "CAD", [], blocks, validations, ledger);
    assertEqual(payload.printedTotal, 96.5, "both candidates agree on the value — must resolve cleanly");
  });

  it("V — two candidates both close (within rounding tolerance) but disagree on value → ambiguous, neither chosen silently", () => {
    const ledger: LedgerEntry[] = [
      entry({ amountId: "I1", value: 100, lineIndex: 1 }),
      entry({ amountId: "T1", value: 100, lineIndex: 10 }),
      entry({ amountId: "T2", value: 100.01, lineIndex: 20 }),
    ];
    const blocks: StructureBlock[] = [
      { blockId: "ITEM", kind: "item", lineIndices: [1], parentBlockId: null, name: "Everything", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "TOT1", kind: "summary", lineIndices: [10], parentBlockId: null, name: "Total", amountId: "T1", quantity: null, priceKind: null },
      { blockId: "TOT2", kind: "summary", lineIndices: [20], parentBlockId: null, name: "Total", amountId: "T2", quantity: null, priceKind: null },
    ];
    const assignments: Assignment[] = [
      { blockId: "ITEM", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "TOT1", amountId: "T1", quantity: null, priceKind: null },
      { blockId: "TOT2", amountId: "T2", quantity: null, priceKind: null },
    ];
    const validations = validateAssignments(blocks, assignments, ledger);
    const { payload } = buildFinalPayload(null, "CAD", [], blocks, validations, ledger);
    assertEqual(payload.printedTotal, null, "must not silently pick one of two disagreeing, both-plausible candidates");
  });

  it("W — no candidate closes (item structure is wrong) → printedTotal stays null, nothing invented", () => {
    const ledger: LedgerEntry[] = [
      entry({ amountId: "I1", value: 50, lineIndex: 1 }), // wrong/incomplete item sum
      entry({ amountId: "T1", value: 110, lineIndex: 10 }), // real total, doesn't match item sum
    ];
    const blocks: StructureBlock[] = [
      { blockId: "ITEM", kind: "item", lineIndices: [1], parentBlockId: null, name: "Widget", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "TOT", kind: "summary", lineIndices: [10], parentBlockId: null, name: "Total", amountId: "T1", quantity: null, priceKind: null },
    ];
    const assignments: Assignment[] = [
      { blockId: "ITEM", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "TOT", amountId: "T1", quantity: null, priceKind: null },
    ];
    const validations = validateAssignments(blocks, assignments, ledger);
    const { payload } = buildFinalPayload(null, "CAD", [], blocks, validations, ledger);
    assertEqual(payload.printedTotal, null, "must not invent a total when nothing closes");
    const surfaced = payload.unresolvedLines?.some((u) => u.amount === 110);
    assert(surfaced === true, "the non-closing candidate must still be surfaced, not silently dropped");
  });

  it("X — no charges: subtotal and total coincide, both roles assigned without conflict", () => {
    const ledger: LedgerEntry[] = [
      entry({ amountId: "I1", value: 25, lineIndex: 1 }),
      entry({ amountId: "T1", value: 25, lineIndex: 10 }),
    ];
    const blocks: StructureBlock[] = [
      { blockId: "ITEM", kind: "item", lineIndices: [1], parentBlockId: null, name: "Widget", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "TOT", kind: "summary", lineIndices: [10], parentBlockId: null, name: "Total", amountId: "T1", quantity: null, priceKind: null },
    ];
    const assignments: Assignment[] = [
      { blockId: "ITEM", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "TOT", amountId: "T1", quantity: null, priceKind: null },
    ];
    const validations = validateAssignments(blocks, assignments, ledger);
    const { payload } = buildFinalPayload(null, "CAD", [], blocks, validations, ledger);
    assertEqual(payload.printedTotal, 25);
    assertEqual(payload.printedSubtotal, 25, "when there are no charges, the same value legitimately serves both roles");
  });
});

describe("validate: buildFinalPayload assembly — item shape", () => {
  it("priceKind 'unit' with quantity > 1: unitPrice is populated, quantity multiplies downstream", () => {
    const ledger: LedgerEntry[] = [entry({ amountId: "A1", value: 12, lineIndex: 4 })];
    const blocks: StructureBlock[] = [
      { blockId: "I1", kind: "item", lineIndices: [4], parentBlockId: null, name: "Beer", amountId: "A1", quantity: 4, priceKind: "unit" },
    ];
    const assignments: Assignment[] = [{ blockId: "I1", amountId: "A1", quantity: 4, priceKind: "unit" }];
    const validations = validateAssignments(blocks, assignments, ledger);
    const { payload } = buildFinalPayload(null, "CAD", [], blocks, validations, ledger);
    const item = payload.items![0];
    assertEqual(item.quantity, 4);
    assertEqual(item.unitPrice, 12);
    assertEqual(item.baseLineTotal, null);
  });

  it("priceKind 'lineTotal': baseLineTotal is populated and unitPrice stays null, preventing re-multiplication by quantity", () => {
    const ledger: LedgerEntry[] = [entry({ amountId: "A1", value: 48, lineIndex: 4 })];
    const blocks: StructureBlock[] = [
      {
        blockId: "I1",
        kind: "item",
        lineIndices: [4],
        parentBlockId: null,
        name: "BTL Campo Viejo Tempranillo",
        amountId: "A1",
        quantity: 1,
        priceKind: "lineTotal",
      },
    ];
    const assignments: Assignment[] = [{ blockId: "I1", amountId: "A1", quantity: 1, priceKind: "lineTotal" }];
    const validations = validateAssignments(blocks, assignments, ledger);
    const { payload } = buildFinalPayload(null, "CAD", [], blocks, validations, ledger);
    const item = payload.items![0];
    assertEqual(item.baseLineTotal, 48, "the printed value is already the line total");
    assertEqual(item.unitPrice, null, "must stay null so reconcile() never multiplies this value by quantity");
  });

  it("'1 BTL .../ 4 Glasses' case: the item's quantity is 1 regardless of a modifier block's own text", () => {
    const ledger: LedgerEntry[] = [entry({ amountId: "A1", value: 48, lineIndex: 4 })];
    const blocks: StructureBlock[] = [
      {
        blockId: "I1",
        kind: "item",
        lineIndices: [4],
        parentBlockId: null,
        name: "BTL Campo Viejo Tempranillo",
        amountId: "A1",
        quantity: 1,
        priceKind: "lineTotal",
      },
      // "4 Glasses" is a free descriptive modifier — no amountId, no bearing
      // on the item's own quantity field.
      { blockId: "M1", kind: "modifier", lineIndices: [5], parentBlockId: "I1", name: "4 Glasses", amountId: null, quantity: null, priceKind: null },
    ];
    const assignments: Assignment[] = [
      { blockId: "I1", amountId: "A1", quantity: 1, priceKind: "lineTotal" },
      { blockId: "M1", amountId: null, quantity: null, priceKind: null },
    ];
    const validations = validateAssignments(blocks, assignments, ledger);
    const { payload } = buildFinalPayload(null, "CAD", [], blocks, validations, ledger);
    const item = payload.items![0];
    assertEqual(item.quantity, 1, "quantity must never be pulled from a modifier block's text");
    assertEqual(item.baseLineTotal, 48);
  });

  it("defaults quantity to 1 when the block's quantity is null or invalid", () => {
    const ledger: LedgerEntry[] = [entry({ amountId: "A1", value: 10, lineIndex: 4 })];
    const blocks: StructureBlock[] = [
      { blockId: "I1", kind: "item", lineIndices: [4], parentBlockId: null, name: "X", amountId: "A1", quantity: null, priceKind: "unit" },
    ];
    const assignments: Assignment[] = [{ blockId: "I1", amountId: "A1", quantity: null, priceKind: "unit" }];
    const validations = validateAssignments(blocks, assignments, ledger);
    const { payload } = buildFinalPayload(null, "CAD", [], blocks, validations, ledger);
    assertEqual(payload.items![0].quantity, 1);
  });

  it("surfaces an orphan ledger entry (never claimed) as an unresolved line, never drops it", () => {
    const ledger: LedgerEntry[] = [
      entry({ amountId: "A1", value: 23.75, lineIndex: 4 }),
      entry({ amountId: "A2", value: 3.5, lineIndex: 9 }), // never referenced by any block
    ];
    const blocks: StructureBlock[] = [
      { blockId: "I1", kind: "item", lineIndices: [4], parentBlockId: null, name: "X", amountId: "A1", quantity: 1, priceKind: "unit" },
    ];
    const assignments: Assignment[] = [{ blockId: "I1", amountId: "A1", quantity: 1, priceKind: "unit" }];
    const validations = validateAssignments(blocks, assignments, ledger);
    const { payload, orphanCount } = buildFinalPayload(null, "CAD", [], blocks, validations, ledger);
    assertEqual(orphanCount, 1);
    assert(
      payload.unresolvedLines!.some((l) => l.amount === 3.5),
      "expected the unclaimed 3.50 to surface in unresolvedLines"
    );
  });
});
