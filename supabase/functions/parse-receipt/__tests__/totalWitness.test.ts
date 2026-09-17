import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, assert, assertEqual } from "./harness";
import type { OcrLine, OcrWord, BoundingBox } from "../ocr";
import { normalizeVisionResponse } from "../ocr";
import type { LedgerEntry } from "../ledger";
import { buildLedgerFromOcr } from "../ledger";
import { findTotalLabelWitness, findTotalTypographicWitness, resolveTotalWitness } from "../totalWitness";
import { validateAssignments, buildFinalPayload } from "../validate";
import { computeItemsRegionEnd } from "../coverage";
import { assignmentsFromBlocks, type StructureBlock } from "../schema";

// ─── Fixture builders — same pattern as ownership.test.ts ──────────────────

function box(x: number, y: number, w = 20, h = 10): BoundingBox {
  return { vertices: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }] };
}
function makeWord(id: string, text: string, x: number, y: number, height = 10): OcrWord {
  return { wordId: id, text, boundingBox: box(x, y, 20, height), confidence: 0.99, lineIndex: -1, breakType: null };
}
function makeLine(lineIndex: number, words: OcrWord[]): OcrLine {
  let text = "";
  const wordOffsets: OcrLine["words"] = [];
  for (const w of words) {
    if (text.length > 0) text += " ";
    const start = text.length;
    text += w.text;
    wordOffsets.push({ word: w, start, end: text.length });
  }
  return { lineIndex, text, words: wordOffsets };
}

function loadRealFixture(filename: string) {
  const raw = JSON.parse(
    readFileSync(join(process.cwd(), `supabase/functions/parse-receipt/__fixtures__/${filename}`), "utf-8")
  );
  const ocr = normalizeVisionResponse(raw);
  const ledger = buildLedgerFromOcr(ocr.lines);
  return { ocr, ledger };
}

describe("totalWitness: FIX 31 — Step 1 (blocking) — the discount scenario that killed FIX 29", () => {
  it("DP — ordinary discount receipt (Subtotal 100,00 / Desconto -20,00 / Total 80,00): the label identifies 80, never 100", () => {
    const lines: OcrLine[] = [
      makeLine(0, [makeWord("n1", "Subtotal", 0, 0), makeWord("v1", "100,00", 300, 0)]),
      makeLine(1, [makeWord("n2", "Desconto", 0, 20), makeWord("v2", "-20,00", 300, 20)]),
      makeLine(2, [makeWord("n3", "Total", 0, 40), makeWord("v3", "80,00", 300, 40)]),
    ];
    const ledger = buildLedgerFromOcr(lines);
    const witness = findTotalLabelWitness(lines, ledger, 0);
    assert(witness !== null && witness !== "AMBIGUOUS", "must find a single, unambiguous label match");
    if (witness && witness !== "AMBIGUOUS") {
      assertEqual(witness.value, 80, "the total is the SMALLER value here — the exact shape that killed FIX 29's magnitude-based guard");
    }
  });

  it("DQ — parenthesized discount (Subtotal 100.00 / Discount (20.00) / Total 80.00): same result", () => {
    const lines: OcrLine[] = [
      makeLine(0, [makeWord("n1", "Subtotal", 0, 0), makeWord("v1", "100.00", 300, 0)]),
      makeLine(1, [makeWord("n2", "Discount", 0, 20), makeWord("v2", "(20.00)", 300, 20)]),
      makeLine(2, [makeWord("n3", "Total", 0, 40), makeWord("v3", "80.00", 300, 40)]),
    ];
    const ledger = buildLedgerFromOcr(lines);
    const witness = findTotalLabelWitness(lines, ledger, 0);
    assert(witness !== null && witness !== "AMBIGUOUS");
    if (witness && witness !== "AMBIGUOUS") {
      assertEqual(witness.value, 80, "parseAmbiguousNumber's own parenthesis-negative support carries through unchanged");
    }
  });
});

describe("totalWitness: FIX 31 — label witness (raw OCR text, never GPT's own block name)", () => {
  it("DR — Sulbarreiro real fixture: 'TOTAL LEVAR' is chosen, 'Total Liquido' is excluded", () => {
    const { ocr, ledger } = loadRealFixture("vision-sulbarreiro-pt.json");
    const witness = findTotalLabelWitness(ocr.lines, ledger, 46);
    assert(witness !== null && witness !== "AMBIGUOUS");
    if (witness && witness !== "AMBIGUOUS") {
      assertEqual(witness.value, 8.25, "TOTAL LEVAR (8.25), never Total Liquido (7.21) — the net-not-paid figure");
    }
  });

  it("DS — Augustiner real fixture: 'Total' and 'Bar' both point to 96,50 — agreeing confirmation, not ambiguity", () => {
    const { ocr, ledger } = loadRealFixture("vision-augustiner-de.json");
    const witness = findTotalLabelWitness(ocr.lines, ledger, 21);
    assert(witness !== null && witness !== "AMBIGUOUS", "two labels agreeing on the SAME value must never read as ambiguous");
    if (witness && witness !== "AMBIGUOUS") {
      assertEqual(witness.value, 96.5);
    }
  });
});

