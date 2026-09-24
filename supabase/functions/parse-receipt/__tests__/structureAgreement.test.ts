import { describe, it, assert, assertEqual } from "./harness";
import { extractComparableStructure, findStructureDisagreements, structuresAgree } from "../structureAgreement";
import type { StructureBlock } from "../schema";
import type { SummaryRoleAssignment } from "../coverage";

function item(blockId: string, name: string, quantity: number, amountId: string | null): StructureBlock {
  return { blockId, kind: "item", lineIndices: [0], parentBlockId: null, name, amountId, quantity, priceKind: null };
}
function modifier(blockId: string, parentBlockId: string, amountId: string | null): StructureBlock {
  return { blockId, kind: "modifier", lineIndices: [0], parentBlockId, name: null, amountId, quantity: null, priceKind: null };
}
function role(role: string, amountId: string): SummaryRoleAssignment {
  return { role: role as SummaryRoleAssignment["role"], amountId };
}

describe("structureAgreement: FV — two identical structures agree", () => {
  it("same items, same modifiers, same roles, same totals -> agree, even with different blockIds and block order", () => {
    const blocksA: StructureBlock[] = [
      item("b1", "Khao Soi", 1, "A1"),
      modifier("b2", "b1", "A2"),
      item("b3", "Singha", 2, "A3"),
    ];
    // Same semantic content, DIFFERENT blockIds and DIFFERENT order —
    // exactly what a second, independently-numbered GPT call would produce.
    const blocksB: StructureBlock[] = [
      item("x9", "Singha", 2, "A3"),
      item("x1", "Khao Soi", 1, "A1"),
      modifier("x2", "x1", "A2"),
    ];
    const rolesA: SummaryRoleAssignment[] = [role("GRAND_TOTAL", "A9")];
    const rolesB: SummaryRoleAssignment[] = [role("GRAND_TOTAL", "A9")];

    const a = extractComparableStructure(blocksA, rolesA, 50.85, 45.0);
    const b = extractComparableStructure(blocksB, rolesB, 50.85, 45.0);
    assert(structuresAgree(a, b), "identical semantic content must agree regardless of blockId or block order");
    assertEqual(findStructureDisagreements(a, b).length, 0);
  });
});

describe("structureAgreement: FW — same total, different items -> disagreement, ambiguous", () => {
  it("two structures reaching the same printedTotal by different item breakdowns must NOT agree", () => {
    const blocksA: StructureBlock[] = [item("b1", "Khao Soi", 1, "A1"), item("b2", "Singha", 1, "A2")];
    const blocksB: StructureBlock[] = [item("x1", "Pad Thai", 1, "A1"), item("x2", "Singha", 1, "A2")];
    const roles: SummaryRoleAssignment[] = [role("GRAND_TOTAL", "A9")];

    const a = extractComparableStructure(blocksA, roles, 50.85, null);
    const b = extractComparableStructure(blocksB, roles, 50.85, null);
    assert(!structuresAgree(a, b), "same total, different item names, must never read as agreement");
    const disagreements = findStructureDisagreements(a, b);
    assert(
      disagreements.some((d) => d.kind === "item"),
      "the divergence must be reported as an item-level disagreement"
    );
  });
});

describe("structureAgreement: FX — different block counts, same items/roles -> agree (the counter-test)", () => {
  it("extra unclassified/quantity blocks that never became items must not cause a false disagreement", () => {
    const blocksA: StructureBlock[] = [
      item("b1", "Khao Soi", 1, "A1"),
      { blockId: "b2", kind: "unclassified", lineIndices: [5], parentBlockId: null, name: null, amountId: null, quantity: null, priceKind: null },
    ];
    const blocksB: StructureBlock[] = [
      item("x1", "Khao Soi", 1, "A1"),
      { blockId: "x2", kind: "unclassified", lineIndices: [5], parentBlockId: null, name: null, amountId: null, quantity: null, priceKind: null },
      { blockId: "x3", kind: "quantity", lineIndices: [6], parentBlockId: null, name: null, amountId: null, quantity: 3, priceKind: null },
      { blockId: "x4", kind: "unclassified", lineIndices: [7], parentBlockId: null, name: null, amountId: null, quantity: null, priceKind: null },
    ];
    const roles: SummaryRoleAssignment[] = [role("GRAND_TOTAL", "A1")];

    const a = extractComparableStructure(blocksA, roles, 23.75, null);
    const b = extractComparableStructure(blocksB, roles, 23.75, null);
    assert(structuresAgree(a, b), "block count differs (2 vs 4), but the only item and the only role are identical — must agree");
  });

  it("a free/comp item with no price of its own gets its own block on one read but not the other -> still agree (real Ramires pattern, 'OFERTA')", () => {
    const blocksA: StructureBlock[] = [
      item("b1", "1 Uni Frango", 1, "A5"),
      item("b2", "OFERTA", 1, null), // this read gave the comp item its own block, no price to claim
    ];
    const blocksB: StructureBlock[] = [
      item("x1", "1 Uni Frango", 1, "A5"),
      // this read never formed a block for the comp item at all
    ];
    const roles: SummaryRoleAssignment[] = [role("GRAND_TOTAL", "A48")];

    const a = extractComparableStructure(blocksA, roles, 76.2, 76.2);
    const b = extractComparableStructure(blocksB, roles, 76.2, 76.2);
    assert(structuresAgree(a, b), "a priceless comp item's mere presence/absence as its own block has zero financial consequence — must not read as disagreement");
  });
});
