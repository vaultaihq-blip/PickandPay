import { describe, it, assert, assertEqual } from "./harness";
import type { LedgerEntry } from "../ledger";
import type { StructureBlock, Assignment } from "../schema";
import { reconcile } from "../reconcile";
import {
  computeItemsRegionEnd,
  classifyCoverage,
  findStructuralGaps,
  findDuplicateOwnership,
  determineValidity,
  classifySummaryCoverage,
  findSummaryDuplicateRoles,
  determineSummaryValidity,
  type SummaryRoleAssignment,
} from "../coverage";
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
    // .toFixed(2), not String(value): a real OCR-read price is always
    // printed with cents (matches the /[.,]\d{2}$/ decimal-shape check FIX
    // 15's summary coverage relies on) — String(45) would give "45", which
    // no real receipt prints and which every decimal-shape check in the
    // pipeline correctly treats as non-monetary noise.
    rawText: overrides.value.toFixed(2),
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

// ─── FIX 23 — deterministic priceKind: GPT's own signal is ignored, not ───
// merely outvoted, when an adjacent unit-price annotation proves a claimed
// value is already a line total. First investigated in FIX 13; blocked until
// FIX 21 removed the same-block ("territory") requirement the adjacency
// check needed.

describe("validate: FIX 23 — deterministic priceKind override", () => {
  it("CK — Ramires real values: all four quantity>1 items become lineTotal regardless of a forced priceKind:\"unit\"", () => {
    // Real values from fix22-corpus-ramires-run1.debug.json — the exact run
    // whose sibling (run2) flipped these four items' priceKind and produced
    // 90 instead of 76.20. Each block here is given priceKind:"unit" (the
    // wrong value that actually occurred), proving the rule ignores it.
    const cases: Array<{ name: string; claimId: string; claimValue: number; claimLine: number; annotationValue: number; annotationLine: number; quantity: number }> = [
      { name: "Cola Zero", claimId: "A22", claimValue: 4.0, claimLine: 46, annotationValue: 2.0, annotationLine: 47, quantity: 2 },
      { name: "Cerveja Copo 20", claimId: "A24", claimValue: 3.6, claimLine: 48, annotationValue: 1.8, annotationLine: 49, quantity: 2 },
      { name: "Pao", claimId: "A26", claimValue: 2.4, claimLine: 52, annotationValue: 0.8, annotationLine: 53, quantity: 3 },
      { name: "Manteiga", claimId: "A30", claimValue: 1.4, claimLine: 60, annotationValue: 0.7, annotationLine: 61, quantity: 2 },
    ];
    for (const tc of cases) {
      const ledger: LedgerEntry[] = [
        entry({ amountId: tc.claimId, value: tc.claimValue, lineIndex: tc.claimLine }),
        entry({ amountId: "ANNOT", value: tc.annotationValue, lineIndex: tc.annotationLine }),
      ];
      const blocks: StructureBlock[] = [
        { blockId: "I1", kind: "item", lineIndices: [tc.claimLine], parentBlockId: null, name: tc.name, amountId: tc.claimId, quantity: tc.quantity, priceKind: "unit" },
      ];
      const assignments: Assignment[] = [{ blockId: "I1", amountId: tc.claimId, quantity: tc.quantity, priceKind: "unit" }];
      const validations = validateAssignments(blocks, assignments, ledger);
      const { payload, priceKindOverrides } = buildFinalPayload(null, "EUR", [], blocks, validations, ledger);
      const item = payload.items![0];
      assertEqual(item.baseLineTotal, tc.claimValue, `${tc.name}: GPT's priceKind:"unit" must be ignored — the adjacent annotation proves this is a line total`);
      assertEqual(item.unitPrice, null, `${tc.name}: unitPrice must stay null so reconcile() never re-multiplies this by quantity`);
      assertEqual(priceKindOverrides.length, 1, `${tc.name}: exactly one override recorded`);
      assertEqual(priceKindOverrides[0].blockId, "I1");
    }
  });

  it("CL — quantity>1 with NO adjacent annotation: the rule never fires, GPT's priceKind is respected as-is", () => {
    const ledger: LedgerEntry[] = [entry({ amountId: "A1", value: 12, lineIndex: 4 })];
    const blocks: StructureBlock[] = [
      { blockId: "I1", kind: "item", lineIndices: [4], parentBlockId: null, name: "Beer", amountId: "A1", quantity: 4, priceKind: "unit" },
    ];
    const assignments: Assignment[] = [{ blockId: "I1", amountId: "A1", quantity: 4, priceKind: "unit" }];
    const validations = validateAssignments(blocks, assignments, ledger);
    const { payload, priceKindOverrides } = buildFinalPayload(null, "CAD", [], blocks, validations, ledger);
    const item = payload.items![0];
    assertEqual(item.unitPrice, 12, "no adjacent evidence exists — the rule must never invent a decision");
    assertEqual(item.baseLineTotal, null);
    assertEqual(priceKindOverrides.length, 0);
  });

  it("CM — adjacent annotation exists but the arithmetic does not close: fails closed, GPT's priceKind stands", () => {
    const ledger: LedgerEntry[] = [
      entry({ amountId: "A1", value: 12, lineIndex: 4 }),
      entry({ amountId: "A2", value: 5, lineIndex: 5 }), // 5 * 4 = 20 != 12 — does not reconstruct the claim
    ];
    const blocks: StructureBlock[] = [
      { blockId: "I1", kind: "item", lineIndices: [4], parentBlockId: null, name: "Beer", amountId: "A1", quantity: 4, priceKind: "unit" },
    ];
    const assignments: Assignment[] = [{ blockId: "I1", amountId: "A1", quantity: 4, priceKind: "unit" }];
    const validations = validateAssignments(blocks, assignments, ledger);
    const { payload, priceKindOverrides } = buildFinalPayload(null, "CAD", [], blocks, validations, ledger);
    const item = payload.items![0];
    assertEqual(item.unitPrice, 12, "the product doesn't close — the rule must refuse, not guess");
    assertEqual(item.baseLineTotal, null);
    assertEqual(priceKindOverrides.length, 0);
  });

  it("CN — quantity = 1: the rule never applies (unit and total coincide, nothing to decide)", () => {
    const ledger: LedgerEntry[] = [
      entry({ amountId: "A1", value: 12, lineIndex: 4 }),
      entry({ amountId: "A2", value: 12, lineIndex: 5 }), // same value adjacent — still quantity=1, rule must not engage
    ];
    const blocks: StructureBlock[] = [
      { blockId: "I1", kind: "item", lineIndices: [4], parentBlockId: null, name: "Beer", amountId: "A1", quantity: 1, priceKind: "unit" },
    ];
    const assignments: Assignment[] = [{ blockId: "I1", amountId: "A1", quantity: 1, priceKind: "unit" }];
    const validations = validateAssignments(blocks, assignments, ledger);
    const { payload, priceKindOverrides } = buildFinalPayload(null, "CAD", [], blocks, validations, ledger);
    const item = payload.items![0];
    assertEqual(item.unitPrice, 12, "quantity=1 — GPT's own priceKind is never second-guessed here");
    assertEqual(priceKindOverrides.length, 0);
  });

  it("CO — GPT already says lineTotal and the rule would agree: no conflict, nothing recorded as an override", () => {
    const ledger: LedgerEntry[] = [
      entry({ amountId: "A1", value: 12, lineIndex: 4 }),
      entry({ amountId: "A2", value: 3, lineIndex: 5 }), // 3 * 4 = 12 — the rule WOULD also conclude lineTotal
    ];
    const blocks: StructureBlock[] = [
      { blockId: "I1", kind: "item", lineIndices: [4], parentBlockId: null, name: "Beer", amountId: "A1", quantity: 4, priceKind: "lineTotal" },
    ];
    const assignments: Assignment[] = [{ blockId: "I1", amountId: "A1", quantity: 4, priceKind: "lineTotal" }];
    const validations = validateAssignments(blocks, assignments, ledger);
    const { payload, priceKindOverrides } = buildFinalPayload(null, "CAD", [], blocks, validations, ledger);
    const item = payload.items![0];
    assertEqual(item.baseLineTotal, 12);
    assertEqual(priceKindOverrides.length, 0, "GPT already agreed — this is a confirmation, not an override, and must not be counted as one");
  });

  it("CP — Pai-shaped negative control: an adjacent REAL charge that does not satisfy the multiplicative relationship must never force lineTotal on the item", () => {
    const ledger: LedgerEntry[] = [
      entry({ amountId: "A1", value: 24, lineIndex: 30 }), // 2 pizzas
      entry({ amountId: "A2", value: 2.5, lineIndex: 31 }), // real, uncounted "extra topping" charge — 2.5*2=5 != 24
    ];
    const blocks: StructureBlock[] = [
      { blockId: "I1", kind: "item", lineIndices: [30, 31], parentBlockId: null, name: "Pizza", amountId: "A1", quantity: 2, priceKind: "unit" },
    ];
    const assignments: Assignment[] = [{ blockId: "I1", amountId: "A1", quantity: 2, priceKind: "unit" }];
    const validations = validateAssignments(blocks, assignments, ledger);
    const { payload, priceKindOverrides } = buildFinalPayload(null, "CAD", [], blocks, validations, ledger);
    const item = payload.items![0];
    assertEqual(item.unitPrice, 24, "a real, unrelated adjacent charge must never masquerade as a unit-price annotation");
    assertEqual(item.baseLineTotal, null);
    assertEqual(priceKindOverrides.length, 0);
  });
});

// ─── FIX 15 — summary monetary coverage ─────────────────────────────────────
//
// Full-pipeline helper: runs buildFinalPayload, then the same summary
// coverage + reconciliation combination index.ts wires together, so these
// tests prove the INTEGRATION, not just the coverage.ts primitives in
// isolation. Mirrors index.ts's own sequence exactly.
function finalizeSummary(
  currency: string,
  blocks: StructureBlock[],
  validations: ReturnType<typeof validateAssignments>,
  ledger: LedgerEntry[]
) {
  const assembled = buildFinalPayload(null, currency, [], blocks, validations, ledger);
  const itemsRegionEnd = computeItemsRegionEnd(blocks);
  const summaryCoverage = classifySummaryCoverage(ledger, itemsRegionEnd, assembled.summaryRoleAssignments);
  const summaryDuplicates = findSummaryDuplicateRoles(assembled.summaryRoleAssignments);
  const summaryValidity = determineSummaryValidity(summaryCoverage, summaryDuplicates);
  const reconciliation = reconcile(assembled.payload);
  const finalReconciles = reconciliation.reconciles && summaryValidity.valid;
  return { assembled, summaryCoverage, summaryDuplicates, summaryValidity, reconciliation, finalReconciles };
}

