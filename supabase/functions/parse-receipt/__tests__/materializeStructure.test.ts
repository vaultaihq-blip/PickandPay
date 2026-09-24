import { describe, it, assert, assertEqual } from "./harness";
import { materializeStructure } from "../materializeStructure";
import type { StructureBlock } from "../schema";
import type { LedgerEntry } from "../ledger";
import type { OcrLine } from "../ocr";

function entry(amountId: string, value: number, lineIndex: number, rawText?: string): LedgerEntry {
  return {
    amountId,
    wordId: `W_${amountId}`,
    rawText: rawText ?? value.toFixed(2),
    value,
    lineIndex,
    boundingBox: { vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] },
    ocrConfidence: 0.99,
    source: "ocr",
  };
}
function line(lineIndex: number, text: string): OcrLine {
  return { lineIndex, text, words: [] };
}

describe("materializeStructure: FY — the flag-off path is a pure, deterministic function", () => {
  it("calling materializeStructure twice with IDENTICAL blocks produces byte-identical output — the single-read (flag off) path never introduces its own variance", () => {
    const ledger: LedgerEntry[] = [
      entry("A1", 23.75, 0),
      entry("A2", 45.0, 1),
      entry("A3", 68.75, 2),
    ];
    const ocrLines: OcrLine[] = [line(0, "Khao Soi 23.75"), line(1, "Singha 45.00"), line(2, "Total 68.75")];
    const blocks: StructureBlock[] = [
      { blockId: "b1", kind: "item", lineIndices: [0], parentBlockId: null, name: "Khao Soi", amountId: "A1", quantity: 1, priceKind: "lineTotal" },
      { blockId: "b2", kind: "item", lineIndices: [1], parentBlockId: null, name: "Singha", amountId: "A2", quantity: 1, priceKind: "lineTotal" },
      { blockId: "b3", kind: "summary", lineIndices: [2], parentBlockId: null, name: "Total", amountId: "A3", quantity: null, priceKind: null },
    ];

    // Two independent calls, two independent (structurally identical)
    // block arrays — mirrors how the double-read path would call this
    // twice on two GPT reads that happened to agree, and how the SINGLE
    // existing call site (flag off) has always called this exact sequence.
    const blocksCopy1: StructureBlock[] = blocks.map((b) => ({ ...b }));
    const blocksCopy2: StructureBlock[] = blocks.map((b) => ({ ...b }));

    const resultA = materializeStructure(blocksCopy1, ledger, ledger, ocrLines, ocrLines.map((l) => l.text), null, "USD", 2, null);
    const resultB = materializeStructure(blocksCopy2, ledger, ledger, ocrLines, ocrLines.map((l) => l.text), null, "USD", 2, null);

    assertEqual(JSON.stringify(resultA.assembled.payload), JSON.stringify(resultB.assembled.payload), "identical inputs must produce byte-identical payloads");
    assertEqual(resultA.assembled.payload.printedTotal, 68.75);
    assertEqual(resultA.offsetHypothesisAdopted, resultB.offsetHypothesisAdopted);
    assert(resultA.validations.length === resultB.validations.length, "validation count must match");
  });
});
