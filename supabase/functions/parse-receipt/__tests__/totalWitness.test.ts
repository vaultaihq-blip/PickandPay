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
  const ocr = normalizeVisionResponse(raw, { geometricReconstruction: true });
  const ledger = buildLedgerFromOcr(ocr.lines);
  return { ocr, ledger };
}

/** FIX 40 — the summary region's start line, found by real printed content
 *  rather than a hardcoded lineIndex — line numbers shift whenever line
 *  reconstruction changes (FIX 39's own geometric path consolidates many of
 *  these fixtures' lines). Throws loudly if the marker is missing, rather
 *  than silently returning 0 and testing a subtly different scenario. */
function summaryRegionStartAt(ocr: { lines: OcrLine[] }, marker: string): number {
  const line = ocr.lines.find((l) => l.text.includes(marker));
  if (!line) throw new Error(`no line contains "${marker}"`);
  return line.lineIndex;
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
    const witness = findTotalLabelWitness(ocr.lines, ledger, summaryRegionStartAt(ocr, "TOTAL LEVAR"));
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
  it("DT — Mad God real fixture: under geometric reconstruction (FIX 42, now the default) the label sits on the SAME line as the value, so the label mechanism resolves it directly — no typographic fallback needed", () => {
    // Legacy reconstruction: "Total liq." sat 3 lines from its value (out
    // of the label mechanism's ≤2-line window), so only the typographic
    // witness (the tallest text in the region) could resolve it.
    //
    // FIX 42: measured directly (scripts/_fix42-inspect-cz-dt.ts, deleted
    // after use) — geometric reconstruction now prints "Total liq . 363,55
    // e" as ONE line. The label mechanism finds its value on the same
    // line it starts from (distance 0, well inside the window) without
    // needing the height-based fallback at all. This is a genuine
    // improvement from reconstruction, not a mechanism change in
    // totalWitness.ts itself — untouched this round.
    const { ocr, ledger } = loadRealFixture("vision-madgod-pt.json");
    const summaryRegionStart = summaryRegionStartAt(ocr, "Total liq");
    const labelWitness = findTotalLabelWitness(ocr.lines, ledger, summaryRegionStart);
    assert(labelWitness !== null && labelWitness !== "AMBIGUOUS", "the label now shares a line with its value, well inside the ≤2 window");
    if (labelWitness && labelWitness !== "AMBIGUOUS") assertEqual(labelWitness.value, 363.55);
    const typoWitness = findTotalTypographicWitness(ocr.lines, ledger, summaryRegionStart);
    assert(typoWitness !== null, "typography still resolves it too — the two witnesses agree, they are not in conflict");
    if (typoWitness) assertEqual(typoWitness.value, 363.55);
    const combined = resolveTotalWitness(ocr.lines, ledger, summaryRegionStart);
    assert(combined !== null && combined.source === "label", "the label decides when it resolves at all — see DU's own header comment");
    if (combined) assertEqual(combined.value, 363.55);
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

// ─── FIX 37 Part 1 — position among total-shaped labels decides ────────────
//
// Real-fixture measurement (FIX 37's own report) found V&RO Bengaluru's own
// "Net Amount" (the true total, 5226.00) sits 8 lines from its printed
// value — far outside findTotalLabelWitness's own measured ≤2-line window
// (see docs/design/summary-region-orphan-pairing.md: a wider pairing
// mechanism was explored, measured safe, but never actually reaches this
// case, and was not implemented). FI/FJ below are therefore synthetic,
// V&RO-SHAPED constructions — same label text, same charges, same true
// total — with the label and its value close enough together for the
// EXISTING ≤2-line matching to find it, so what's actually under test is
// the NEW position rule itself, not the separately-documented OCR gap.

describe("totalWitness: FIX 37 Part 1 — position among total-shaped labels decides, never magnitude", () => {
  it("FI — V&RO-shaped: 'Total Amount' (a subtotal) and 'Net Amount' (the true total) disagree, with charges printed between them → the total is 5226, not 4525", () => {
    const lines: OcrLine[] = [
      makeLine(0, [makeWord("n0a", "Total", 0, 0), makeWord("n0b", "Amount", 60, 0), makeWord("v0", "4525.00", 300, 0)]),
      makeLine(1, [makeWord("n1", "SERC", 0, 20), makeWord("v1", "452.50", 300, 20)]),
      makeLine(2, [makeWord("n2a", "State", 0, 40), makeWord("n2b", "Gst", 60, 40), makeWord("v2", "124.49", 300, 40)]),
      makeLine(3, [makeWord("n3a", "Central", 0, 60), makeWord("n3b", "Gst", 60, 60), makeWord("v3", "124.49", 300, 60)]),
      makeLine(4, [makeWord("n4a", "Round", 0, 80), makeWord("n4b", "Off", 60, 80), makeWord("v4", "-0.48", 300, 80)]),
      makeLine(5, [makeWord("n5a", "Net", 0, 100), makeWord("n5b", "Amount", 60, 100), makeWord("v5", "5226.00", 300, 100)]),
    ];
    const ledger = buildLedgerFromOcr(lines);
    const witness = findTotalLabelWitness(lines, ledger, 0);
    assert(witness !== null && witness !== "AMBIGUOUS", "the position rule must resolve this outright, never refuse when charges genuinely separate the two candidates");
    if (witness && witness !== "AMBIGUOUS") {
      assertEqual(witness.value, 5226, "Net Amount, printed after the charges, is the true total — Total Amount is only the pre-tax subtotal");
    }
  });

  it("FK — Augustiner-shaped: 'Total' and 'Bar' agree on the same value, nothing between them but VAT breakdown lines → no ambiguity", () => {
    const { ocr, ledger } = loadRealFixture("vision-augustiner-de.json");
    const witness = findTotalLabelWitness(ocr.lines, ledger, 21);
    assert(witness !== null && witness !== "AMBIGUOUS", "two agreeing labels, even with unrelated VAT-breakdown lines between them, must never read as ambiguous");
    if (witness && witness !== "AMBIGUOUS") assertEqual(witness.value, 96.5);
  });

  it("FL — Sulbarreiro-shaped: 'TOTAL LEVAR' and a payment-terminal echo agree on the same value → no ambiguity", () => {
    const lines: OcrLine[] = [
      makeLine(0, [makeWord("n0", "TOTAL", 0, 0), makeWord("v0", "8.25", 300, 0)]),
      makeLine(1, [makeWord("n1", "Multibanco", 0, 20), makeWord("v1", "8.25", 300, 20)]),
    ];
    const ledger = buildLedgerFromOcr(lines);
    const witness = findTotalLabelWitness(lines, ledger, 0);
    assert(witness !== null && witness !== "AMBIGUOUS", "the total label and its payment-terminal echo agree — never ambiguous");
    if (witness && witness !== "AMBIGUOUS") assertEqual(witness.value, 8.25);
  });

  it("FM — two total-shaped labels with DIFFERENT values and nothing between them: genuinely ambiguous, nothing chosen (never 'the bigger one' — that is the FIX 29/BQ discount trap)", () => {
    const lines: OcrLine[] = [
      makeLine(0, [makeWord("n0", "Total", 0, 0), makeWord("v0", "100.00", 300, 0)]),
      makeLine(1, [makeWord("n1", "Amount", 0, 20), makeWord("n1b", "Due", 60, 20), makeWord("v1", "80.00", 300, 20)]),
    ];
    const ledger = buildLedgerFromOcr(lines);
    const witness = findTotalLabelWitness(lines, ledger, 0);
    assertEqual(witness, "AMBIGUOUS", "different values, nothing between them to arbitrate — must refuse rather than guess either way");
  });
});