describe("totalWitness: FIX 31 — typographic witness (rotation-corrected height)", () => {
  it("DT — Mad God real fixture: the label is 3 lines away (out of the ≤2 window, correctly finds nothing), typography resolves it alone", () => {
    const { ocr, ledger } = loadRealFixture("vision-madgod-pt.json");
    const labelWitness = findTotalLabelWitness(ocr.lines, ledger, 119);
    assertEqual(labelWitness, null, "the real label ('Total liq.') sits 3 lines from the value — outside the measured ≤2 window, and must not reach further to grab it");
    const typoWitness = findTotalTypographicWitness(ocr.lines, ledger, 119);
    assert(typoWitness !== null, "typography must resolve this alone");
    if (typoWitness) assertEqual(typoWitness.value, 363.55);
    const combined = resolveTotalWitness(ocr.lines, ledger, 119);
    assert(combined !== null && combined.source === "typography");
  });
});

describe("totalWitness: FIX 31 — combined verdict and buildFinalPayload wiring", () => {
  it("DU — label and typography point to different values: the label still decides (measured more reliable — see totalWitness.ts's header), never silently averaged or blocked", () => {
    // Deliberately built so the tallest line in the region is NOT the
    // labelled total — Pai's real shape ('Large Party (20.00%) $55.60'
    // prints taller than 'Total $376.97'), reproduced synthetically here so
    // the assertion is exact rather than tied to a live photo's exact px.
    const lines: OcrLine[] = [
      makeLine(0, [makeWord("n1", "Big Charge", 0, 0, 30), makeWord("v1", "55.60", 300, 0, 30)]), // tall, but NOT a total label
      makeLine(1, [makeWord("n2", "Total", 0, 30, 10), makeWord("v2", "80.00", 300, 30, 10)]), // short, but the real label
    ];
    const ledger = buildLedgerFromOcr(lines);
    const label = findTotalLabelWitness(lines, ledger, 0);
    const typo = findTotalTypographicWitness(lines, ledger, 0);
    assert(label !== null && label !== "AMBIGUOUS");
    assert(typo !== null);
    if (label !== null && label !== "AMBIGUOUS" && typo !== null) {
      assert(label.value !== typo.value, "the two witnesses must genuinely disagree for this test to mean anything");
    }
    const combined = resolveTotalWitness(lines, ledger, 0);
    assert(combined !== null && combined.source === "label" && combined.agreement === "disagree");
    if (combined) assertEqual(combined.value, 80, "label decides outright — typography's disagreement is recorded, never a veto");
  });

  it("DV — neither witness available: buildFinalPayload's pre-FIX-31 behavior is unchanged", () => {
    const lines: OcrLine[] = [makeLine(0, [makeWord("v1", "45.00", 300, 0)])]; // a bare value, no label, no distinguishing height
    const ledger = buildLedgerFromOcr(lines);
    const combined = resolveTotalWitness(lines, ledger, 0);
    assertEqual(combined, null, "no label pattern anywhere, and a single line can't produce a typographic ranking with a second line to compare against — must stay silent, not guess");
  });

  it("buildFinalPayload: omitting the totalWitness parameter entirely reproduces pre-FIX-31 behavior exactly (backward compatibility)", () => {
    const ledger: LedgerEntry[] = [
      { amountId: "I1", wordId: "w1", rawText: "45.00", value: 45, lineIndex: 1, boundingBox: box(0, 0), ocrConfidence: 0.95, source: "ocr" },
      { amountId: "A1", wordId: "w2", rawText: "45.00", value: 45, lineIndex: 5, boundingBox: box(0, 50), ocrConfidence: 0.95, source: "ocr" },
    ];
    const blocks: StructureBlock[] = [
      { blockId: "ITEM", kind: "item", lineIndices: [1], parentBlockId: null, name: "Widget", amountId: "I1", quantity: 1, priceKind: "unit" },
      { blockId: "SUM", kind: "summary", lineIndices: [5], parentBlockId: null, name: null, amountId: "A1", quantity: null, priceKind: null },
    ];
    const assignments = assignmentsFromBlocks(blocks);
    const validations = validateAssignments(blocks, assignments, ledger);
    const assembled = buildFinalPayload(null, "CAD", [], blocks, validations, ledger); // no 7th argument at all
    assertEqual(assembled.payload.printedTotal, 45);
    assertEqual(assembled.totalWitness, null);
  });
});