describe("validate: FIX 15 — summary monetary coverage", () => {
  it("AK — Mademoiselle reproduction: the coincidence is refused because orphans remain → UNRESOLVED, not silently correct", () => {
    // A1 = the block's own claimed value (45); A2 (tax, 5.85) and A3 (real
    // total, 50.85) sit inside the SAME block's line span but were never
    // separately claimed by anything — exactly Mademoiselle's real bug.
    // FIX 15.1: since A2 and A3 are unclaimed decimal orphans in the summary
    // region, A1 is refused BOTH roles — the receipt reports UNRESOLVED, the
    // honest outcome, instead of silently reporting 45 as the total.
    const ledger: LedgerEntry[] = [
      entry({ amountId: "I1", value: 45, lineIndex: 1 }),
      entry({ amountId: "A1", value: 45, lineIndex: 5 }),
      entry({ amountId: "A2", value: 5.85, lineIndex: 6 }),
      entry({ amountId: "A3", value: 50.85, lineIndex: 7 }),
    ];
    const blocks: StructureBlock[] = [
      { blockId: "ITEM", kind: "item", lineIndices: [1], parentBlockId: null, name: "Belvedere", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "SUM", kind: "summary", lineIndices: [5, 6, 7], parentBlockId: null, name: "Total", amountId: "A1", quantity: null, priceKind: null },
    ];
    const assignments: Assignment[] = [
      { blockId: "ITEM", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "SUM", amountId: "A1", quantity: null, priceKind: null },
    ];
    const validations = validateAssignments(blocks, assignments, ledger);
    const { assembled, summaryValidity, reconciliation, finalReconciles } = finalizeSummary("CAD", blocks, validations, ledger);

    assertEqual(assembled.payload.printedTotal, 45, "printedTotal is unchanged from FIX 10's resolution — this fix never corrects a value, only refuses an unsafe coincidence");
    assertEqual(reconciliation.reconciles, true, "arithmetic (subtotal vs item-sum) was always fine — reconciliation alone is exactly the insufficient signal FIX 15 exists to catch");
    assertEqual(summaryValidity.summaryDuplicateRoleAttemptCount, 1, "A1 was pushed as both SUBTOTAL and GRAND_TOTAL — the refused coincidence, caught as a duplicate role claim");
    assertEqual(summaryValidity.valid, false, "orphans (5.85, 50.85) remain unclaimed — the coincidence cannot be trusted");
    assertEqual(finalReconciles, false, "honest UNRESOLVED — never reconciles=true on the wrong number");
  });

  it("AK-orphan — a single unclaimed decimal in the summary region is enough to refuse the coincidence", () => {
    // Only ONE orphan this time (no separate tax figure) — the rule is "any
    // unclaimed decimal", not "two or more".
    const ledger: LedgerEntry[] = [
      entry({ amountId: "I1", value: 45, lineIndex: 1 }),
      entry({ amountId: "A1", value: 45, lineIndex: 5 }),
      entry({ amountId: "A2", value: 50.85, lineIndex: 6 }),
    ];
    const blocks: StructureBlock[] = [
      { blockId: "ITEM", kind: "item", lineIndices: [1], parentBlockId: null, name: "Belvedere", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "SUM", kind: "summary", lineIndices: [5, 6], parentBlockId: null, name: "Total", amountId: "A1", quantity: null, priceKind: null },
    ];
    const assignments: Assignment[] = [
      { blockId: "ITEM", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "SUM", amountId: "A1", quantity: null, priceKind: null },
    ];
    const validations = validateAssignments(blocks, assignments, ledger);
    const { summaryValidity, finalReconciles } = finalizeSummary("CAD", blocks, validations, ledger);
    assertEqual(summaryValidity.summaryDuplicateRoleAttemptCount, 1);
    assertEqual(summaryValidity.valid, false);
    assertEqual(finalReconciles, false);
  });

  it("AK-guard — the old false-valid outcome (grandTotal=45) is structurally impossible", () => {
    const ledger: LedgerEntry[] = [
      entry({ amountId: "I1", value: 45, lineIndex: 1 }),
      entry({ amountId: "A1", value: 45, lineIndex: 5 }),
      entry({ amountId: "A2", value: 5.85, lineIndex: 6 }),
      entry({ amountId: "A3", value: 50.85, lineIndex: 7 }),
    ];
    const blocks: StructureBlock[] = [
      { blockId: "ITEM", kind: "item", lineIndices: [1], parentBlockId: null, name: "Belvedere", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "SUM", kind: "summary", lineIndices: [5, 6, 7], parentBlockId: null, name: "Total", amountId: "A1", quantity: null, priceKind: null },
    ];
    const assignments: Assignment[] = [
      { blockId: "ITEM", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "SUM", amountId: "A1", quantity: null, priceKind: null },
    ];
    const validations = validateAssignments(blocks, assignments, ledger);
    const { assembled, finalReconciles } = finalizeSummary("CAD", blocks, validations, ledger);
    const forbidden = assembled.payload.printedTotal === 45 && finalReconciles === true;
    assert(!forbidden, "FORBIDDEN OUTCOME: grandTotal=45 with reconciles=true must never happen");
  });

  it("AL — complete summary: subtotal, tax, and total each have their own distinct evidence → VALID", () => {
    const ledger: LedgerEntry[] = [
      entry({ amountId: "I1", value: 100, lineIndex: 1 }),
      entry({ amountId: "A1", value: 100, lineIndex: 5 }),
      entry({ amountId: "A2", value: 10, lineIndex: 6 }),
      entry({ amountId: "A3", value: 110, lineIndex: 7 }),
    ];
    const blocks: StructureBlock[] = [
      { blockId: "ITEM", kind: "item", lineIndices: [1], parentBlockId: null, name: "Widget", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "SUB", kind: "summary", lineIndices: [5], parentBlockId: null, name: "Subtotal", amountId: "A1", quantity: null, priceKind: null },
      { blockId: "TAX", kind: "summary", lineIndices: [6], parentBlockId: null, name: "Tax", amountId: "A2", quantity: null, priceKind: null },
      { blockId: "TOT", kind: "summary", lineIndices: [7], parentBlockId: null, name: "Total", amountId: "A3", quantity: null, priceKind: null },
    ];
    const assignments: Assignment[] = [
      { blockId: "ITEM", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "SUB", amountId: "A1", quantity: null, priceKind: null },
      { blockId: "TAX", amountId: "A2", quantity: null, priceKind: null },
      { blockId: "TOT", amountId: "A3", quantity: null, priceKind: null },
    ];
    const validations = validateAssignments(blocks, assignments, ledger);
    const { summaryValidity, finalReconciles } = finalizeSummary("CAD", blocks, validations, ledger);
    assertEqual(summaryValidity.summaryUnresolvedAmountCount, 0);
    assertEqual(summaryValidity.summaryDuplicateRoleAttemptCount, 0);
    assertEqual(summaryValidity.valid, true);
    assertEqual(finalReconciles, true);
  });

  it("AM — legitimate subtotal == total: no tax/service/fee/discount exists at all → VALID, sharing is not penalized", () => {
    const ledger: LedgerEntry[] = [
      entry({ amountId: "I1", value: 50, lineIndex: 1 }),
      entry({ amountId: "A1", value: 50, lineIndex: 5 }),
    ];
    const blocks: StructureBlock[] = [
      { blockId: "ITEM", kind: "item", lineIndices: [1], parentBlockId: null, name: "Coffee", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "TOT", kind: "summary", lineIndices: [5], parentBlockId: null, name: null, amountId: "A1", quantity: null, priceKind: null },
    ];
    const assignments: Assignment[] = [
      { blockId: "ITEM", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "TOT", amountId: "A1", quantity: null, priceKind: null },
    ];
    const validations = validateAssignments(blocks, assignments, ledger);
    const { summaryValidity, finalReconciles } = finalizeSummary("CAD", blocks, validations, ledger);
    assertEqual(summaryValidity.summaryDuplicateRoleAttemptCount, 0, "no OTHER summary evidence exists — sharing is structurally legitimate, never a blanket subtotal!==total rule");
    assertEqual(summaryValidity.valid, true);
    assertEqual(finalReconciles, true);
  });

  it("AN — FIX 17 Part 1: an unproven 'informational' tax breakdown is UNRESOLVED, not silently accepted, even with its own block", () => {
    // The item's own value is ALREADY tax-inclusive (110); a separate
    // tax-shaped block (A2) is disclosed but never additive, and never
    // named anything classifyKnownCharge recognizes. Before FIX 17 Part 1
    // this was treated as NON_CHARGE_INFORMATIONAL purely because it had
    // its own block and lost the closure — no positive evidence it was
    // informational, exactly the gap that let the Pai/Mademoiselle-shaped
    // FALSE_VALID counterexamples through when GPT segmented the extra
    // figures into their own blocks. The total still resolves correctly
    // (backed by its own observed evidence) — but overall validity now
    // correctly requires A2 to also be explained, which nothing here does.
    const ledger: LedgerEntry[] = [
      entry({ amountId: "I1", value: 110, lineIndex: 1 }),
      entry({ amountId: "A2", value: 10, lineIndex: 5 }),
      entry({ amountId: "A3", value: 110, lineIndex: 6 }),
    ];
    const blocks: StructureBlock[] = [
      { blockId: "ITEM", kind: "item", lineIndices: [1], parentBlockId: null, name: "Everything (tax incl.)", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "TAXINFO", kind: "summary", lineIndices: [5], parentBlockId: null, name: null, amountId: "A2", quantity: null, priceKind: null },
      { blockId: "TOT", kind: "summary", lineIndices: [6], parentBlockId: null, name: "Total", amountId: "A3", quantity: null, priceKind: null },
    ];
    const assignments: Assignment[] = [
      { blockId: "ITEM", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "TAXINFO", amountId: "A2", quantity: null, priceKind: null },
      { blockId: "TOT", amountId: "A3", quantity: null, priceKind: null },
    ];
    const validations = validateAssignments(blocks, assignments, ledger);
    const { summaryCoverage, summaryValidity, finalReconciles } = finalizeSummary("CAD", blocks, validations, ledger);
    const a2 = summaryCoverage.find((c) => c.amountId === "A2");
    assertEqual(a2?.role, "UNRESOLVED", "having its own block proves territory, never a financial role — no proof of 'informational' exists here");
    const a3 = summaryCoverage.find((c) => c.amountId === "A3");
    assertEqual(a3?.role, "GRAND_TOTAL", "the total itself still resolves correctly, backed by its own observed evidence");
    assertEqual(summaryValidity.valid, false, "an unexplained block-backed amount now blocks validity exactly like a ledger_ orphan would");
    assertEqual(finalReconciles, false);
  });

  it("AO — multiple taxes: a second tax with no evidence trail at all → INVALID even though a first tax is properly explained", () => {
    // An explicit SUBTOTAL block makes arithmetic genuinely close (isolating
    // what coverage catches that reconciliation alone would miss) —
    // subtotal(100) and total(105 = 100+5, using only the first tax) both
    // resolve cleanly; the second tax (A3) is the only unexplained evidence.
    const ledger: LedgerEntry[] = [
      entry({ amountId: "I1", value: 100, lineIndex: 1 }),
      entry({ amountId: "A1", value: 100, lineIndex: 4 }),
      entry({ amountId: "A2", value: 5, lineIndex: 5 }), // properly classified tax
      entry({ amountId: "A3", value: 3, lineIndex: 6 }), // a second tax, never referenced by any block
      entry({ amountId: "A4", value: 105, lineIndex: 7 }), // total closes using only the first tax
    ];
    const blocks: StructureBlock[] = [
      { blockId: "ITEM", kind: "item", lineIndices: [1], parentBlockId: null, name: "Widget", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "SUB", kind: "summary", lineIndices: [4], parentBlockId: null, name: "Subtotal", amountId: "A1", quantity: null, priceKind: null },
      { blockId: "TAX1", kind: "summary", lineIndices: [5], parentBlockId: null, name: "Tax", amountId: "A2", quantity: null, priceKind: null },
      { blockId: "TOT", kind: "summary", lineIndices: [7], parentBlockId: null, name: "Total", amountId: "A4", quantity: null, priceKind: null },
    ];
    const assignments: Assignment[] = [
      { blockId: "ITEM", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "SUB", amountId: "A1", quantity: null, priceKind: null },
      { blockId: "TAX1", amountId: "A2", quantity: null, priceKind: null },
      { blockId: "TOT", amountId: "A4", quantity: null, priceKind: null },
    ];
    const validations = validateAssignments(blocks, assignments, ledger);
    const { summaryValidity, reconciliation, finalReconciles } = finalizeSummary("CAD", blocks, validations, ledger);
    assertEqual(reconciliation.reconciles, true, "arithmetic closes using only the first tax — coverage must catch the second one anyway");
    assertEqual(summaryValidity.summaryUnresolvedAmountCount, 1, "the second, unreferenced tax amount must be unresolved");
    assertEqual(finalReconciles, false);
  });

  it("AP — service charge with no evidence trail at all → INVALID", () => {
    const ledger: LedgerEntry[] = [
      entry({ amountId: "I1", value: 100, lineIndex: 1 }),
      entry({ amountId: "A1", value: 100, lineIndex: 4 }),
      entry({ amountId: "A2", value: 10, lineIndex: 5 }), // a printed service amount, never referenced by any block
      entry({ amountId: "A3", value: 100, lineIndex: 6 }), // total closes against the item sum alone, ignoring it
    ];
    const blocks: StructureBlock[] = [
      { blockId: "ITEM", kind: "item", lineIndices: [1], parentBlockId: null, name: "Widget", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "SUB", kind: "summary", lineIndices: [4], parentBlockId: null, name: "Subtotal", amountId: "A1", quantity: null, priceKind: null },
      { blockId: "TOT", kind: "summary", lineIndices: [6], parentBlockId: null, name: "Total", amountId: "A3", quantity: null, priceKind: null },
    ];
    const assignments: Assignment[] = [
      { blockId: "ITEM", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "SUB", amountId: "A1", quantity: null, priceKind: null },
      { blockId: "TOT", amountId: "A3", quantity: null, priceKind: null },
    ];
    const validations = validateAssignments(blocks, assignments, ledger);
    const { summaryValidity, reconciliation, finalReconciles } = finalizeSummary("CAD", blocks, validations, ledger);
    assertEqual(reconciliation.reconciles, true);
    assertEqual(summaryValidity.summaryUnresolvedAmountCount, 1, "the unexplained service amount must be unresolved");
    assertEqual(finalReconciles, false);
  });

  it("AQ — discount with no evidence trail at all → INVALID, cannot silently disappear", () => {
    const ledger: LedgerEntry[] = [
      entry({ amountId: "I1", value: 90, lineIndex: 1 }), // already-discounted item price
      entry({ amountId: "A1", value: 90, lineIndex: 4 }),
      entry({ amountId: "A2", value: 10, lineIndex: 5 }), // the printed discount, never referenced by any block
      entry({ amountId: "A3", value: 90, lineIndex: 6 }),
    ];
    const blocks: StructureBlock[] = [
      { blockId: "ITEM", kind: "item", lineIndices: [1], parentBlockId: null, name: "Widget", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "SUB", kind: "summary", lineIndices: [4], parentBlockId: null, name: "Subtotal", amountId: "A1", quantity: null, priceKind: null },
      { blockId: "TOT", kind: "summary", lineIndices: [6], parentBlockId: null, name: "Total", amountId: "A3", quantity: null, priceKind: null },
    ];
    const assignments: Assignment[] = [
      { blockId: "ITEM", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "SUB", amountId: "A1", quantity: null, priceKind: null },
      { blockId: "TOT", amountId: "A3", quantity: null, priceKind: null },
    ];
    const validations = validateAssignments(blocks, assignments, ledger);
    const { summaryValidity, reconciliation, finalReconciles } = finalizeSummary("CAD", blocks, validations, ledger);
    assertEqual(reconciliation.reconciles, true);
    assertEqual(summaryValidity.summaryUnresolvedAmountCount, 1);
    assertEqual(finalReconciles, false);
  });

  it("AR — rounding adjustment with no evidence trail at all → INVALID", () => {
    const ledger: LedgerEntry[] = [
      entry({ amountId: "I1", value: 100, lineIndex: 1 }),
      entry({ amountId: "A1", value: 100, lineIndex: 4 }),
      entry({ amountId: "A2", value: 0.48, lineIndex: 5 }), // a printed rounding adjustment, never referenced
      entry({ amountId: "A3", value: 100, lineIndex: 6 }),
    ];
    const blocks: StructureBlock[] = [
      { blockId: "ITEM", kind: "item", lineIndices: [1], parentBlockId: null, name: "Widget", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "SUB", kind: "summary", lineIndices: [4], parentBlockId: null, name: "Subtotal", amountId: "A1", quantity: null, priceKind: null },
      { blockId: "TOT", kind: "summary", lineIndices: [6], parentBlockId: null, name: "Total", amountId: "A3", quantity: null, priceKind: null },
    ];
    const assignments: Assignment[] = [
      { blockId: "ITEM", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "SUB", amountId: "A1", quantity: null, priceKind: null },
      { blockId: "TOT", amountId: "A3", quantity: null, priceKind: null },
    ];
    const validations = validateAssignments(blocks, assignments, ledger);
    const { summaryValidity, reconciliation, finalReconciles } = finalizeSummary("CAD", blocks, validations, ledger);
    assertEqual(reconciliation.reconciles, true);
    assertEqual(summaryValidity.summaryUnresolvedAmountCount, 1);
    assertEqual(finalReconciles, false);
  });

  it("AS — coincidental cancellation: the same amount backing two roles must invalidate even though naive arithmetic still closes", () => {
    // A2 is wrongly recorded as backing BOTH a TAX role and the GRAND_TOTAL
    // role — exactly the "same evidence used twice" class this fix exists
    // to catch, tested directly against the primitive so it's isolated from
    // any one specific resolveClosure path that might produce it.
    const ledger: LedgerEntry[] = [
      entry({ amountId: "A1", value: 100, lineIndex: 1 }),
      entry({ amountId: "A2", value: 10, lineIndex: 5 }),
    ];
    const assignments: SummaryRoleAssignment[] = [
      { amountId: "A1", role: "SUBTOTAL" },
      { amountId: "A2", role: "TAX" },
      { amountId: "A2", role: "GRAND_TOTAL" }, // reused — A2 never actually observed as a separate total
    ];
    const coverage = classifySummaryCoverage(ledger, 0, assignments);
    const duplicates = findSummaryDuplicateRoles(assignments);
    const validity = determineSummaryValidity(coverage, duplicates);
    assertEqual(duplicates.length, 1, "A2 backing two roles must be caught");
    assertEqual(validity.valid, false, "arithmetic correctness (100 + 10 looks consistent) must never override structurally wrong ownership");
  });

  it("AT — summary block territory is not sufficient explanation: three occurrences inside one block's span, only one gets a role", () => {
    const ledger: LedgerEntry[] = [
      entry({ amountId: "A1", value: 45, lineIndex: 5 }),
      entry({ amountId: "A2", value: 5.85, lineIndex: 6 }),
      entry({ amountId: "A3", value: 50.85, lineIndex: 7 }),
    ];
    // Only A1 (the block's own claimed value) gets a role — A2/A3 sit
    // inside the SAME block's line span [5,6,7] but were never separately
    // referenced by any assignment.
    const assignments: SummaryRoleAssignment[] = [{ amountId: "A1", role: "GRAND_TOTAL" }];
    const coverage = classifySummaryCoverage(ledger, 5, assignments);
    assertEqual(coverage.length, 3, "all three occurrences inside the block's territory must remain individually visible");
    assertEqual(coverage.filter((c) => c.role === "UNRESOLVED").length, 2, "A2 and A3 must prevent VALID — block territory alone never explains them");
    const validity = determineSummaryValidity(coverage, findSummaryDuplicateRoles(assignments));
    assertEqual(validity.valid, false);
  });

  // ── FIX 15.3A — GRAND_TOTAL required for validity ─────────────────────────

  it("BF — the Pai false-valid shape: a recognized charge plus an unrecognized one make the total-closure target unmatchable, GRAND_TOTAL never resolves → invalid, with no name/merchant/language involved", () => {
    // Generic reproduction, no merchant/receipt-specific words anywhere:
    // item sum 278.00 matches the subtotal candidate exactly. One charge
    // (kind "tax" — the pipeline's own pre-existing, generic charge
    // vocabulary, not something new here) is recognized and folds into the
    // total-closure target; the SURCHARGE block is deliberately unnamed
    // (null) and the real total block is ALSO deliberately unnamed — this
    // fix must never depend on either resolving by name.
    const ledger: LedgerEntry[] = [
      entry({ amountId: "I1", value: 278, lineIndex: 1 }),
      entry({ amountId: "SUB", value: 278, lineIndex: 5 }),
      entry({ amountId: "SUR", value: 55.6, lineIndex: 6 }), // unrecognized surcharge, unnamed
      entry({ amountId: "TAX", value: 43.37, lineIndex: 7 }),
      entry({ amountId: "TOT", value: 376.97, lineIndex: 8 }), // the real total, unnamed
    ];
    const blocks: StructureBlock[] = [
      { blockId: "ITEM", kind: "item", lineIndices: [1], parentBlockId: null, name: "Widget", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "SUB", kind: "summary", lineIndices: [5], parentBlockId: null, name: null, amountId: "SUB", quantity: null, priceKind: null },
      { blockId: "SUR", kind: "summary", lineIndices: [6], parentBlockId: null, name: null, amountId: "SUR", quantity: null, priceKind: null },
      { blockId: "TAX", kind: "summary", lineIndices: [7], parentBlockId: null, name: "Tax", amountId: "TAX", quantity: null, priceKind: null },
      { blockId: "TOT", kind: "summary", lineIndices: [8], parentBlockId: null, name: null, amountId: "TOT", quantity: null, priceKind: null },
    ];
    const assignments: Assignment[] = [
      { blockId: "ITEM", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "SUB", amountId: "SUB", quantity: null, priceKind: null },
      { blockId: "SUR", amountId: "SUR", quantity: null, priceKind: null },
      { blockId: "TAX", amountId: "TAX", quantity: null, priceKind: null },
      { blockId: "TOT", amountId: "TOT", quantity: null, priceKind: null },
    ];
    const validations = validateAssignments(blocks, assignments, ledger);
    const { assembled, summaryCoverage, summaryValidity, reconciliation, finalReconciles } = finalizeSummary("CAD", blocks, validations, ledger);
    assertEqual(reconciliation.reconciles, true, "items reconcile exactly against the subtotal — the insufficient signal on its own");
    assertEqual(assembled.payload.printedTotal, null, "total-closure genuinely found nothing to match — never silently defaults to the subtotal");
    assert(!summaryCoverage.some((c) => c.role === "GRAND_TOTAL"), "no candidate should have won GRAND_TOTAL in this shape");
    assertEqual(summaryValidity.valid, false, "FIX 15.3A: no GRAND_TOTAL anywhere must invalidate regardless of full coverage");
    assertEqual(finalReconciles, false, "the old false-valid outcome (reconciles=true, no real total) is now structurally impossible");
  });

  it("BG — non-empty summary coverage with no GRAND_TOTAL role anywhere is always invalid", () => {
    const coverage = [
      { amountId: "A1", lineIndex: 1, role: "SUBTOTAL" as const },
      { amountId: "A2", lineIndex: 2, role: "TAX" as const },
      { amountId: "A3", lineIndex: 3, role: "FEE" as const },
    ];
    const validity = determineSummaryValidity(coverage, []);
    assertEqual(validity.valid, false, "full coverage with zero UNRESOLVED and zero duplicates must still be invalid without a GRAND_TOTAL");
  });

  it("BH — empty summary coverage is invalid: no observed evidence of what was paid", () => {
    const validity = determineSummaryValidity([], []);
    assertEqual(validity.valid, false, "explicit product behavior — absence of any summary evidence is never treated as valid");
  });

  it("BI — a simple receipt: one observed value legitimately serves both SUBTOTAL and GRAND_TOTAL", () => {
    const ledger: LedgerEntry[] = [
      entry({ amountId: "I1", value: 20, lineIndex: 1 }),
      entry({ amountId: "A1", value: 20, lineIndex: 5 }),
    ];
    const blocks: StructureBlock[] = [
      { blockId: "ITEM", kind: "item", lineIndices: [1], parentBlockId: null, name: "Widget", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "TOT", kind: "summary", lineIndices: [5], parentBlockId: null, name: null, amountId: "A1", quantity: null, priceKind: null },
    ];
    const assignments: Assignment[] = [
      { blockId: "ITEM", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "TOT", amountId: "A1", quantity: null, priceKind: null },
    ];
    const validations = validateAssignments(blocks, assignments, ledger);
    const { summaryCoverage, summaryValidity, finalReconciles } = finalizeSummary("CAD", blocks, validations, ledger);
    assertEqual(summaryCoverage.find((c) => c.amountId === "A1")?.role, "GRAND_TOTAL");
    assertEqual(summaryValidity.valid, true);
    assertEqual(finalReconciles, true);
  });

  it("BJ — happy path: SUBTOTAL, TAX, and GRAND_TOTAL each independently resolved → valid", () => {
    const ledger: LedgerEntry[] = [
      entry({ amountId: "I1", value: 100, lineIndex: 1 }),
      entry({ amountId: "A1", value: 100, lineIndex: 5 }),
      entry({ amountId: "A2", value: 10, lineIndex: 6 }),
      entry({ amountId: "A3", value: 110, lineIndex: 7 }),
    ];
    const blocks: StructureBlock[] = [
      { blockId: "ITEM", kind: "item", lineIndices: [1], parentBlockId: null, name: "Widget", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "SUB", kind: "summary", lineIndices: [5], parentBlockId: null, name: null, amountId: "A1", quantity: null, priceKind: null },
      { blockId: "TAX", kind: "summary", lineIndices: [6], parentBlockId: null, name: "Tax", amountId: "A2", quantity: null, priceKind: null },
      { blockId: "TOT", kind: "summary", lineIndices: [7], parentBlockId: null, name: null, amountId: "A3", quantity: null, priceKind: null },
    ];
    const assignments: Assignment[] = [
      { blockId: "ITEM", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "SUB", amountId: "A1", quantity: null, priceKind: null },
      { blockId: "TAX", amountId: "A2", quantity: null, priceKind: null },
      { blockId: "TOT", amountId: "A3", quantity: null, priceKind: null },
    ];
    const validations = validateAssignments(blocks, assignments, ledger);
    const { summaryCoverage, summaryValidity, finalReconciles } = finalizeSummary("CAD", blocks, validations, ledger);
    assertEqual(summaryCoverage.find((c) => c.amountId === "A3")?.role, "GRAND_TOTAL");
    assertEqual(summaryValidity.valid, true);
    assertEqual(finalReconciles, true);
  });

  it("BK — existing invalid cases (AO shape) are still invalid for their ORIGINAL reason, not merely re-labeled by the new invariant", () => {
    const ledger: LedgerEntry[] = [
      entry({ amountId: "I1", value: 100, lineIndex: 1 }),
      entry({ amountId: "A1", value: 100, lineIndex: 4 }),
      entry({ amountId: "A2", value: 5, lineIndex: 5 }),
      entry({ amountId: "A3", value: 3, lineIndex: 6 }), // second tax, never referenced by any block
      entry({ amountId: "A4", value: 105, lineIndex: 7 }),
    ];
    const blocks: StructureBlock[] = [
      { blockId: "ITEM", kind: "item", lineIndices: [1], parentBlockId: null, name: "Widget", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "SUB", kind: "summary", lineIndices: [4], parentBlockId: null, name: "Subtotal", amountId: "A1", quantity: null, priceKind: null },
      { blockId: "TAX1", kind: "summary", lineIndices: [5], parentBlockId: null, name: "Tax", amountId: "A2", quantity: null, priceKind: null },
      { blockId: "TOT", kind: "summary", lineIndices: [7], parentBlockId: null, name: "Total", amountId: "A4", quantity: null, priceKind: null },
    ];
    const assignments: Assignment[] = [
      { blockId: "ITEM", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "SUB", amountId: "A1", quantity: null, priceKind: null },
      { blockId: "TAX1", amountId: "A2", quantity: null, priceKind: null },
      { blockId: "TOT", amountId: "A4", quantity: null, priceKind: null },
    ];
    const validations = validateAssignments(blocks, assignments, ledger);
    const { summaryCoverage, summaryValidity, finalReconciles } = finalizeSummary("CAD", blocks, validations, ledger);
    assert(summaryCoverage.some((c) => c.role === "GRAND_TOTAL"), "GRAND_TOTAL DOES resolve here — the new invariant is satisfied");
    assertEqual(summaryValidity.summaryUnresolvedAmountCount, 1, "invalid for the ORIGINAL reason: the second tax is unresolved, not for a missing GRAND_TOTAL");
    assertEqual(summaryValidity.valid, false);
    assertEqual(finalReconciles, false);
  });

  // ── FIX 15.3B — the shared-winner coincidence is refused only by a LARGER
  //    unclaimed value, not by any unclaimed value ──────────────────────────

  it("BL — Mademoiselle shape: the unclaimed 50.85 is LARGER than the shared winner 45.00 → coincidence still refused", () => {
    const ledger: LedgerEntry[] = [
      entry({ amountId: "I1", value: 45, lineIndex: 1 }),
      entry({ amountId: "A1", value: 45, lineIndex: 5 }),
      entry({ amountId: "A2", value: 5.85, lineIndex: 6 }),
      entry({ amountId: "A3", value: 50.85, lineIndex: 7 }), // LARGER than the winner
    ];
    const blocks: StructureBlock[] = [
      { blockId: "ITEM", kind: "item", lineIndices: [1], parentBlockId: null, name: "Belvedere", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "SUM", kind: "summary", lineIndices: [5, 6, 7], parentBlockId: null, name: "Total", amountId: "A1", quantity: null, priceKind: null },
    ];
    const assignments: Assignment[] = [
      { blockId: "ITEM", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "SUM", amountId: "A1", quantity: null, priceKind: null },
    ];
    const validations = validateAssignments(blocks, assignments, ledger);
    const { summaryValidity, reconciliation, finalReconciles } = finalizeSummary("CAD", blocks, validations, ledger);
    assertEqual(reconciliation.reconciles, true);
    assertEqual(summaryValidity.summaryDuplicateRoleAttemptCount, 1, "refused — 50.85 is larger than the 45.00 shared winner");
    assertEqual(summaryValidity.valid, false);
    assertEqual(finalReconciles, false);
  });

  it("BM — Quebra Mar shape: an unclaimed VAT-rate breakdown, all SMALLER than the shared winner, no longer blocks the coincidence itself", () => {
    // Real values from the Quebra Mar fixture: subtotal/total share 300.25;
    // the informal VAT-rate breakdown (never claimed by any block) is
    // 18.56 / 10.41 / 65.09 / 28.97 / 271.28 — every one smaller than
    // 300.25. Under FIX 15.3B the coincidence itself is permitted (no
    // duplicate-role rejection): GRAND_TOTAL resolves cleanly to the single
    // winner, exactly as it did before FIX 15.1 existed.
    //
    // This does NOT, on its own, bring the receipt back to
    // finalReconciles=true — the breakdown values are bare ledger-fallback
    // orphans (no block ever claims them), and classifySummaryCoverage
    // reports any unclaimed decimal in the summary region as UNRESOLVED
    // regardless of the coincidence decision. That is a SEPARATE, known gap
    // (informal tax-rate breakdown tables have no positive "this is
    // informational" signal today) — explicitly out of scope for this fix
    // per the summary-closure-engine archive, not silently patched here.
    const ledger: LedgerEntry[] = [
      entry({ amountId: "I1", value: 300.25, lineIndex: 1 }),
      entry({ amountId: "A1", value: 300.25, lineIndex: 5 }),
      entry({ amountId: "B1", value: 18.56, lineIndex: 6 }),
      entry({ amountId: "B2", value: 10.41, lineIndex: 7 }),
      entry({ amountId: "B3", value: 65.09, lineIndex: 8 }),
      entry({ amountId: "B4", value: 28.97, lineIndex: 9 }),
      entry({ amountId: "B5", value: 271.28, lineIndex: 10 }), // largest orphan, still smaller than the winner
    ];
    const blocks: StructureBlock[] = [
      { blockId: "ITEM", kind: "item", lineIndices: [1], parentBlockId: null, name: "Widget", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "TOT", kind: "summary", lineIndices: [5], parentBlockId: null, name: null, amountId: "A1", quantity: null, priceKind: null },
    ];
    const assignments: Assignment[] = [
      { blockId: "ITEM", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "TOT", amountId: "A1", quantity: null, priceKind: null },
    ];
    const validations = validateAssignments(blocks, assignments, ledger);
    const { summaryCoverage, summaryValidity, finalReconciles } = finalizeSummary("CAD", blocks, validations, ledger);
    assertEqual(summaryValidity.summaryDuplicateRoleAttemptCount, 0, "FIX 15.3B: nothing unclaimed is LARGER than the winner — the coincidence is permitted");
    assertEqual(summaryCoverage.find((c) => c.amountId === "A1")?.role, "GRAND_TOTAL", "the winner cleanly resolves GRAND_TOTAL, not a duplicated role");
    assertEqual(summaryValidity.summaryUnresolvedAmountCount, 5, "the breakdown values remain unresolved — a separate, un-addressed gap, not fixed by this patch");
    assertEqual(summaryValidity.valid, false, "still invalid overall, but now for the honest reason (unresolved breakdown), not a false duplicate-role rejection");
    assertEqual(finalReconciles, false);
  });

  it("BN — an unclaimed value EXACTLY EQUAL to the shared winner does not block the coincidence (an echo/duplicate print, not evidence of a missed larger total)", () => {
    const ledger: LedgerEntry[] = [
      entry({ amountId: "I1", value: 50, lineIndex: 1 }),
      entry({ amountId: "A1", value: 50, lineIndex: 5 }),
      entry({ amountId: "A2", value: 50, lineIndex: 6 }), // unclaimed, exactly equal — never a "larger" orphan
    ];
    const blocks: StructureBlock[] = [
      { blockId: "ITEM", kind: "item", lineIndices: [1], parentBlockId: null, name: "Widget", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "TOT", kind: "summary", lineIndices: [5], parentBlockId: null, name: null, amountId: "A1", quantity: null, priceKind: null },
    ];
    const assignments: Assignment[] = [
      { blockId: "ITEM", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "TOT", amountId: "A1", quantity: null, priceKind: null },
    ];
    const validations = validateAssignments(blocks, assignments, ledger);
    const { summaryValidity } = finalizeSummary("CAD", blocks, validations, ledger);
    assertEqual(summaryValidity.summaryDuplicateRoleAttemptCount, 0, "equal, not larger — the coincidence is permitted, per the '>' (not '>=') threshold documented in validate.ts");
  });

  // ── FIX 17 Part 1 — closing the block-backed FALSE_VALID hole ──────────────

  it("BO / Scenario 1 (control) — one comprehensive SUMMARY block: 45/5.85/50.85, only 45 claimed → correctly refused", () => {
    const ledger: LedgerEntry[] = [
      entry({ amountId: "I1", value: 45, lineIndex: 1 }),
      entry({ amountId: "A1", value: 45, lineIndex: 5 }),
      entry({ amountId: "A2", value: 5.85, lineIndex: 6 }),
      entry({ amountId: "A3", value: 50.85, lineIndex: 7 }),
    ];
    const blocks: StructureBlock[] = [
      { blockId: "ITEM", kind: "item", lineIndices: [1], parentBlockId: null, name: "Widget", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "SUM", kind: "summary", lineIndices: [5, 6, 7], parentBlockId: null, name: null, amountId: "A1", quantity: null, priceKind: null },
    ];
    const assignments: Assignment[] = [
      { blockId: "ITEM", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "SUM", amountId: "A1", quantity: null, priceKind: null },
    ];
    const validations = validateAssignments(blocks, assignments, ledger);
    const { assembled, summaryValidity, finalReconciles } = finalizeSummary("CAD", blocks, validations, ledger);
    assertEqual(assembled.payload.printedTotal, 45, "unchanged — this fix never corrects a value, only refuses to trust an unproven one");
    assertEqual(summaryValidity.valid, false);
    assertEqual(finalReconciles, false);
  });

  it("BP — Scenario 2: SAME values/evidence as BO, but 45/5.85/50.85 in THREE separate SUMMARY blocks → the FALSE_VALID hole, now closed", () => {
    // Before FIX 17 Part 1: A2/A3 each had their own block, so neither ever
    // entered `unclaimedOrphans` (ledger_-prefixed only) — the shared-winner
    // coincidence was permitted unconditionally, A2/A3 were demoted to
    // NON_CHARGE_INFORMATIONAL with zero proof, and finalReconciles=true
    // with printedTotal=45 (wrong — the real total is 50.85). Deterministic,
    // not a one-off: reproduced directly against these modules, no network.
    const ledger: LedgerEntry[] = [
      entry({ amountId: "I1", value: 45, lineIndex: 1 }),
      entry({ amountId: "A1", value: 45, lineIndex: 5 }),
      entry({ amountId: "A2", value: 5.85, lineIndex: 6 }),
      entry({ amountId: "A3", value: 50.85, lineIndex: 7 }),
    ];
    const blocks: StructureBlock[] = [
      { blockId: "ITEM", kind: "item", lineIndices: [1], parentBlockId: null, name: "Widget", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "B1", kind: "summary", lineIndices: [5], parentBlockId: null, name: null, amountId: "A1", quantity: null, priceKind: null },
      { blockId: "B2", kind: "summary", lineIndices: [6], parentBlockId: null, name: null, amountId: "A2", quantity: null, priceKind: null },
      { blockId: "B3", kind: "summary", lineIndices: [7], parentBlockId: null, name: null, amountId: "A3", quantity: null, priceKind: null },
    ];
    const assignments: Assignment[] = [
      { blockId: "ITEM", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "B1", amountId: "A1", quantity: null, priceKind: null },
      { blockId: "B2", amountId: "A2", quantity: null, priceKind: null },
      { blockId: "B3", amountId: "A3", quantity: null, priceKind: null },
    ];
    const validations = validateAssignments(blocks, assignments, ledger);
    const { assembled, summaryCoverage, summaryValidity, finalReconciles } = finalizeSummary("CAD", blocks, validations, ledger);
    assertEqual(summaryCoverage.find((c) => c.amountId === "A2")?.role, "UNRESOLVED", "no proof this is informational — must not vanish into a role");
    assertEqual(summaryCoverage.find((c) => c.amountId === "A3")?.role, "UNRESOLVED", "the real total, unproven, must not be demoted to informational either");
    assertEqual(assembled.payload.printedTotal, 45, "still the (wrong) closure winner — this fix never corrects a value, only refuses to certify it");
    assertEqual(summaryValidity.valid, false, "FIX 17 Part 1: the hole is closed — segmentation into separate blocks no longer bypasses scrutiny");
    assertEqual(finalReconciles, false, "the old guaranteed FALSE_VALID outcome for this input shape is now structurally impossible");
  });

  it("BQ — Scenario 3: subtotal 100 / discount 20 / total 80, three separate blocks → same hole, discount shape, now closed", () => {
    const ledger: LedgerEntry[] = [
      entry({ amountId: "I1", value: 100, lineIndex: 1 }),
      entry({ amountId: "A1", value: 100, lineIndex: 5 }),
      entry({ amountId: "A2", value: 20, lineIndex: 6 }),
      entry({ amountId: "A3", value: 80, lineIndex: 7 }),
    ];
    const blocks: StructureBlock[] = [
      { blockId: "ITEM", kind: "item", lineIndices: [1], parentBlockId: null, name: "Widget", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "B1", kind: "summary", lineIndices: [5], parentBlockId: null, name: null, amountId: "A1", quantity: null, priceKind: null },
      { blockId: "B2", kind: "summary", lineIndices: [6], parentBlockId: null, name: null, amountId: "A2", quantity: null, priceKind: null },
      { blockId: "B3", kind: "summary", lineIndices: [7], parentBlockId: null, name: null, amountId: "A3", quantity: null, priceKind: null },
    ];
    const assignments: Assignment[] = [
      { blockId: "ITEM", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "B1", amountId: "A1", quantity: null, priceKind: null },
      { blockId: "B2", amountId: "A2", quantity: null, priceKind: null },
      { blockId: "B3", amountId: "A3", quantity: null, priceKind: null },
    ];
    const validations = validateAssignments(blocks, assignments, ledger);
    const { assembled, summaryCoverage, summaryValidity, finalReconciles } = finalizeSummary("CAD", blocks, validations, ledger);
    assertEqual(summaryCoverage.find((c) => c.amountId === "A2")?.role, "UNRESOLVED");
    assertEqual(summaryCoverage.find((c) => c.amountId === "A3")?.role, "UNRESOLVED", "the real (smaller) total, unproven, must not be demoted to informational");
    assertEqual(assembled.payload.printedTotal, 100, "still the wrong closure winner — never silently corrected to 80");
    assertEqual(summaryValidity.valid, false);
    assertEqual(finalReconciles, false);
  });

  it("BR — Pai-shaped negative control: base×rate=value on a REAL, uncounted charge must stay UNRESOLVED, never informational, so a future tax-table heuristic can be checked against it", () => {
    // 278.00 items; a real 20% surcharge (55.60 = 278.00*0.20, a genuine,
    // still-uncounted addition to the total) sits in its own unnamed block;
    // the real printed total (376.97 = 278+55.60+43.37 tax) is unreachable
    // because the surcharge was never recognized as a charge. This has the
    // IDENTICAL base*rate=value shape as an informational tax-rate
    // disclosure — proving that shape alone can never justify treating a
    // value as informational (see docs/design/summary-closure-identity-
    // graph.md's negative-result note on FIX 15.3's tax-table hypothesis).
    const ledger: LedgerEntry[] = [
      entry({ amountId: "I1", value: 278, lineIndex: 1 }),
      entry({ amountId: "SUB", value: 278, lineIndex: 5 }),
      entry({ amountId: "SUR", value: 55.6, lineIndex: 6 }), // 278.00 * 20% — real charge, unnamed block
      entry({ amountId: "TAX", value: 43.37, lineIndex: 7 }),
      entry({ amountId: "TOT", value: 376.97, lineIndex: 8 }),
    ];
    const blocks: StructureBlock[] = [
      { blockId: "ITEM", kind: "item", lineIndices: [1], parentBlockId: null, name: "Widget", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "SUB", kind: "summary", lineIndices: [5], parentBlockId: null, name: null, amountId: "SUB", quantity: null, priceKind: null },
      { blockId: "SUR", kind: "summary", lineIndices: [6], parentBlockId: null, name: null, amountId: "SUR", quantity: null, priceKind: null },
      { blockId: "TAX", kind: "summary", lineIndices: [7], parentBlockId: null, name: "Tax", amountId: "TAX", quantity: null, priceKind: null },
      { blockId: "TOT", kind: "summary", lineIndices: [8], parentBlockId: null, name: null, amountId: "TOT", quantity: null, priceKind: null },
    ];
    const assignments: Assignment[] = [
      { blockId: "ITEM", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "SUB", amountId: "SUB", quantity: null, priceKind: null },
      { blockId: "SUR", amountId: "SUR", quantity: null, priceKind: null },
      { blockId: "TAX", amountId: "TAX", quantity: null, priceKind: null },
      { blockId: "TOT", amountId: "TOT", quantity: null, priceKind: null },
    ];
    const validations = validateAssignments(blocks, assignments, ledger);
    const { summaryCoverage, summaryValidity, finalReconciles } = finalizeSummary("CAD", blocks, validations, ledger);
    assertEqual(summaryCoverage.find((c) => c.amountId === "SUR")?.role, "UNRESOLVED", "base*rate=value shape alone must never be read as proof of 'informational'");
    assertEqual(summaryCoverage.find((c) => c.amountId === "TOT")?.role, "UNRESOLVED");
    assertEqual(summaryValidity.valid, false);
    assertEqual(finalReconciles, false);
  });

  // ── FIX 19 — exact echo: recognizing what FIX 11 already resolved ──────────
  //
  // classifyCoverage/determineValidity are the ITEMS-region counterparts of
  // classifySummaryCoverage/determineSummaryValidity above (FIX 7, not FIX
  // 15) — no test in this file exercised them directly before this section.

  it("BS — exact echo, SAME line: Mad God real values (A65=5.00 unclaimed, A66=5.00 claimed by the item block, both on OCR line 61 — the printed line literally carries the figure twice) → no longer UNRESOLVED", () => {
    const ledger: LedgerEntry[] = [
      entry({ amountId: "A65", value: 5.0, lineIndex: 61 }),
      entry({ amountId: "A66", value: 5.0, lineIndex: 61 }),
    ];
    const blocks: StructureBlock[] = [
      { blockId: "b28", kind: "item", lineIndices: [61], parentBlockId: null, name: "Gin Black Pig", amountId: "A66", quantity: 1, priceKind: "lineTotal" },
    ];
    const assignments: Assignment[] = [{ blockId: "b28", amountId: "A66", quantity: 1, priceKind: "lineTotal" }];
    const itemsRegionEnd = computeItemsRegionEnd(blocks);
    const coverage = classifyCoverage(blocks, assignments, ledger, itemsRegionEnd);
    assertEqual(coverage.find((c) => c.amountId === "A65")?.state, "ECHO_OF_CLAIMED_VALUE", "an exact same-line duplicate of a value the block already claims must not stay UNRESOLVED");
    assertEqual(coverage.find((c) => c.amountId === "A65")?.claimedByBlockId, "b28");
    const validity = determineValidity(findStructuralGaps(blocks, ledger, itemsRegionEnd), coverage, findDuplicateOwnership(assignments), [], true);
    assertEqual(validity.echoExactCount, 1);
    assertEqual(validity.unresolvedLoadBearingCount, 0, "the echo must not count as a genuine miss");
    assertEqual(validity.valid, true, "a proven echo must never block validity");
  });

  it("BT — exact echo, ADJACENT line: Quebra Mar real values (item 'Doce de Areia' claims A27=3.50 on line 57; the 'Preco: 3,50/Uni' annotation A28=3.50 sits on line 58, unclaimed) → no longer UNRESOLVED", () => {
    const ledger: LedgerEntry[] = [
      entry({ amountId: "A27", value: 3.5, lineIndex: 57 }),
      entry({ amountId: "A28", value: 3.5, lineIndex: 58 }),
    ];
    const blocks: StructureBlock[] = [
      { blockId: "b33", kind: "item", lineIndices: [57, 58], parentBlockId: null, name: "Doce de Areia", amountId: "A27", quantity: 1, priceKind: "lineTotal" },
    ];
    const assignments: Assignment[] = [{ blockId: "b33", amountId: "A27", quantity: 1, priceKind: "lineTotal" }];
    const itemsRegionEnd = computeItemsRegionEnd(blocks);
    const coverage = classifyCoverage(blocks, assignments, ledger, itemsRegionEnd);
    assertEqual(coverage.find((c) => c.amountId === "A28")?.state, "ECHO_OF_CLAIMED_VALUE", "an exact adjacent-line duplicate of a value the block already claims must not stay UNRESOLVED");
    assertEqual(coverage.find((c) => c.amountId === "A28")?.claimedByBlockId, "b33");
    const validity = determineValidity(findStructuralGaps(blocks, ledger, itemsRegionEnd), coverage, findDuplicateOwnership(assignments), [], true);
    assertEqual(validity.echoExactCount, 1);
    assertEqual(validity.unresolvedLoadBearingCount, 0);
    assertEqual(validity.valid, true);
  });

  it("BU — safety guard: a DIFFERENT value, same territory, adjacent line, must stay UNRESOLVED (never echoes a value that was never actually claimed)", () => {
    const ledger: LedgerEntry[] = [
      entry({ amountId: "A1", value: 5.0, lineIndex: 10 }),
      entry({ amountId: "A2", value: 6.0, lineIndex: 11 }), // different value — a real extra charge, not a duplicate print
    ];
    const blocks: StructureBlock[] = [
      { blockId: "ITEM", kind: "item", lineIndices: [10, 11], parentBlockId: null, name: "Widget", amountId: "A1", quantity: 1, priceKind: "lineTotal" },
    ];
    const assignments: Assignment[] = [{ blockId: "ITEM", amountId: "A1", quantity: 1, priceKind: "lineTotal" }];
    const itemsRegionEnd = computeItemsRegionEnd(blocks);
    const coverage = classifyCoverage(blocks, assignments, ledger, itemsRegionEnd);
    assertEqual(coverage.find((c) => c.amountId === "A2")?.state, "UNRESOLVED", "a different value must never be recognized as an echo — this is the mandatory counter-test for FIX 19's safety guard");
    const validity = determineValidity(findStructuralGaps(blocks, ledger, itemsRegionEnd), coverage, findDuplicateOwnership(assignments), [], true);
    assertEqual(validity.echoExactCount, 0);
    assertEqual(validity.unresolvedLoadBearingCount, 1);
    assertEqual(validity.valid, false);
  });

  it("BV — equal value but OUTSIDE any block's territory must stay UNRESOLVED", () => {
    const ledger: LedgerEntry[] = [
      entry({ amountId: "A1", value: 5.0, lineIndex: 10 }),
      entry({ amountId: "A2", value: 5.0, lineIndex: 20 }), // same value, but nowhere near the claiming block
    ];
    const blocks: StructureBlock[] = [
      { blockId: "ITEM", kind: "item", lineIndices: [10], parentBlockId: null, name: "Widget", amountId: "A1", quantity: 1, priceKind: "lineTotal" },
    ];
    const assignments: Assignment[] = [{ blockId: "ITEM", amountId: "A1", quantity: 1, priceKind: "lineTotal" }];
    const itemsRegionEnd = computeItemsRegionEnd(blocks);
    const coverage = classifyCoverage(blocks, assignments, ledger, itemsRegionEnd);
    assertEqual(coverage.find((c) => c.amountId === "A2")?.state, "UNRESOLVED", "no block territory covers line 20 — an equal value alone is never sufficient");
    const validity = determineValidity(findStructuralGaps(blocks, ledger, itemsRegionEnd), coverage, findDuplicateOwnership(assignments), [], true);
    assertEqual(validity.unresolvedLoadBearingCount, 1);
    assertEqual(validity.valid, false);
  });

  it("BW — equal value, same territory, but the block claims NOTHING must stay UNRESOLVED", () => {
    const ledger: LedgerEntry[] = [
      entry({ amountId: "A1", value: 5.0, lineIndex: 10 }),
      entry({ amountId: "A2", value: 5.0, lineIndex: 11 }),
    ];
    const blocks: StructureBlock[] = [
      { blockId: "ITEM", kind: "item", lineIndices: [10, 11], parentBlockId: null, name: "Widget", amountId: null, quantity: 1, priceKind: "lineTotal" },
    ];
    const assignments: Assignment[] = [{ blockId: "ITEM", amountId: null, quantity: 1, priceKind: "lineTotal" }];
    const itemsRegionEnd = computeItemsRegionEnd(blocks);
    const coverage = classifyCoverage(blocks, assignments, ledger, itemsRegionEnd);
    assertEqual(coverage.find((c) => c.amountId === "A1")?.state, "UNRESOLVED", "a block that claims nothing proves nothing — condition 2 of findEchoOwner");
    assertEqual(coverage.find((c) => c.amountId === "A2")?.state, "UNRESOLVED");
    const validity = determineValidity(findStructuralGaps(blocks, ledger, itemsRegionEnd), coverage, findDuplicateOwnership(assignments), [], true);
    assertEqual(validity.unresolvedLoadBearingCount, 2);
    assertEqual(validity.valid, false);
  });

  it("BX — Pai-shaped negative control (items region): a REAL, uncounted charge adjacent to a claimed item price must stay UNRESOLVED and continue to block validity, even though it sits in the same block's territory", () => {
    // Mirrors BR's summary-region negative control, one region down: an
    // extra, genuinely-uncounted topping charge printed right next to an
    // item's price must never be waved through just because it shares the
    // item's territory — only an EXACT value match may do that (BS/BT).
    const ledger: LedgerEntry[] = [
      entry({ amountId: "A1", value: 12.0, lineIndex: 30 }), // the item's claimed price
      entry({ amountId: "A2", value: 2.5, lineIndex: 31 }), // real, uncounted "extra topping" charge — different value
    ];
    const blocks: StructureBlock[] = [
      { blockId: "ITEM", kind: "item", lineIndices: [30, 31], parentBlockId: null, name: "Pizza", amountId: "A1", quantity: 1, priceKind: "lineTotal" },
    ];
    const assignments: Assignment[] = [{ blockId: "ITEM", amountId: "A1", quantity: 1, priceKind: "lineTotal" }];
    const itemsRegionEnd = computeItemsRegionEnd(blocks);
    const coverage = classifyCoverage(blocks, assignments, ledger, itemsRegionEnd);
    assertEqual(coverage.find((c) => c.amountId === "A2")?.state, "UNRESOLVED", "a real uncounted charge must never be recognized as an echo of a different, already-claimed value");
    const validity = determineValidity(findStructuralGaps(blocks, ledger, itemsRegionEnd), coverage, findDuplicateOwnership(assignments), [], true);
    assertEqual(validity.unresolvedLoadBearingCount, 1);
    assertEqual(validity.valid, false, "the genuine miss must keep blocking validity — echo recognition must never widen into a general 'nearby value' amnesty");
  });

  // ── FIX 20 — multiplicative echo: candidate * quantity = claimed ───────────

  it("BY — multiplicative echo, valid: Quebra Mar real values (SAFATA DE PAO claims A4=5.25 on line 15, quantity=3; the 'Preco: 1,75/Uni' annotation A5=1.75 sits on line 16) → no longer UNRESOLVED", () => {
    const ledger: LedgerEntry[] = [
      entry({ amountId: "A4", value: 5.25, lineIndex: 15 }),
      entry({ amountId: "A5", value: 1.75, lineIndex: 16 }),
    ];
    const blocks: StructureBlock[] = [
      { blockId: "b11", kind: "item", lineIndices: [15, 16], parentBlockId: null, name: "SAFATA DE PAO", amountId: "A4", quantity: 3, priceKind: "lineTotal" },
    ];
    const assignments: Assignment[] = [{ blockId: "b11", amountId: "A4", quantity: 3, priceKind: "lineTotal" }];
    const itemsRegionEnd = computeItemsRegionEnd(blocks);
    const coverage = classifyCoverage(blocks, assignments, ledger, itemsRegionEnd);
    assertEqual(coverage.find((c) => c.amountId === "A5")?.state, "ECHO_MULTIPLICATIVE_OF_CLAIMED_VALUE", "1.75 * 3 = 5.25 exactly — a proven multiplicative echo must not stay UNRESOLVED");
    assertEqual(coverage.find((c) => c.amountId === "A5")?.claimedByBlockId, "b11");
    const validity = determineValidity(findStructuralGaps(blocks, ledger, itemsRegionEnd), coverage, findDuplicateOwnership(assignments), [], true);
    assertEqual(validity.echoMultiplicativeCount, 1);
    assertEqual(validity.echoExactCount, 0);
    assertEqual(validity.unresolvedLoadBearingCount, 0);
    assertEqual(validity.valid, true, "a proven multiplicative echo must never block validity");
  });

  it("BZ — safety guard (fails closed): same shape as BY but a wrong quantity (4 instead of 3) makes 1.75 * 4 = 7.00 ≠ 5.25 → stays UNRESOLVED", () => {
    const ledger: LedgerEntry[] = [
      entry({ amountId: "A4", value: 5.25, lineIndex: 15 }),
      entry({ amountId: "A5", value: 1.75, lineIndex: 16 }),
    ];
    const blocks: StructureBlock[] = [
      { blockId: "b11", kind: "item", lineIndices: [15, 16], parentBlockId: null, name: "SAFATA DE PAO", amountId: "A4", quantity: 4, priceKind: "lineTotal" },
    ];
    const assignments: Assignment[] = [{ blockId: "b11", amountId: "A4", quantity: 4, priceKind: "lineTotal" }];
    const itemsRegionEnd = computeItemsRegionEnd(blocks);
    const coverage = classifyCoverage(blocks, assignments, ledger, itemsRegionEnd);
    assertEqual(coverage.find((c) => c.amountId === "A5")?.state, "UNRESOLVED", "a wrong GPT quantity must make the arithmetic fail to close — never trusted, always verified");
    const validity = determineValidity(findStructuralGaps(blocks, ledger, itemsRegionEnd), coverage, findDuplicateOwnership(assignments), [], true);
    assertEqual(validity.echoMultiplicativeCount, 0);
    assertEqual(validity.unresolvedLoadBearingCount, 1);
    assertEqual(validity.valid, false);
  });

  it("CA — quantity = 1 with different values must stay UNRESOLVED (the rule must not degenerate into 'any value in territory passes')", () => {
    const ledger: LedgerEntry[] = [
      entry({ amountId: "A1", value: 5.0, lineIndex: 10 }),
      entry({ amountId: "A2", value: 6.0, lineIndex: 11 }),
    ];
    const blocks: StructureBlock[] = [
      { blockId: "ITEM", kind: "item", lineIndices: [10, 11], parentBlockId: null, name: "Widget", amountId: "A1", quantity: 1, priceKind: "lineTotal" },
    ];
    const assignments: Assignment[] = [{ blockId: "ITEM", amountId: "A1", quantity: 1, priceKind: "lineTotal" }];
    const itemsRegionEnd = computeItemsRegionEnd(blocks);
    const coverage = classifyCoverage(blocks, assignments, ledger, itemsRegionEnd);
    assertEqual(coverage.find((c) => c.amountId === "A2")?.state, "UNRESOLVED", "quantity<=1 must never reach the multiplicative path — that is exact echo's territory, and 6.00 != 5.00 there either");
    const validity = determineValidity(findStructuralGaps(blocks, ledger, itemsRegionEnd), coverage, findDuplicateOwnership(assignments), [], true);
    assertEqual(validity.echoMultiplicativeCount, 0);
    assertEqual(validity.unresolvedLoadBearingCount, 1);
    assertEqual(validity.valid, false);
  });

  it("CB — multiplication closes but the candidate sits OUTSIDE any block's territory must stay UNRESOLVED", () => {
    const ledger: LedgerEntry[] = [
      entry({ amountId: "A4", value: 5.25, lineIndex: 15 }),
      entry({ amountId: "A5", value: 1.75, lineIndex: 25 }), // 1.75 * 3 = 5.25 — closes numerically, but nowhere near the claiming block
    ];
    const blocks: StructureBlock[] = [
      { blockId: "b11", kind: "item", lineIndices: [15], parentBlockId: null, name: "SAFATA DE PAO", amountId: "A4", quantity: 3, priceKind: "lineTotal" },
    ];
    const assignments: Assignment[] = [{ blockId: "b11", amountId: "A4", quantity: 3, priceKind: "lineTotal" }];
    const itemsRegionEnd = computeItemsRegionEnd(blocks);
    const coverage = classifyCoverage(blocks, assignments, ledger, itemsRegionEnd);
    assertEqual(coverage.find((c) => c.amountId === "A5")?.state, "UNRESOLVED", "no block territory covers line 25 — a closing product alone is never sufficient, exactly like BV for the exact-echo case");
    const validity = determineValidity(findStructuralGaps(blocks, ledger, itemsRegionEnd), coverage, findDuplicateOwnership(assignments), [], true);
    assertEqual(validity.unresolvedLoadBearingCount, 1);
    assertEqual(validity.valid, false);
  });

  it("CC — FIX 21 SUPERSEDES this test's original FIX 20 premise: adjacency + exact arithmetic is now sufficient, on its own, to mark a same-or-adjacent-line value as an echo, even one that once needed a same-block guard to be refused", () => {
    // FIX 20's version of this test asserted the OPPOSITE outcome, on the
    // same numbers: a real, uncounted "Extra Cheese" charge (12.00) sitting
    // in its own sibling MODIFIER block (which claims nothing) next to a
    // Pizza item (quantity=2, claims 24.00) stayed UNRESOLVED, because
    // territory required the CANDIDATE's OWN block to be the one with the
    // claim. FIX 21 deliberately removed that requirement — see coverage.ts's
    // Claim interface comment — because it was also the mechanism silently
    // blocking 12 of Quebra Mar's 13 real remaining entries (see CD/CE).
    // Line adjacency + exact minor-unit arithmetic are what's left to guard
    // against exactly this shape, and on THIS synthetic input they are not
    // enough: 12.00 * 2 = 24.00 is now read as a multiplicative echo of the
    // Pizza's claim, disclosed and reported rather than silently accepted —
    // per FIX 21's explicit instruction not to add a new guard without
    // asking first, this is deliberately left as observed behavior.
    // Investigated against real data (Mad God, the corpus's most
    // repeated-value-dense receipt: Truffle x3 @16.95, Kids x3 @12.50) and
    // found NOT to occur in practice — every pair of same-valued real item
    // claims sits at least 7 OCR lines apart, far outside the <=1 adjacency
    // window this rule allows. The exposure is real in principle (this
    // test proves it can happen) but unobserved across the 8-receipt corpus.
    const ledger: LedgerEntry[] = [
      entry({ amountId: "A1", value: 24.0, lineIndex: 30 }), // 2 pizzas, claimed as one line total
      entry({ amountId: "A2", value: 12.0, lineIndex: 31 }), // real, uncounted "Extra Cheese" charge — 12*2=24 by coincidence
    ];
    const blocks: StructureBlock[] = [
      { blockId: "ITEM", kind: "item", lineIndices: [30], parentBlockId: null, name: "Pizza", amountId: "A1", quantity: 2, priceKind: "lineTotal" },
      { blockId: "MOD", kind: "modifier", lineIndices: [31], parentBlockId: "ITEM", name: null, amountId: null, quantity: null, priceKind: null },
    ];
    const assignments: Assignment[] = [
      { blockId: "ITEM", amountId: "A1", quantity: 2, priceKind: "lineTotal" },
      { blockId: "MOD", amountId: null, quantity: null, priceKind: null },
    ];
    const itemsRegionEnd = computeItemsRegionEnd(blocks);
    const coverage = classifyCoverage(blocks, assignments, ledger, itemsRegionEnd);
    assertEqual(
      coverage.find((c) => c.amountId === "A2")?.state,
      "ECHO_MULTIPLICATIVE_OF_CLAIMED_VALUE",
      "FIX 21: adjacency + exact arithmetic alone now qualifies — the same-block requirement that used to refuse this is gone by design, reported to the user rather than patched"
    );
    const validity = determineValidity(findStructuralGaps(blocks, ledger, itemsRegionEnd), coverage, findDuplicateOwnership(assignments), [], true);
    assertEqual(validity.echoMultiplicativeCount, 1);
    assertEqual(validity.unresolvedLoadBearingCount, 0);
  });

  it("CD — exhaustive verification, Quebra Mar real items region (run1, all 32 ledger entries / 37 blocks): every one of the 15 unit-price-annotation candidates is accounted for, and the reason each of the 13 still-UNRESOLVED ones fails is verified, not assumed", () => {
    // Reconstructed verbatim from fix19-corpus-quebramar-run1.debug.json's
    // saved blocks/ledger (itemsRegionEnd=65, the first SUMMARY block's
    // earliest line) — the same real-data-reconstruction technique used in
    // FIX 18's investigation, so this is not a synthetic approximation.
    // A1/A2/A3 (real rawText "-463", "463", "0" — NIF/header noise, no
    // decimal point at all) are omitted: the entry() helper always formats
    // via toFixed(2), which would wrongly make them decimal-shaped here and
    // inflate the count — the real classifyCoverage correctly never sees
    // them as candidates at all, so they add nothing to what this test
    // verifies.
    const ledger: LedgerEntry[] = [
      entry({ amountId: "A4", value: 5.25, lineIndex: 15 }),
      entry({ amountId: "A5", value: 1.75, lineIndex: 16 }),
      entry({ amountId: "A6", value: 4.5, lineIndex: 19 }),
      entry({ amountId: "A7", value: 1.5, lineIndex: 20 }),
      entry({ amountId: "A8", value: 1.5, lineIndex: 23 }),
      entry({ amountId: "A9", value: 0.5, lineIndex: 24 }),
      entry({ amountId: "A10", value: 18, lineIndex: 27 }),
      entry({ amountId: "A11", value: 4.5, lineIndex: 28 }),
      entry({ amountId: "A12", value: 2, lineIndex: 29 }),
      entry({ amountId: "A13", value: 2.5, lineIndex: 31 }),
      entry({ amountId: "A14", value: 2.5, lineIndex: 32 }),
      entry({ amountId: "A15", value: 55, lineIndex: 35 }),
      entry({ amountId: "A16", value: 27.5, lineIndex: 36 }),
      entry({ amountId: "A17", value: 40, lineIndex: 39 }),
      entry({ amountId: "A18", value: 20, lineIndex: 40 }),
      entry({ amountId: "A19", value: 70, lineIndex: 43 }),
      entry({ amountId: "A20", value: 35, lineIndex: 44 }),
      entry({ amountId: "A21", value: 50, lineIndex: 47 }),
      entry({ amountId: "A22", value: 25, lineIndex: 48 }),
      entry({ amountId: "A23", value: 40, lineIndex: 51 }),
      entry({ amountId: "A24", value: 20, lineIndex: 52 }),
      entry({ amountId: "A25", value: 2, lineIndex: 55 }),
      entry({ amountId: "A26", value: 2, lineIndex: 56 }),
      entry({ amountId: "A27", value: 3.5, lineIndex: 57 }),
      entry({ amountId: "A28", value: 3.5, lineIndex: 58 }),
      entry({ amountId: "A29", value: 7, lineIndex: 59 }),
      entry({ amountId: "A30", value: 3.5, lineIndex: 60 }),
      entry({ amountId: "A31", value: 1, lineIndex: 63 }),
      entry({ amountId: "A32", value: 1, lineIndex: 64 }),
    ];
    const blocks: StructureBlock[] = [
      { blockId: "b0", kind: "unclassified", lineIndices: [0], parentBlockId: null, name: null, amountId: null, quantity: null, priceKind: null },
      { blockId: "b1", kind: "unclassified", lineIndices: [1], parentBlockId: null, name: null, amountId: null, quantity: null, priceKind: null },
      { blockId: "b2", kind: "unclassified", lineIndices: [2], parentBlockId: null, name: null, amountId: null, quantity: null, priceKind: null },
      { blockId: "b3", kind: "unclassified", lineIndices: [3], parentBlockId: null, name: null, amountId: null, quantity: null, priceKind: null },
      { blockId: "b4", kind: "unclassified", lineIndices: [4], parentBlockId: null, name: null, amountId: null, quantity: null, priceKind: null },
      { blockId: "b5", kind: "unclassified", lineIndices: [5], parentBlockId: null, name: null, amountId: null, quantity: null, priceKind: null },
      { blockId: "b6", kind: "unclassified", lineIndices: [6], parentBlockId: null, name: null, amountId: null, quantity: null, priceKind: null },
      { blockId: "b7", kind: "unclassified", lineIndices: [7], parentBlockId: null, name: null, amountId: null, quantity: null, priceKind: null },
      { blockId: "b8", kind: "unclassified", lineIndices: [8], parentBlockId: null, name: null, amountId: null, quantity: null, priceKind: null },
      { blockId: "b9", kind: "unclassified", lineIndices: [9], parentBlockId: null, name: null, amountId: null, quantity: null, priceKind: null },
      { blockId: "b10", kind: "unclassified", lineIndices: [10, 11, 12], parentBlockId: null, name: null, amountId: null, quantity: null, priceKind: null },
      { blockId: "b11", kind: "item", lineIndices: [13, 14, 15], parentBlockId: null, name: "SAFATA DE PAO", amountId: "A4", quantity: 3, priceKind: "lineTotal" },
      { blockId: "b12", kind: "modifier", lineIndices: [16], parentBlockId: "b11", name: null, amountId: null, quantity: null, priceKind: null },
      { blockId: "b13", kind: "item", lineIndices: [17, 18, 19], parentBlockId: null, name: "queijo", amountId: "A6", quantity: 3, priceKind: "lineTotal" },
      { blockId: "b14", kind: "modifier", lineIndices: [20], parentBlockId: "b13", name: null, amountId: null, quantity: null, priceKind: null },
      { blockId: "b15", kind: "item", lineIndices: [21, 22, 23], parentBlockId: null, name: "manteiga", amountId: "A8", quantity: 3, priceKind: "lineTotal" },
      { blockId: "b16", kind: "modifier", lineIndices: [24], parentBlockId: "b15", name: null, amountId: null, quantity: null, priceKind: null },
      { blockId: "b17", kind: "item", lineIndices: [25, 26, 27], parentBlockId: null, name: "SUMERSBY", amountId: "A10", quantity: 4, priceKind: "lineTotal" },
      { blockId: "b18", kind: "modifier", lineIndices: [28], parentBlockId: "b17", name: null, amountId: null, quantity: null, priceKind: null },
      { blockId: "b19", kind: "item", lineIndices: [29, 30, 31], parentBlockId: null, name: "FINO", amountId: "A13", quantity: 1, priceKind: "lineTotal" },
      { blockId: "b20", kind: "modifier", lineIndices: [32], parentBlockId: "b19", name: null, amountId: null, quantity: null, priceKind: null },
      { blockId: "b21", kind: "item", lineIndices: [33, 34, 35], parentBlockId: null, name: "vinho Branco", amountId: "A15", quantity: 2, priceKind: "lineTotal" },
      { blockId: "b22", kind: "modifier", lineIndices: [36], parentBlockId: "b21", name: null, amountId: null, quantity: null, priceKind: null },
      { blockId: "b23", kind: "item", lineIndices: [37, 38, 39], parentBlockId: null, name: "Lapas", amountId: "A17", quantity: 2, priceKind: "lineTotal" },
      { blockId: "b24", kind: "modifier", lineIndices: [40], parentBlockId: "b23", name: null, amountId: null, quantity: null, priceKind: null },
      { blockId: "b25", kind: "item", lineIndices: [41, 42, 43], parentBlockId: null, name: "Boca Negra", amountId: "A19", quantity: 2, priceKind: "lineTotal" },
      { blockId: "b26", kind: "modifier", lineIndices: [44], parentBlockId: "b25", name: null, amountId: null, quantity: null, priceKind: null },
      { blockId: "b27", kind: "item", lineIndices: [45, 46, 47], parentBlockId: null, name: "Cantaro", amountId: "A21", quantity: 2, priceKind: "lineTotal" },
      { blockId: "b28", kind: "modifier", lineIndices: [48], parentBlockId: "b27", name: null, amountId: null, quantity: null, priceKind: null },
      { blockId: "b29", kind: "item", lineIndices: [49, 50, 51], parentBlockId: null, name: "Espadarte", amountId: "A23", quantity: 2, priceKind: "lineTotal" },
      { blockId: "b30", kind: "modifier", lineIndices: [52], parentBlockId: "b29", name: null, amountId: null, quantity: null, priceKind: null },
      { blockId: "b31", kind: "item", lineIndices: [53, 54, 55], parentBlockId: null, name: "Agua c/ Gas", amountId: "A25", quantity: 1, priceKind: "lineTotal" },
      { blockId: "b32", kind: "modifier", lineIndices: [56], parentBlockId: "b31", name: null, amountId: null, quantity: null, priceKind: null },
      { blockId: "b33", kind: "item", lineIndices: [57, 58], parentBlockId: null, name: "Doce de Areia", amountId: "A27", quantity: 1, priceKind: "lineTotal" },
      { blockId: "b34", kind: "item", lineIndices: [59, 60], parentBlockId: null, name: "Mousse de choco", amountId: "A29", quantity: 2, priceKind: "lineTotal" },
      { blockId: "b35", kind: "item", lineIndices: [61, 62, 63], parentBlockId: null, name: "cafe", amountId: "A31", quantity: 1, priceKind: "lineTotal" },
      { blockId: "b36", kind: "modifier", lineIndices: [64], parentBlockId: "b35", name: null, amountId: null, quantity: null, priceKind: null },
    ];
    const assignments: Assignment[] = [
      { blockId: "b0", amountId: null, quantity: null, priceKind: null },
      { blockId: "b1", amountId: null, quantity: null, priceKind: null },
      { blockId: "b2", amountId: null, quantity: null, priceKind: null },
      { blockId: "b3", amountId: null, quantity: null, priceKind: null },
      { blockId: "b4", amountId: null, quantity: null, priceKind: null },
      { blockId: "b5", amountId: null, quantity: null, priceKind: null },
      { blockId: "b6", amountId: null, quantity: null, priceKind: null },
      { blockId: "b7", amountId: null, quantity: null, priceKind: null },
      { blockId: "b8", amountId: null, quantity: null, priceKind: null },
      { blockId: "b9", amountId: null, quantity: null, priceKind: null },
      { blockId: "b10", amountId: null, quantity: null, priceKind: null },
      { blockId: "b11", amountId: "A4", quantity: 3, priceKind: "lineTotal" },
      { blockId: "b12", amountId: null, quantity: null, priceKind: null },
      { blockId: "b13", amountId: "A6", quantity: 3, priceKind: "lineTotal" },
      { blockId: "b14", amountId: null, quantity: null, priceKind: null },
      { blockId: "b15", amountId: "A8", quantity: 3, priceKind: "lineTotal" },
      { blockId: "b16", amountId: null, quantity: null, priceKind: null },
      { blockId: "b17", amountId: "A10", quantity: 4, priceKind: "lineTotal" },
      { blockId: "b18", amountId: null, quantity: null, priceKind: null },
      { blockId: "b19", amountId: "A13", quantity: 1, priceKind: "lineTotal" },
      { blockId: "b20", amountId: null, quantity: null, priceKind: null },
      { blockId: "b21", amountId: "A15", quantity: 2, priceKind: "lineTotal" },
      { blockId: "b22", amountId: null, quantity: null, priceKind: null },
      { blockId: "b23", amountId: "A17", quantity: 2, priceKind: "lineTotal" },
      { blockId: "b24", amountId: null, quantity: null, priceKind: null },
      { blockId: "b25", amountId: "A19", quantity: 2, priceKind: "lineTotal" },
      { blockId: "b26", amountId: null, quantity: null, priceKind: null },
      { blockId: "b27", amountId: "A21", quantity: 2, priceKind: "lineTotal" },
      { blockId: "b28", amountId: null, quantity: null, priceKind: null },
      { blockId: "b29", amountId: "A23", quantity: 2, priceKind: "lineTotal" },
      { blockId: "b30", amountId: null, quantity: null, priceKind: null },
      { blockId: "b31", amountId: "A25", quantity: 1, priceKind: "lineTotal" },
      { blockId: "b32", amountId: null, quantity: null, priceKind: null },
      { blockId: "b33", amountId: "A27", quantity: 1, priceKind: "lineTotal" },
      { blockId: "b34", amountId: "A29", quantity: 2, priceKind: "lineTotal" },
      { blockId: "b35", amountId: "A31", quantity: 1, priceKind: "lineTotal" },
      { blockId: "b36", amountId: null, quantity: null, priceKind: null },
    ];
    const itemsRegionEnd = 65; // the real receipt's first SUMMARY block's earliest line
    const coverage = classifyCoverage(blocks, assignments, ledger, itemsRegionEnd);

    // FIX 21 SUPERSEDES FIX 20's finding here: with the same-block
    // ("territory") requirement removed, 14 of the 15 candidates now
    // resolve — the 12 that FIX 20's own version of this test found
    // blocked by an empty sibling MODIFIER block (individually enumerated
    // in CE below) resolve exactly as hand-verification always said they
    // would, plus the 2 that already resolved directly under FIX 20 (A28,
    // A30, whose annotation line happened to be merged into the item
    // block itself that run). Only A12 (FINO) remains UNRESOLVED — not a
    // territory problem any more, purely the adjacency guard (see CF).
    assertEqual(coverage.find((c) => c.amountId === "A28")?.state, "ECHO_OF_CLAIMED_VALUE", "Doce de Areia: quantity=1, 3.50=3.50 exactly");
    assertEqual(coverage.find((c) => c.amountId === "A30")?.state, "ECHO_MULTIPLICATIVE_OF_CLAIMED_VALUE", "Mousse de choco: quantity=2, 3.50*2=7.00 exactly");

    // A12 ("1 Uni FINO 2.00", line 29): FINO's own claim (A13=2.50) sits on
    // line 31, two lines away — outside the <=1 adjacency window, the ONE
    // guard FIX 21 did not touch. Still UNRESOLVED, for a different reason
    // than before (no longer "wrong territory" — there IS no territory
    // concept any more — purely "too far", verified by CF too).
    assertEqual(coverage.find((c) => c.amountId === "A12")?.state, "UNRESOLVED", "FINO's own claim is 2 lines away — the adjacency guard, unchanged by FIX 21");

    // The 12 that FIX 20 left UNRESOLVED (see CE for the one-by-one
    // enumeration with its own reasoning) now all resolve, matching hand
    // verification exactly — this is the real, verified answer to "why did
    // genuineMiss fall to ~1": adjacency replaced block membership as the
    // qualifying condition, and every one of these was always adjacent to
    // its true claim, just not IN the same block as it.
    const nowResolvedIds = ["A5", "A7", "A9", "A11", "A14", "A16", "A18", "A20", "A22", "A24", "A26", "A32"];
    for (const id of nowResolvedIds) {
      const state = coverage.find((c) => c.amountId === id)?.state;
      assert(state === "ECHO_OF_CLAIMED_VALUE" || state === "ECHO_MULTIPLICATIVE_OF_CLAIMED_VALUE", `${id}: expected an echo state now that territory is gone, got ${state}`);
    }

    const validity = determineValidity(findStructuralGaps(blocks, ledger, itemsRegionEnd), coverage, findDuplicateOwnership(assignments), [], true);
    assertEqual(validity.echoExactCount, 4, "A14, A26, A32 (quantity=1, exact match) + A28");
    assertEqual(validity.echoMultiplicativeCount, 10, "A5, A7, A9, A11, A16, A18, A20, A22, A24 (quantity>1, product match) + A30");
    assertEqual(validity.unresolvedLoadBearingCount, 1, "A12 (FINO) only — matches the real fix20-corpus-quebramar measurement exactly (genuineMiss 13 -> 1)");
  });

  it("CE — enumeration, one by one: the 12 Quebra Mar entries FIX 20 left blocked by the empty-sibling-MODIFIER pattern each resolve now, confirmed individually against their true parent item's real quantity/value", () => {
    // Same real Quebra Mar run1 data as CD/BS/BT, isolated to just these 12
    // pairs so each one's specific arithmetic is legible on its own — CD
    // covers the full 32-entry/37-block reconstruction; this is the
    // "enumera-os e confirma um a um" cross-check requested for FIX 21.
    const cases: Array<{ id: string; value: number; line: number; claimId: string; claimValue: number; claimLine: number; quantity: number; expected: "ECHO_OF_CLAIMED_VALUE" | "ECHO_MULTIPLICATIVE_OF_CLAIMED_VALUE" }> = [
      { id: "A5", value: 1.75, line: 16, claimId: "A4", claimValue: 5.25, claimLine: 15, quantity: 3, expected: "ECHO_MULTIPLICATIVE_OF_CLAIMED_VALUE" }, // SAFATA DE PAO
      { id: "A7", value: 1.5, line: 20, claimId: "A6", claimValue: 4.5, claimLine: 19, quantity: 3, expected: "ECHO_MULTIPLICATIVE_OF_CLAIMED_VALUE" }, // queijo
      { id: "A9", value: 0.5, line: 24, claimId: "A8", claimValue: 1.5, claimLine: 23, quantity: 3, expected: "ECHO_MULTIPLICATIVE_OF_CLAIMED_VALUE" }, // manteiga
      { id: "A11", value: 4.5, line: 28, claimId: "A10", claimValue: 18, claimLine: 27, quantity: 4, expected: "ECHO_MULTIPLICATIVE_OF_CLAIMED_VALUE" }, // SUMERSBY
      { id: "A14", value: 2.5, line: 32, claimId: "A13", claimValue: 2.5, claimLine: 31, quantity: 1, expected: "ECHO_OF_CLAIMED_VALUE" }, // FINO's OWN Preco line (not A12 — FINO has two candidates, this one IS adjacent)
      { id: "A16", value: 27.5, line: 36, claimId: "A15", claimValue: 55, claimLine: 35, quantity: 2, expected: "ECHO_MULTIPLICATIVE_OF_CLAIMED_VALUE" }, // vinho Branco
      { id: "A18", value: 20, line: 40, claimId: "A17", claimValue: 40, claimLine: 39, quantity: 2, expected: "ECHO_MULTIPLICATIVE_OF_CLAIMED_VALUE" }, // Lapas
      { id: "A20", value: 35, line: 44, claimId: "A19", claimValue: 70, claimLine: 43, quantity: 2, expected: "ECHO_MULTIPLICATIVE_OF_CLAIMED_VALUE" }, // Boca Negra
      { id: "A22", value: 25, line: 48, claimId: "A21", claimValue: 50, claimLine: 47, quantity: 2, expected: "ECHO_MULTIPLICATIVE_OF_CLAIMED_VALUE" }, // Cantaro
      { id: "A24", value: 20, line: 52, claimId: "A23", claimValue: 40, claimLine: 51, quantity: 2, expected: "ECHO_MULTIPLICATIVE_OF_CLAIMED_VALUE" }, // Espadarte
      { id: "A26", value: 2, line: 56, claimId: "A25", claimValue: 2, claimLine: 55, quantity: 1, expected: "ECHO_OF_CLAIMED_VALUE" }, // Agua c/ Gas
      { id: "A32", value: 1, line: 64, claimId: "A31", claimValue: 1, claimLine: 63, quantity: 1, expected: "ECHO_OF_CLAIMED_VALUE" }, // cafe
    ];
    for (const tc of cases) {
      const ledger: LedgerEntry[] = [
        entry({ amountId: tc.claimId, value: tc.claimValue, lineIndex: tc.claimLine }),
        entry({ amountId: tc.id, value: tc.value, lineIndex: tc.line }),
      ];
      // The candidate's OWN block is an empty sibling MODIFIER — exactly the
      // FIX 20 shape that used to block it — to prove territory truly no
      // longer matters, not just that a merged-territory shortcut exists.
      const blocks: StructureBlock[] = [
        { blockId: "ITEM", kind: "item", lineIndices: [tc.claimLine], parentBlockId: null, name: "item", amountId: tc.claimId, quantity: tc.quantity, priceKind: "lineTotal" },
        { blockId: "MOD", kind: "modifier", lineIndices: [tc.line], parentBlockId: "ITEM", name: null, amountId: null, quantity: null, priceKind: null },
      ];
      const assignments: Assignment[] = [
        { blockId: "ITEM", amountId: tc.claimId, quantity: tc.quantity, priceKind: "lineTotal" },
        { blockId: "MOD", amountId: null, quantity: null, priceKind: null },
      ];
      const itemsRegionEnd = computeItemsRegionEnd(blocks);
      const coverage = classifyCoverage(blocks, assignments, ledger, itemsRegionEnd);
      assertEqual(coverage.find((c) => c.amountId === tc.id)?.state, tc.expected, `${tc.id}: ${tc.value} vs claimed ${tc.claimValue} (qty=${tc.quantity}), own block claims nothing`);
    }
  });

  it("CF — the FINO case (2 lines from its claim) stays UNRESOLVED: FIX 21 replaced territory with adjacency, it did not widen adjacency", () => {
    const ledger: LedgerEntry[] = [
      entry({ amountId: "A13", value: 2.5, lineIndex: 31 }), // FINO's real claim
      entry({ amountId: "A12", value: 2.0, lineIndex: 29 }), // "1 Uni FINO 2.00" — 2 lines away, not 1
    ];
    const blocks: StructureBlock[] = [
      { blockId: "b19", kind: "item", lineIndices: [29, 30, 31], parentBlockId: null, name: "FINO", amountId: "A13", quantity: 1, priceKind: "lineTotal" },
    ];
    const assignments: Assignment[] = [{ blockId: "b19", amountId: "A13", quantity: 1, priceKind: "lineTotal" }];
    const itemsRegionEnd = computeItemsRegionEnd(blocks);
    const coverage = classifyCoverage(blocks, assignments, ledger, itemsRegionEnd);
    assertEqual(coverage.find((c) => c.amountId === "A12")?.state, "UNRESOLVED", "2 lines away from the only claim in this fixture — adjacency was never widened past same-or-immediately-adjacent");
    const validity = determineValidity(findStructuralGaps(blocks, ledger, itemsRegionEnd), coverage, findDuplicateOwnership(assignments), [], true);
    assertEqual(validity.unresolvedLoadBearingCount, 1);
    assertEqual(validity.valid, false);
  });

  it("CG — adjacent to a claim, but the arithmetic does not close → stays UNRESOLVED (fails closed, not open)", () => {
    const ledger: LedgerEntry[] = [
      entry({ amountId: "A4", value: 5.25, lineIndex: 15 }),
      entry({ amountId: "A5", value: 1.8, lineIndex: 16 }), // adjacent, but 1.80*3=5.40 != 5.25, and 1.80 != 5.25
    ];
    const blocks: StructureBlock[] = [
      { blockId: "b11", kind: "item", lineIndices: [15], parentBlockId: null, name: "SAFATA DE PAO", amountId: "A4", quantity: 3, priceKind: "lineTotal" },
    ];
    const assignments: Assignment[] = [{ blockId: "b11", amountId: "A4", quantity: 3, priceKind: "lineTotal" }];
    const itemsRegionEnd = computeItemsRegionEnd(blocks);
    const coverage = classifyCoverage(blocks, assignments, ledger, itemsRegionEnd);
    assertEqual(coverage.find((c) => c.amountId === "A5")?.state, "UNRESOLVED", "adjacency alone is never sufficient — the arithmetic still has to close exactly");
    const validity = determineValidity(findStructuralGaps(blocks, ledger, itemsRegionEnd), coverage, findDuplicateOwnership(assignments), [], true);
    assertEqual(validity.unresolvedLoadBearingCount, 1);
    assertEqual(validity.valid, false);
  });

  it("CH — Mad God real data: no candidate pairs with a DIFFERENT item's claim under the territory-free rule (negative result, verified not assumed)", () => {
    // Investigated directly against fix20-corpus-madgod-run3.debug.json's
    // real ledger/blocks (the corpus's most repeated-value-dense receipt:
    // Truffle x3 @16.95, Kids x3 @12.50, several others). Reconstructed
    // here as a minimal reproduction of the actual risk shape: two
    // same-valued real item claims close enough together that a candidate
    // between them could be ambiguous. The real receipt's closest pair of
    // same-valued claims (12.50, blocks b32/b37) sits 7 lines apart —
    // never within the <=1 adjacency window — so this constructs a
    // DELIBERATELY closer pair than anything observed in the real corpus,
    // to test the boundary directly rather than merely confirm the corpus
    // is currently silent on it.
    const ledger: LedgerEntry[] = [
      entry({ amountId: "T1", value: 16.95, lineIndex: 10 }), // Truffle #1
      entry({ amountId: "X", value: 16.95, lineIndex: 11 }), // candidate exactly between two same-valued claims
      entry({ amountId: "T2", value: 16.95, lineIndex: 12 }), // Truffle #2 — deliberately 1 line from X on BOTH sides, closer than any real pair
    ];
    const blocks: StructureBlock[] = [
      { blockId: "T1", kind: "item", lineIndices: [10], parentBlockId: null, name: "Truffle", amountId: "T1", quantity: 1, priceKind: "lineTotal" },
      { blockId: "T2", kind: "item", lineIndices: [12], parentBlockId: null, name: "Truffle", amountId: "T2", quantity: 1, priceKind: "lineTotal" },
    ];
    const assignments: Assignment[] = [
      { blockId: "T1", amountId: "T1", quantity: 1, priceKind: "lineTotal" },
      { blockId: "T2", amountId: "T2", quantity: 1, priceKind: "lineTotal" },
    ];
    const itemsRegionEnd = computeItemsRegionEnd(blocks);
    const coverage = classifyCoverage(blocks, assignments, ledger, itemsRegionEnd);
    const resolved = coverage.find((c) => c.amountId === "X");
    // This is the ambiguity the user asked to have checked directly: X
    // matches BOTH T1 and T2 equally (findEchoOwner returns the FIRST
    // match in claims-array order, which follows block declaration order
    // — T1 here). Reported as observed, not silently guarded against: a
    // genuinely ambiguous adjacency (equidistant, same value, two DIFFERENT
    // real items) resolves to the block declared first, which is NOT
    // provably the "correct" one from position alone.
    assertEqual(resolved?.state, "ECHO_OF_CLAIMED_VALUE", "X does resolve — the risk is not that it stays UNRESOLVED, it's that its claimedByBlockId may not be the right item");
    assertEqual(resolved?.claimedByBlockId, "T1", "picks the first-declared block among two equally-adjacent, equally-valued claims — order-dependent, not a real disambiguation; see the FIX 21 report for why this was reported rather than silently guarded");
  });

  it("CI — Pai-shaped negative control: a REAL, uncounted charge adjacent to an item, whose value does NOT satisfy any exact or multiplicative relationship, stays UNRESOLVED and keeps blocking validity", () => {
    const ledger: LedgerEntry[] = [
      entry({ amountId: "A1", value: 12.0, lineIndex: 30 }), // the item's claimed price
      entry({ amountId: "A2", value: 2.5, lineIndex: 31 }), // real, uncounted "extra topping" charge — no arithmetic relationship to 12.00 at all
    ];
    const blocks: StructureBlock[] = [
      { blockId: "ITEM", kind: "item", lineIndices: [30, 31], parentBlockId: null, name: "Pizza", amountId: "A1", quantity: 1, priceKind: "lineTotal" },
    ];
    const assignments: Assignment[] = [{ blockId: "ITEM", amountId: "A1", quantity: 1, priceKind: "lineTotal" }];
    const itemsRegionEnd = computeItemsRegionEnd(blocks);
    const coverage = classifyCoverage(blocks, assignments, ledger, itemsRegionEnd);
    assertEqual(coverage.find((c) => c.amountId === "A2")?.state, "UNRESOLVED", "no exact or multiplicative relationship to the adjacent claim — a real charge must never be waved through on adjacency alone");
    const validity = determineValidity(findStructuralGaps(blocks, ledger, itemsRegionEnd), coverage, findDuplicateOwnership(assignments), [], true);
    assertEqual(validity.unresolvedLoadBearingCount, 1);
    assertEqual(validity.valid, false, "the genuine miss must keep blocking validity");
  });

  it("CJ — a value outside any items region, adjacent to nothing claimed, stays UNRESOLVED", () => {
    const ledger: LedgerEntry[] = [entry({ amountId: "A1", value: 5.0, lineIndex: 10 })];
    const blocks: StructureBlock[] = []; // no claims anywhere
    const assignments: Assignment[] = [];
    const itemsRegionEnd = computeItemsRegionEnd(blocks); // Infinity — no summary block, whole doc is items region
    const coverage = classifyCoverage(blocks, assignments, ledger, itemsRegionEnd);
    assertEqual(coverage.find((c) => c.amountId === "A1")?.state, "UNRESOLVED", "no claim exists anywhere, adjacent or not");
    const validity = determineValidity(findStructuralGaps(blocks, ledger, itemsRegionEnd), coverage, findDuplicateOwnership(assignments), [], true);
    assertEqual(validity.unresolvedLoadBearingCount, 1);
    assertEqual(validity.valid, false);
  });

});
