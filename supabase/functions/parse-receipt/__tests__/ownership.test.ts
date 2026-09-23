import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, assert, assertEqual } from "./harness";
import { computeGeometricOwnership, detectConstantOffsetRuns, type PriceBlockInput } from "../ownership";
import type { LedgerEntry } from "../ledger";
import { buildLedgerFromOcr } from "../ledger";
import type { OcrLine, OcrWord, BoundingBox } from "../ocr";
import { normalizeVisionResponse } from "../ocr";
import { computeItemsRegionEnd } from "../coverage";
import { validateAssignments, buildFinalPayload } from "../validate";
import { reconcile, toMinor } from "../reconcile";
import { assignmentsFromBlocks, type StructureBlock } from "../schema";

// ─── Fixture builders — plain upright (angle 0) geometry unless a test
// specifically needs drift, since rotation-independence is already covered
// by ocr.test.ts; these tests are about ownership logic layered on top of
// already-reconstructed lines. ────────────────────────────────────────────

function box(x: number, y: number, w = 20, h = 10): BoundingBox {
  return { vertices: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }] };
}
function makeWord(id: string, text: string, x: number, y: number): OcrWord {
  return { wordId: id, text, boundingBox: box(x, y), confidence: 0.99, lineIndex: -1, breakType: null };
}
function makeLine(lineIndex: number, words: OcrWord[]): OcrLine {
  let text = "";
  const wordOffsets: OcrLine["words"] = [];
  for (const w of words) {
    if (text.length > 0) text += " ";
    const start = text.length;
    text += w.text;
    w.lineIndex = lineIndex;
    wordOffsets.push({ word: w, start, end: text.length });
  }
  return { lineIndex, text, words: wordOffsets };
}
function nameLine(lineIndex: number, name: string, y: number): OcrLine {
  return makeLine(lineIndex, [makeWord(`n${lineIndex}`, name, 0, y)]);
}
function priceLine(lineIndex: number, value: number, y: number, x = 300): OcrLine {
  return makeLine(lineIndex, [makeWord(`p${lineIndex}`, value.toFixed(2), x, y)]);
}
function entry(amountId: string, value: number, lineIndex: number, y: number, x = 300, rawText?: string): LedgerEntry {
  return {
    amountId,
    wordId: `W_${amountId}`,
    rawText: rawText ?? value.toFixed(2),
    value,
    lineIndex,
    boundingBox: box(x, y),
    ocrConfidence: 0.99,
    source: "ocr",
  };
}
function itemBlock(blockId: string, lineIndex: number, name: string): PriceBlockInput {
  return { blockId, kind: "item", lineIndices: [lineIndex], name, parentBlockId: null, proposedAmountId: null };
}

describe("ownership: A — two consecutive name lines + two consecutive price observations", () => {
  it("matches monotonically: first name to first price, second name to second price", () => {
    const lines = [nameLine(0, "Alpha", 0), nameLine(1, "Beta", 20), priceLine(2, 10, 40), priceLine(3, 20, 60)];
    const ledger = [entry("A1", 10, 2, 40), entry("A2", 20, 3, 60)];
    const blocks = [itemBlock("bAlpha", 0, "Alpha"), itemBlock("bBeta", 1, "Beta")];
    const results = computeGeometricOwnership(blocks, ledger, lines);
    assertEqual(results.find((r) => r.blockId === "bAlpha")?.amountId, "A1");
    assertEqual(results.find((r) => r.blockId === "bBeta")?.amountId, "A2");
  });
});

describe("ownership: B — four consecutive name lines + four prices", () => {
  it("matches all four monotonically, no crossing", () => {
    // Seeds three same-line pairs first — the block's own claimed line
    // directly carries a decimal-formatted ledger entry, exactly like the
    // bare-integer test's single-word same-line case, so wordsNormalY for
    // these warm-up anchors is computed on the same basis (name word only)
    // as the later single-word item lines below, rather than being biased
    // by averaging in a second, merged price word. fitDrift requires at
    // least 3 points before it trusts a fit (2 points would fit *any* line
    // exactly, including noise; a meaningful residual/stddev for FIX 7.2
    // needs 3+), so the warm-up region must supply that many.
    const lines: OcrLine[] = [nameLine(0, "Warmup1", 0), nameLine(1, "Warmup2", 20), nameLine(2, "Warmup3", 40)];
    const blocks: PriceBlockInput[] = [
      { blockId: "bWarmup1", kind: "item", lineIndices: [0], name: "Warmup1", parentBlockId: null, proposedAmountId: null },
      { blockId: "bWarmup2", kind: "item", lineIndices: [1], name: "Warmup2", parentBlockId: null, proposedAmountId: null },
      { blockId: "bWarmup3", kind: "item", lineIndices: [2], name: "Warmup3", parentBlockId: null, proposedAmountId: null },
    ];
    const ledger: LedgerEntry[] = [entry("AW1", 5, 0, 80), entry("AW2", 6, 1, 100), entry("AW3", 7, 2, 120)];

    const names = ["Alpha", "Beta", "Gamma", "Delta"];
    names.forEach((n, i) => {
      lines.push(nameLine(3 + i, n, i * 20));
      blocks.push(itemBlock(`b${n}`, 3 + i, n));
    });
    names.forEach((_, i) => {
      const lineIndex = 7 + i;
      // Same ~80-unit offset the warm-up pairs established, so the actual
      // residual after drift correction stays small regardless of the raw
      // distance's absolute size.
      lines.push(priceLine(lineIndex, (i + 1) * 10, 80 + i * 20));
      ledger.push(entry(`A${i}`, (i + 1) * 10, lineIndex, 80 + i * 20));
    });

    const results = computeGeometricOwnership(blocks, ledger, lines);
    names.forEach((n, i) => {
      assertEqual(results.find((r) => r.blockId === `b${n}`)?.amountId, `A${i}`, `${n} must match its own price in order`);
    });
  });
});

describe("ownership: C — identical repeated prices stay distinct occurrences", () => {
  it("two items both priced 5.00 each keep their own distinct ledger occurrence", () => {
    const lines = [nameLine(0, "Coffee", 0), nameLine(1, "Tea", 20), priceLine(2, 5, 40), priceLine(3, 5, 60)];
    const ledger = [entry("A1", 5, 2, 40), entry("A2", 5, 3, 60)];
    const blocks = [itemBlock("bCoffee", 0, "Coffee"), itemBlock("bTea", 1, "Tea")];
    const results = computeGeometricOwnership(blocks, ledger, lines);
    const coffeeId = results.find((r) => r.blockId === "bCoffee")?.amountId;
    const teaId = results.find((r) => r.blockId === "bTea")?.amountId;
    assert(coffeeId !== null && teaId !== null && coffeeId !== teaId, "each item must own its own physical occurrence, never share one");
    assertEqual(coffeeId, "A1");
    assertEqual(teaId, "A2");
  });
});

describe("ownership: D — identical repeated item names each get their own nearby price", () => {
  it("two 'Khao Soi' instances at different positions each match their own nearest price", () => {
    const lines = [
      nameLine(0, "KhaoSoi", 0),
      priceLine(1, 23.75, 20),
      nameLine(2, "KhaoSoi", 200),
      priceLine(3, 23.75, 220),
    ];
    const ledger = [entry("A1", 23.75, 1, 20), entry("A2", 23.75, 3, 220)];
    const blocks = [itemBlock("bKS1", 0, "KhaoSoi"), itemBlock("bKS2", 2, "KhaoSoi")];
    const results = computeGeometricOwnership(blocks, ledger, lines);
    assertEqual(results.find((r) => r.blockId === "bKS1")?.amountId, "A1");
    assertEqual(results.find((r) => r.blockId === "bKS2")?.amountId, "A2");
  });
});

describe("ownership: E — a price missing between several items", () => {
  it("items A and C match their real, nearby prices; B (genuinely priceless, and far from both) is left unmatched", () => {
    const lines = [
      nameLine(0, "A", 0),
      nameLine(1, "B", 200),
      nameLine(2, "C", 400),
      priceLine(3, 10, 5), // right next to A
      priceLine(4, 30, 405), // right next to C
    ];
    const ledger = [entry("P1", 10, 3, 5), entry("P2", 30, 4, 405)];
    const blocks = [itemBlock("bA", 0, "A"), itemBlock("bB", 1, "B"), itemBlock("bC", 2, "C")];
    const results = computeGeometricOwnership(blocks, ledger, lines);
    assertEqual(results.find((r) => r.blockId === "bA")?.amountId, "P1");
    assertEqual(results.find((r) => r.blockId === "bC")?.amountId, "P2");
    assertEqual(results.find((r) => r.blockId === "bB")?.amountId, null, "B must not steal A's or C's price just because it has none of its own");
  });
});

describe("ownership: bare-integer false positive on a block's own claimed line", () => {
  it("does not grab a same-line bare integer (e.g. a size marker like '10') as a modifier's price when the real decimal price is on the very next line", () => {
    // Mirrors the real fixture exactly: "1 Thai Chicken Wings $13.50" then
    // an isolated "10" (a size marker OCR's bare-integer rule can still
    // admit to the ledger) then "$10.50" (the modifier's real price).
    const lines = [nameLine(0, "10", 0), priceLine(1, 10.5, 20)];
    const ledger = [entry("A1", 10, 0, 0, 0, "10"), entry("A2", 10.5, 1, 20)];
    const blocks: PriceBlockInput[] = [{ blockId: "bModifier", kind: "modifier", lineIndices: [0], name: null, proposedAmountId: "A1" }];
    const results = computeGeometricOwnership(blocks, ledger, lines);
    assertEqual(results[0].amountId, "A2", "must skip the bare-integer same-line entry and find the real decimal price instead");
  });
});

describe("ownership: F — an extra monetary observation among several items", () => {
  it("two items match correctly; the extra observation is left as an unclaimed orphan", () => {
    const lines = [nameLine(0, "A", 0), nameLine(1, "B", 20), priceLine(2, 10, 40), priceLine(3, 20, 60), priceLine(4, 999, 1000)];
    const ledger = [entry("P1", 10, 2, 40), entry("P2", 20, 3, 60), entry("P3", 999, 4, 1000)];
    const blocks = [itemBlock("bA", 0, "A"), itemBlock("bB", 1, "B")];
    const results = computeGeometricOwnership(blocks, ledger, lines);
    assertEqual(results.find((r) => r.blockId === "bA")?.amountId, "P1");
    assertEqual(results.find((r) => r.blockId === "bB")?.amountId, "P2");
    // P3 is simply never referenced by any result — buildFinalPayload's
    // orphan surfacing (tested elsewhere) is what keeps it from vanishing.
  });
});

describe("ownership: G — progressive drift (not uniform skew)", () => {
  it("keeps correct pairing even though the name/price gap grows well past half a line height by the end", () => {
    // Mirrors the real fixture: gap grows roughly linearly with position.
    // Line height here is 10 (box height); by item 8 the gap (45) is well
    // over 4x a line height — a fixed-tolerance approach would fail this.
    const lines: OcrLine[] = [];
    const blocks: PriceBlockInput[] = [];
    const ledger: LedgerEntry[] = [];
    const n = 9;
    for (let i = 0; i < n; i++) {
      const nameY = i * 100;
      const gap = i * 5; // progressive drift: 0, 5, 10, ..., 40
      lines.push(nameLine(i * 2, `Item${i}`, nameY));
      lines.push(priceLine(i * 2 + 1, (i + 1) * 10, nameY + gap));
      ledger.push(entry(`A${i}`, (i + 1) * 10, i * 2 + 1, nameY + gap));
      blocks.push(itemBlock(`b${i}`, i * 2, `Item${i}`));
    }
    const results = computeGeometricOwnership(blocks, ledger, lines);
    for (let i = 0; i < n; i++) {
      assertEqual(results.find((r) => r.blockId === `b${i}`)?.amountId, `A${i}`, `item ${i} must match its own drifted price`);
    }
  });
});

describe("ownership: H — genuinely ambiguous candidates are never guessed", () => {
  it("two equally-plausible candidates for one block => not confident, no silent pick", () => {
    // Both candidates sit at almost exactly the same predicted distance —
    // well within the ambiguity margin of each other.
    const lines = [nameLine(0, "Mystery", 0), priceLine(1, 10, 100), priceLine(2, 20, 101)];
    const ledger = [entry("A1", 10, 1, 100), entry("A2", 20, 2, 101)];
    const blocks = [itemBlock("bMystery", 0, "Mystery")];
    const results = computeGeometricOwnership(blocks, ledger, lines);
    const result = results.find((r) => r.blockId === "bMystery")!;
    assertEqual(result.confident, false, "two near-equidistant candidates must not be silently resolved");
  });
});

describe("ownership: I — invalid/nonexistent line reference is corrected, not trusted", () => {
  it("a block whose claimed line doesn't contain its own name gets corrected by text search", () => {
    // Mirrors the real run1 bug: the block claims a line that is actually
    // a bare price with no relation to the block's name.
    const lines = [
      nameLine(0, "Lowry", 0),
      makeLine(1, [makeWord("junk", "24.25", 300, 20)]), // an unrelated bare price, wrongly "claimed"
    ];
    const ledger = [entry("A1", 15, 0, 0)]; // Lowry's real, same-line price
    // Block wrongly claims line 1 (the unrelated bare price) instead of its
    // own line 0.
    const blocks: PriceBlockInput[] = [{ blockId: "bLowry", kind: "item", lineIndices: [1], name: "Lowry", proposedAmountId: null }];
    const results = computeGeometricOwnership(blocks, ledger, lines);
    assertEqual(results[0].amountId, "A1", "must find Lowry's real price after correcting the wrong claimed line");
    assertEqual(results[0].anchorCorrected, true);
  });

  it("an out-of-range claimed line index does not crash and still resolves via text search", () => {
    const lines = [nameLine(0, "Lowry", 0)];
    const ledger = [entry("A1", 15, 0, 0)];
    const blocks: PriceBlockInput[] = [{ blockId: "bLowry", kind: "item", lineIndices: [], name: "Lowry", proposedAmountId: null }];
    const results = computeGeometricOwnership(blocks, ledger, lines);
    assertEqual(results[0].amountId, "A1");
  });
});

describe("ownership: K — a candidate positioned before the block's own name is never matched (FIX 7.1)", () => {
  it("rejects a price sitting above the item's name in reading order, even when it is the only, nearest candidate", () => {
    // A stray monetary value printed ABOVE "Mystery" in reading order. Distance
    // alone would happily match it (it's close and there's nothing else to
    // compete with it) — the hard guard must reject it regardless.
    const lines = [priceLine(0, 99.99, 0), nameLine(1, "Mystery", 100)];
    const ledger = [entry("A1", 99.99, 0, 0)];
    const blocks = [itemBlock("bMystery", 1, "Mystery")];
    const results = computeGeometricOwnership(blocks, ledger, lines);
    assertEqual(results[0].amountId, null, "a candidate positioned above the block's own name line must never be matched, however close numerically");
  });

  it("still matches a same-row candidate — the guard only rejects candidates strictly ABOVE the name, never same-row", () => {
    const lines = [nameLine(0, "Coffee", 0), priceLine(1, 5, 20)];
    const ledger = [entry("A1", 5, 1, 20)];
    const blocks = [itemBlock("bCoffee", 0, "Coffee")];
    const results = computeGeometricOwnership(blocks, ledger, lines);
    assertEqual(results[0].amountId, "A1");
  });
});

describe("ownership: L/M — residual-based rejection of a value nowhere near where the drift model predicts (FIX 7.2)", () => {
  // Shared geometry for both tests: four confident same-line pairs seed a
  // drift fit with a small, realistic, non-zero residual noise band (not a
  // synthetic zero-residual case, which would make ANY deviation look
  // infinitely bad and prove nothing about the guard actually discriminating
  // good matches from bad ones).
  function seedWarmups() {
    const lines: OcrLine[] = [
      nameLine(0, "Warmup1", 0),
      nameLine(1, "Warmup2", 20),
      nameLine(2, "Warmup3", 40),
      nameLine(3, "Warmup4", 60),
    ];
    const blocks: PriceBlockInput[] = [
      itemBlock("bWarmup1", 0, "Warmup1"),
      itemBlock("bWarmup2", 1, "Warmup2"),
      itemBlock("bWarmup3", 2, "Warmup3"),
      itemBlock("bWarmup4", 3, "Warmup4"),
    ];
    // gaps (mid-to-mid): 100, 102, 98, 100 — small jitter around a ~100 offset,
    // giving fitDrift a realistic non-zero residual stddev (~1.5) to guard with.
    const ledger: LedgerEntry[] = [
      entry("AW1", 50, 0, 100),
      entry("AW2", 51, 1, 122),
      entry("AW3", 49, 2, 138),
      entry("AW4", 50, 3, 160),
    ];
    return { lines, blocks, ledger };
  }

  it("L — an orphaned value far outside the fitted noise band is left unmatched, not absorbed by the next block", () => {
    const { lines, blocks, ledger } = seedWarmups();
    lines.push(nameLine(4, "NextItem", 195));
    blocks.push(itemBlock("bNextItem", 4, "NextItem"));
    // The orphan sits well within the OLD distance-only cap (spacing*3 = 60)
    // but its residual against the fitted drift model (~46.7) is more than
    // 20 standard deviations out — this is what proves the residual guard,
    // not the pre-existing distance cap, is doing the rejecting here.
    ledger.push(entry("ORPHAN", 6, 99, 245));

    const results = computeGeometricOwnership(blocks, ledger, lines);
    const nextItem = results.find((r) => r.blockId === "bNextItem")!;
    assertEqual(nextItem.amountId, null, "the far-residual orphan must not be absorbed into the next block");
  });

  it("M — a genuinely adjacent value within the normal residual band IS matched (counter-test: the guard must not be trigger-happy)", () => {
    const { lines, blocks, ledger } = seedWarmups();
    lines.push(nameLine(4, "NextItem", 195));
    blocks.push(itemBlock("bNextItem", 4, "NextItem"));
    // Predicted position for NextItem is ~296.7; this candidate lands at 298,
    // a residual of ~1.3 — comfortably inside the fitted noise band.
    ledger.push(entry("REAL", 12, 5, 293));

    const results = computeGeometricOwnership(blocks, ledger, lines);
    const nextItem = results.find((r) => r.blockId === "bNextItem")!;
    assertEqual(nextItem.amountId, "REAL", "a candidate within the normal residual band must still be matched — FIX 7.2 must not be overly aggressive");
  });
});

describe("ownership: P/Q — the ambiguous fallback must respect the claimed-once invariant (FIX 8.1)", () => {
  it("P — GPT proposes an amountId already confidently claimed by another block → the second block stays unresolved, not double-claimed", () => {
    // Mirrors the real run2 bug: Garlic Shrimp confidently claims its own,
    // real, same-line price via the first pass. A second, unrelated,
    // geometrically ambiguous modifier block has GPT proposing that SAME
    // amountId (exactly what happened live) — it must not be handed out
    // twice, however GPT arrived at that guess.
    const lines = [
      nameLine(0, "GarlicShrimp", 0),
      nameLine(1, "PadSeeEwMod", 100),
      priceLine(2, 50, 200),
      priceLine(3, 51, 201), // near-tied with the candidate above -> genuinely ambiguous for the modifier
    ];
    const ledger: LedgerEntry[] = [
      entry("GS17", 17, 0, 0), // Garlic Shrimp's real, same-line price
      entry("C1", 50, 2, 200),
      entry("C2", 51, 3, 201),
    ];
    const blocks: PriceBlockInput[] = [
      itemBlock("bGarlicShrimp", 0, "GarlicShrimp"),
      { blockId: "bPadSeeEwMod", kind: "modifier", lineIndices: [1], name: null, parentBlockId: null, proposedAmountId: "GS17" },
    ];
    const results = computeGeometricOwnership(blocks, ledger, lines);
    const garlic = results.find((r) => r.blockId === "bGarlicShrimp")!;
    const mod = results.find((r) => r.blockId === "bPadSeeEwMod")!;
    assertEqual(garlic.amountId, "GS17", "Garlic Shrimp must keep its own, real, first-pass price");
    assertEqual(mod.amountId, null, "the modifier must NOT be handed a value already claimed by another block, even via GPT's own proposal");
    assertEqual(mod.confident, false);
  });

  it("Q — GPT proposes a genuinely unclaimed amountId in an ambiguous case → still accepted (counter-test: the fallback still serves what it's for)", () => {
    const lines = [nameLine(0, "Mystery", 0), priceLine(1, 10, 100), priceLine(2, 11, 101)];
    const ledger: LedgerEntry[] = [entry("A1", 10, 1, 100), entry("A2", 11, 2, 101)];
    const blocks: PriceBlockInput[] = [
      { blockId: "bMystery", kind: "modifier", lineIndices: [0], name: null, parentBlockId: null, proposedAmountId: "A1" },
    ];
    const results = computeGeometricOwnership(blocks, ledger, lines);
    const result = results[0];
    assertEqual(result.confident, false, "still genuinely ambiguous geometrically — two near-tied candidates");
    assertEqual(result.amountId, "A1", "an unclaimed, uncontested proposal must still be accepted via the fallback");
  });
});

describe("ownership: R — order independence when two blocks propose the same amountId (FIX 8.1)", () => {
  // Three filler lines establish a normal, small typical-line-spacing (~20
  // units) so maxPlausibleDistance stays small — which is what keeps SHARED
  // (thousands of units away) out of reach of the DP entirely for BOTH
  // blocks, forcing the ONLY path to a price through the proposedAmountId
  // fallback. Without this, a lopsided page geometry (as a first attempt at
  // this test found) can let the DP itself hand one block a confident,
  // legitimate match well before the fallback is ever consulted — which
  // tests the DP's reach, not the fallback's contested-claim handling.
  function run(xFirst: boolean) {
    const lines = [
      nameLine(0, "Filler1", 0),
      nameLine(1, "Filler2", 20),
      nameLine(2, "Filler3", 40),
      nameLine(3, xFirst ? "BlockX" : "BlockY", 60),
      nameLine(4, xFirst ? "BlockY" : "BlockX", 80),
    ];
    const ledger: LedgerEntry[] = [entry("SHARED", 42, 5, 5000)];
    const blocks: PriceBlockInput[] = [
      { blockId: "bX", kind: "modifier", lineIndices: [xFirst ? 3 : 4], name: null, parentBlockId: null, proposedAmountId: "SHARED" },
      { blockId: "bY", kind: "modifier", lineIndices: [xFirst ? 4 : 3], name: null, parentBlockId: null, proposedAmountId: "SHARED" },
    ];
    const results = computeGeometricOwnership(blocks, ledger, lines);
    return {
      x: results.find((r) => r.blockId === "bX")!,
      y: results.find((r) => r.blockId === "bY")!,
    };
  }

  it("X physically before Y — both stay unresolved, neither wins by being processed first", () => {
    const { x, y } = run(true);
    assertEqual(x.amountId, null, "contested proposal — X must not win it");
    assertEqual(y.amountId, null, "contested proposal — Y must not win it");
  });

  it("Y physically before X (positions swapped) — same outcome, proving the decision doesn't depend on processing order", () => {
    const { x, y } = run(false);
    assertEqual(x.amountId, null, "contested proposal — X must not win it, regardless of processing order");
    assertEqual(y.amountId, null, "contested proposal — Y must not win it, regardless of processing order");
  });
});

// ─── FIX 25 — two doors closed on the FALSE_VALID class coverage.ts can't
// see (it only checks a value was claimed by SOME block, never the RIGHT
// one): Part 1 penalizes an item/modifier reaching past itemsRegionEnd;
// Part 2 flags a genuine reading-order-vs-claim-order inversion. Both are
// implemented and verified below against real fixtures where the real
// data actually exercises the mechanism, and against controlled synthetic
// geometry (same style as the rest of this file) where it doesn't. ────────

function loadRealFixture(filename: string) {
  const raw = JSON.parse(
    readFileSync(join(process.cwd(), `supabase/functions/parse-receipt/__fixtures__/${filename}`), "utf-8")
  );
  const ocr = normalizeVisionResponse(raw);
  const ledger = buildLedgerFromOcr(ocr.lines);
  return { ocr, ledger };
}

/** FIX 40 — a printed line's real lineIndex, found by CONTENT rather than a
 *  hardcoded number — line numbers shift whenever line reconstruction
 *  changes (FIX 39's own geometric path consolidates several of these
 *  fixtures' lines). Throws loudly rather than silently testing a
 *  different scenario if the marker text is missing. `nth` (0-based) picks
 *  among multiple matches when the marker isn't unique on its own. */
function lineOf(ocr: { lines: OcrLine[] }, marker: string, nth = 0): number {
  const matches = ocr.lines.filter((l) => l.text.includes(marker));
  const line = matches[nth];
  if (!line) throw new Error(`no line #${nth} contains "${marker}" (found ${matches.length})`);
  return line.lineIndex;
}

/** Same idea as lineOf, for a specific LEDGER ENTRY: anchored to a nearby
 *  line's real content instead of a hardcoded amountId (amountIds are
 *  assigned in ledger-build order, which line reconstruction can also
 *  reorder). */
function entryNear(ocr: { lines: OcrLine[] }, ledger: LedgerEntry[], marker: string, rawText: string, maxDistance = 3): LedgerEntry {
  const markerLine = ocr.lines.find((l) => l.text.includes(marker));
  if (!markerLine) throw new Error(`no line contains "${marker}"`);
  const entry = ledger.find((e) => e.rawText === rawText && Math.abs(e.lineIndex - markerLine.lineIndex) <= maxDistance);
  if (!entry) throw new Error(`no ledger entry with rawText "${rawText}" within ${maxDistance} lines of "${marker}"`);
  return entry;
}

describe("ownership: FIX 25 Part 1 — items-region boundary as a penalty, not a wall", () => {
  it("CR — Buca di Beppo real fixture: no item block claims the Subtotal or Total value anymore", () => {
    // Real blocks, exactly as GPT reported them for this receipt (a photo
    // with overlapping promotional flyers behind the receipt, which
    // garbled the OCR line reconstruction — see the FIX 24 report). Before
    // this fix, "Iced Tea" and "Sm Chop Antipasto Salad" confidently
    // claimed the printed Subtotal (100.26) and Total (109.28) instead of
    // their real prices (3.29, 18.99), because computeGeometricOwnership
    // had no notion of the items/summary boundary at all.
    const { ocr, ledger } = loadRealFixture("vision-bucadibeppo-en.json");
    const blocks: PriceBlockInput[] = [
      { blockId: "b1", kind: "unclassified", lineIndices: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14], name: null, parentBlockId: null, proposedAmountId: null },
      { blockId: "b2", kind: "item", lineIndices: [15], name: "Iced Tea", parentBlockId: null, proposedAmountId: null },
      { blockId: "b3", kind: "item", lineIndices: [16], name: "Sm Garlic Bread", parentBlockId: null, proposedAmountId: null },
      { blockId: "b4", kind: "item", lineIndices: [17], name: "9oz Buca Chianti", parentBlockId: null, proposedAmountId: null },
      { blockId: "b5", kind: "item", lineIndices: [18], name: "G1 Buca Chianti", parentBlockId: null, proposedAmountId: null },
      { blockId: "b6", kind: "item", lineIndices: [19], name: "Sm Chop Antipasto Salad", parentBlockId: null, proposedAmountId: null },
      { blockId: "b7", kind: "item", lineIndices: [20], name: "Lg Supremo Pizza", parentBlockId: null, proposedAmountId: null },
      { blockId: "b15", kind: "unclassified", lineIndices: [28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43], name: null, parentBlockId: null, proposedAmountId: null },
      { blockId: "b16", kind: "summary", lineIndices: [44, 45, 46, 47, 48], name: "Subtotal", parentBlockId: null, proposedAmountId: null },
      { blockId: "b17", kind: "summary", lineIndices: [45, 46, 47, 48], name: "Tax", parentBlockId: null, proposedAmountId: null },
      { blockId: "b18", kind: "summary", lineIndices: [48, 49, 50, 51, 52, 53], name: "Total", parentBlockId: null, proposedAmountId: null },
    ];
    const itemsRegionEnd = computeItemsRegionEnd(blocks);
    assertEqual(itemsRegionEnd, 44, "sanity check on the real boundary this fixture produces");
    const ownership = computeGeometricOwnership(blocks, ledger, ocr.lines, itemsRegionEnd);
    const ledgerByAmountId = new Map(ledger.map((e) => [e.amountId, e]));
    for (const b of blocks) {
      if (b.kind !== "item" && b.kind !== "modifier") continue;
      const o = ownership.find((r) => r.blockId === b.blockId);
      const claimedEntry = o?.amountId ? ledgerByAmountId.get(o.amountId) : null;
      assert(
        !claimedEntry || claimedEntry.lineIndex < itemsRegionEnd,
        `${b.blockId} (${b.name}) must never claim a summary-region value — claimed ${JSON.stringify(claimedEntry)}`
      );
    }
  });

  it("CS — an item genuinely needing the second-pass search to reach past itemsRegionEnd still resolves: the penalty is not a wall", () => {
    // Motivated by a real, verified Mad God shape: "Total liq" (a summary
    // label) prints early in reading order while a real item's own price
    // confirmation still follows it a few lines later — a real receipt
    // layout quirk, not a hypothetical. The exact real Mad God item this
    // was traced from (Cafe Delta) turns out to resolve via the FIRST pass
    // instead (its own name-line also carries a bare quantity marker,
    // "7.00", which the pre-existing same-line fast path grabs before ever
    // reaching the DP — a separate, already-known "quantity-as-decimal"
    // gap, explicitly out of scope since FIX 19). This test isolates the
    // SECOND-pass case specifically — a block with NO local same-line
    // candidate, forcing the DP search across the boundary — using
    // controlled geometry so the boundary penalty's effect (not an
    // unrelated first-pass quirk) is what's actually being verified.
    const lines: OcrLine[] = [
      nameLine(0, "Warmup1", 0),
      nameLine(1, "Warmup2", 20),
      nameLine(2, "Warmup3", 40),
      nameLine(3, "Nightcap", 60), // name only — its price is not on this line
      makeLine(4, [makeWord("lbl", "Total", 0, 80), makeWord("tv", "99.00", 300, 80)]), // summary label WITH its own value — must not compete for Nightcap's price
      makeLine(5, [makeWord("pv", "2.50", 300, 100)]), // Nightcap's real, only price — past the boundary
    ];
    const ledger: LedgerEntry[] = [
      entry("AW1", 5, 0, 8), // warm-up pairs so fitDrift has 3+ points, with
      entry("AW2", 6, 1, 33), // non-zero variance in the gap so the FIX 7.2
      entry("AW3", 7, 2, 51), // residual guard has real tolerance, not zero
      entry("A_TOTAL", 99, 4, 80),
      entry("A_PRICE", 2.5, 5, 78),
    ];
    const blocks: PriceBlockInput[] = [
      itemBlock("bWarmup1", 0, "Warmup1"),
      itemBlock("bWarmup2", 1, "Warmup2"),
      itemBlock("bWarmup3", 2, "Warmup3"),
      itemBlock("bNightcap", 3, "Nightcap"),
      { blockId: "bTotal", kind: "summary", lineIndices: [4], name: "Total", parentBlockId: null, proposedAmountId: null },
    ];
    const itemsRegionEnd = computeItemsRegionEnd(blocks);
    assertEqual(itemsRegionEnd, 4);
    const ownership = computeGeometricOwnership(blocks, ledger, lines, itemsRegionEnd);
    const nightcap = ownership.find((r) => r.blockId === "bNightcap")!;
    assertEqual(nightcap.amountId, "A_PRICE", "the ONLY candidate anywhere sits past the boundary — the penalty must not be a wall when there is no legitimate in-region alternative");
  });
});

describe("ownership: FIX 25 Part 2 — crossing detection over the full result set", () => {
  it("CQ — Hollywood Cafe real fixture: SODA/CHEESE STEAK's mis-attribution is traced and confirmed to be NOT a position crossing — the round's central negative finding", () => {
    // FIX 24 called this "the ownership matcher, not echo/adjacency" —
    // true, but imprecise about WHERE inside ownership.ts. Traced further
    // for FIX 25: GPT itself mis-reported BOTH blocks' lineIndices
    // (SODA:[6], CHEESE STEAK:[7] — one line short of where each name
    // really prints). correctAnchorLine independently relocates EACH block
    // to wherever its own NAME text actually appears (7 and 8
    // respectively) — succeeding at its own job for each block in
    // isolation. But this receipt's price column is genuinely offset by
    // one printed row from its name column, so the corrected anchor lines
    // each carry a single, unambiguous — and WRONG — decimal. Because both
    // corrections shift in the SAME direction, the claimed values still
    // increase monotonically (line 7 then line 8): no ORDER INVERSION
    // exists for a position-based check to catch. This is a fundamentally
    // different failure shape than a true crossing (see the mechanism
    // proof below) — Part 2 cannot close this door, and this round's own
    // stated deciding condition is not met. Reported, not forced.
    const { ocr, ledger } = loadRealFixture("vision-hollywoodcafe-en.json");
    const blocks: PriceBlockInput[] = [
      { blockId: "SODA", kind: "item", lineIndices: [6], name: "SODA", parentBlockId: null, proposedAmountId: null },
      { blockId: "STEAK", kind: "item", lineIndices: [7], name: "CHEESE STEAK", parentBlockId: null, proposedAmountId: null },
      { blockId: "AMCHS", kind: "modifier", lineIndices: [8], name: "AMERICAN CHS", parentBlockId: "STEAK", proposedAmountId: null },
      { blockId: "FRDONION", kind: "modifier", lineIndices: [9], name: "FRD ONION", parentBlockId: "STEAK", proposedAmountId: null },
      { blockId: "CHIX", kind: "item", lineIndices: [10], name: "Chix Cheesesteak", parentBlockId: null, proposedAmountId: null },
      { blockId: "SUBTOTAL", kind: "summary", lineIndices: [11], name: "SUB-TOTAL", parentBlockId: null, proposedAmountId: null },
    ];
    const itemsRegionEnd = computeItemsRegionEnd(blocks);
    const ownership = computeGeometricOwnership(blocks, ledger, ocr.lines, itemsRegionEnd);
    const ledgerByAmountId = new Map(ledger.map((e) => [e.amountId, e]));
    const soda = ownership.find((r) => r.blockId === "SODA")!;
    const steak = ownership.find((r) => r.blockId === "STEAK")!;
    assertEqual(soda.crossingDetected, false, "no position inversion exists here — verified by direct trace, not assumed");
    assertEqual(steak.crossingDetected, false);
    assertEqual(ledgerByAmountId.get(soda.amountId!)?.value, 10.49, "SODA still ends up with Cheese Steak's real price — Part 2 does not close this door");
    assertEqual(ledgerByAmountId.get(steak.amountId!)?.value, 1.0, "CHEESE STEAK still ends up with a modifier's real price — Part 2 does not close this door");
  });

  it("proof of mechanism — a genuine reading-order-vs-claim-order inversion IS detected and demoted, proving Part 2 works for the failure shape it actually targets", () => {
    // Two blocks, each resolved via the first-pass same-line fast path
    // (same mechanism Hollywood Cafe uses) — but here the SAME-LINE
    // candidates are deliberately positioned so block P's own claim sits
    // PHYSICALLY BELOW block Q's, even though P's name prints first. This
    // is what an actual crossing looks like — unlike Hollywood Cafe's
    // shape (see CQ), where both blocks' claims stay in relative order.
    const lines: OcrLine[] = [nameLine(0, "P", 0), nameLine(1, "Q", 20)];
    const ledger: LedgerEntry[] = [
      entry("A_FOR_P", 99, 0, 1000), // P's own line, but geometrically far below Q's
      entry("A_FOR_Q", 5, 1, 10), // Q's own line, geometrically right after P's name
    ];
    const blocks: PriceBlockInput[] = [itemBlock("bP", 0, "P"), itemBlock("bQ", 1, "Q")];
    const ownership = computeGeometricOwnership(blocks, ledger, lines);
    const p = ownership.find((r) => r.blockId === "bP")!;
    const q = ownership.find((r) => r.blockId === "bQ")!;
    assertEqual(p.crossingDetected, true, "P's claim sits after Q's despite P's name coming first — a genuine inversion");
    assertEqual(q.crossingDetected, true);
    assertEqual(p.amountId, null, "neither side is guessed to be the 'right' one — both stay unresolved");
    assertEqual(q.amountId, null);
  });

  it("CT — Mad God-shaped repeated values (three real 16.95 occurrences) in correct increasing order are never marked as a crossing", () => {
    // Real Mad God value (Truffle, 16.95, appears three times on this
    // receipt) — equal VALUES must never be read as evidence of a
    // crossing; only the ORDER of each block's own claimed POSITION
    // matters, and here it strictly increases.
    const lines: OcrLine[] = [
      nameLine(0, "Truffle", 0),
      nameLine(1, "Truffle", 20),
      nameLine(2, "Truffle", 40),
    ];
    const ledger: LedgerEntry[] = [entry("T1", 16.95, 0, 5), entry("T2", 16.95, 1, 25), entry("T3", 16.95, 2, 45)];
    const blocks: PriceBlockInput[] = [itemBlock("bT1", 0, "Truffle"), itemBlock("bT2", 1, "Truffle"), itemBlock("bT3", 2, "Truffle")];
    const ownership = computeGeometricOwnership(blocks, ledger, lines);
    for (const o of ownership) {
      assertEqual(o.crossingDetected, false, `${o.blockId}: equal values in correct increasing order must never be flagged`);
    }
    assertEqual(ownership.find((o) => o.blockId === "bT1")?.amountId, "T1");
    assertEqual(ownership.find((o) => o.blockId === "bT2")?.amountId, "T2");
    assertEqual(ownership.find((o) => o.blockId === "bT3")?.amountId, "T3");
  });

  it("CV — correct order, no crossing anywhere → nothing is marked (counter-test: the check must not fire on everything)", () => {
    const lines: OcrLine[] = [nameLine(0, "Alpha", 0), nameLine(1, "Beta", 20), nameLine(2, "Gamma", 40)];
    const ledger: LedgerEntry[] = [entry("A1", 10, 0, 5), entry("A2", 20, 1, 25), entry("A3", 30, 2, 45)];
    const blocks: PriceBlockInput[] = [itemBlock("bA", 0, "Alpha"), itemBlock("bB", 1, "Beta"), itemBlock("bC", 2, "Gamma")];
    const ownership = computeGeometricOwnership(blocks, ledger, lines);
    for (const o of ownership) {
      assertEqual(o.crossingDetected, false, `${o.blockId}: strictly increasing, distinct values in order must never be flagged`);
      assert(o.amountId !== null, `${o.blockId}: a clean, unambiguous match must still resolve`);
    }
  });

  it("CU — the FIX 24 FALSE_VALID reproduction (Hollywood-Cafe-shaped clean two-item swap), routed through the REAL ownership pathway: still reconciles — empirically verified, not assumed", () => {
    // FIX 24's original proof hardcoded block.amountId directly, never
    // invoking ownership.ts at all — meaning it could never have reflected
    // ANY ownership.ts change, by construction. This version routes the
    // SAME shape (two items, prices cleanly swapped, nothing dropped —
    // unlike the real Hollywood Cafe run, where a THIRD value being
    // dropped entirely happened to already break the coincidental
    // arithmetic match) through computeGeometricOwnership for real, then
    // through buildFinalPayload/reconcile. Both items resolve via the
    // first-pass fast path with their relative order preserved (same
    // shape as CQ) — no crossing, so reconciles is still true.
    const lines: OcrLine[] = [
      makeLine(0, [makeWord("s", "SODA", 0, 0), makeWord("sv", "10.49", 300, 0)]),
      makeLine(1, [makeWord("c", "CHEESESTEAK", 0, 20), makeWord("cv", "2.49", 300, 20)]),
      makeLine(2, [makeWord("st", "Subtotal", 0, 40), makeWord("sub", "12.98", 300, 40)]),
    ];
    const ledger: LedgerEntry[] = [entry("A1", 10.49, 0, 0), entry("A2", 2.49, 1, 20), entry("A3", 12.98, 2, 40)];
    const blocks: PriceBlockInput[] = [
      { blockId: "SODA", kind: "item", lineIndices: [0], name: "SODA", parentBlockId: null, proposedAmountId: null },
      { blockId: "STEAK", kind: "item", lineIndices: [1], name: "CHEESESTEAK", parentBlockId: null, proposedAmountId: null },
      { blockId: "SUB", kind: "summary", lineIndices: [2], name: "Subtotal", parentBlockId: null, proposedAmountId: null },
    ];
    const itemsRegionEnd = computeItemsRegionEnd(blocks);
    const ownership = computeGeometricOwnership(blocks, ledger, lines, itemsRegionEnd);
    assertEqual(ownership.find((o) => o.blockId === "SODA")?.crossingDetected, false, "confirmed: no inversion in this shape");

    const structureBlocks = blocks.map((b) => {
      const o = ownership.find((r) => r.blockId === b.blockId);
      return { blockId: b.blockId, kind: b.kind, lineIndices: b.lineIndices, name: b.name, parentBlockId: b.parentBlockId, amountId: o?.amountId ?? null, quantity: 1, priceKind: "lineTotal" as const };
    });
    const assignments = structureBlocks.map((b) => ({ blockId: b.blockId, amountId: b.amountId, quantity: b.quantity, priceKind: b.priceKind }));
    const validations = validateAssignments(structureBlocks, assignments, ledger);
    const { payload } = buildFinalPayload(null, "USD", [], structureBlocks, validations, ledger);
    const reconciliation = reconcile(payload);
    assertEqual(
      reconciliation.reconciles,
      true,
      "EMPIRICAL RESULT, not the hoped-for outcome: this round's own deciding condition (this reproduction must stop reconciling) is NOT met — see CQ for the traced root cause"
    );
  });
});

// ─── FIX 27 — constant column offset, arbitrated by the printed subtotal ───
//
// Mirrors index.ts's own Step 1 (detectConstantOffsetRuns) + Step 2
// (exactly two hypotheses, arbitrated by a NAMED summary block's own
// geometrically-resolved value — never the arithmetic-closure-derived
// printedSubtotal/calculatedSubtotal) exactly, so these tests exercise the
// real production logic, not a parallel reimplementation.
function runOffsetArbitration(
  blocks: PriceBlockInput[],
  ledger: LedgerEntry[],
  lines: OcrLine[],
  currency: string
): { formDetected: boolean; hypothesisAdopted: "H0" | "H1" | "AMBIGUOUS"; finalBlocks: StructureBlock[] } {
  const itemsRegionEnd = computeItemsRegionEnd(blocks as unknown as StructureBlock[]);
  const ownership = computeGeometricOwnership(blocks, ledger, lines, itemsRegionEnd);
  const ownershipByBlock = new Map(ownership.map((r) => [r.blockId, r]));
  const structureBlocks: StructureBlock[] = blocks.map((b) => {
    const o = ownershipByBlock.get(b.blockId);
    return {
      blockId: b.blockId,
      kind: b.kind,
      lineIndices: b.lineIndices,
      name: b.name,
      parentBlockId: b.parentBlockId,
      amountId: o?.amountId ?? null,
      quantity: 1,
      priceKind: "lineTotal",
    };
  });

  const offsetRuns = detectConstantOffsetRuns(blocks, ledger, lines, itemsRegionEnd);
  const formDetected = offsetRuns.length > 0;
  const viableRuns = offsetRuns.filter((r) => r.h1AmountIds !== null);
  const namedSubtotalBlock = structureBlocks.find(
    (b) => b.kind === "summary" && /subtotal/.test((b.name ?? "").toLowerCase().replace(/[^a-z]/g, ""))
  );
  const namedSubtotalOwnership = namedSubtotalBlock ? ownershipByBlock.get(namedSubtotalBlock.blockId) : undefined;
  const printedSubtotalEntry =
    namedSubtotalOwnership?.confident && namedSubtotalOwnership.amountId
      ? ledger.find((e) => e.amountId === namedSubtotalOwnership.amountId) ?? null
      : null;
  const arbitrationTargetMinor = printedSubtotalEntry ? toMinor(printedSubtotalEntry.value, currency) : null;

  let hypothesisAdopted: "H0" | "H1" | "AMBIGUOUS" = "H0";
  let finalBlocks = structureBlocks;

  if (viableRuns.length > 0 && arbitrationTargetMinor !== null) {
    const affectedBlockIds = new Set(viableRuns.flatMap((r) => r.blockIds));
    const h1AmountIdByBlock = new Map<string, string | null>();
    for (const r of viableRuns) for (const [blockId, amountId] of r.h1AmountIds!) h1AmountIdByBlock.set(blockId, amountId);

    const h0Assignments = assignmentsFromBlocks(structureBlocks);
    const h0Validations = validateAssignments(structureBlocks, h0Assignments, ledger);
    const h0Assembled = buildFinalPayload(null, currency, [], structureBlocks, h0Validations, ledger);
    const h0SumMinor = reconcile(h0Assembled.payload).calculatedSubtotalMinor;

    const h1Blocks = structureBlocks.map((b) =>
      affectedBlockIds.has(b.blockId) ? { ...b, amountId: h1AmountIdByBlock.get(b.blockId) ?? null } : b
    );
    const h1Assignments = assignmentsFromBlocks(h1Blocks);
    const h1Validations = validateAssignments(h1Blocks, h1Assignments, ledger);
    const h1Assembled = buildFinalPayload(null, currency, [], h1Blocks, h1Validations, ledger);
    const h1SumMinor = reconcile(h1Assembled.payload).calculatedSubtotalMinor;

    const h0Closes = h0SumMinor === arbitrationTargetMinor;
    const h1Closes = h1SumMinor === arbitrationTargetMinor;

    if (h1Closes && !h0Closes) {
      hypothesisAdopted = "H1";
      finalBlocks = h1Blocks;
    } else if (h0Closes && h1Closes) {
      hypothesisAdopted = "AMBIGUOUS";
      finalBlocks = structureBlocks.map((b) => (affectedBlockIds.has(b.blockId) ? { ...b, amountId: null } : b));
    }
  }

  return { formDetected, hypothesisAdopted, finalBlocks };
}

describe("ownership: FIX 27 — constant column offset, arbitrated by the printed subtotal", () => {
  it("DC — Hollywood Cafe real fixture: the shape is detected, H1 closes to 25.22 against the printed subtotal, H0 does not, H1 is adopted", () => {
    // Same real block array as CQ (GPT's own off-by-one lineIndices for
    // this receipt), plus a realistic proposedAmountId for FRD ONION so it
    // resolves normally (its own value is already correct and untouched by
    // this mechanism — only SODA/STEAK/AMERICAN CHS sit in the detected
    // run). This is the test that decides the round.
    const { ocr, ledger } = loadRealFixture("vision-hollywoodcafe-en.json");
    const blocks: PriceBlockInput[] = [
      { blockId: "SODA", kind: "item", lineIndices: [6], name: "SODA", parentBlockId: null, proposedAmountId: null },
      { blockId: "STEAK", kind: "item", lineIndices: [7], name: "CHEESE STEAK", parentBlockId: null, proposedAmountId: null },
      { blockId: "AMCHS", kind: "modifier", lineIndices: [8], name: "AMERICAN CHS", parentBlockId: "STEAK", proposedAmountId: null },
      { blockId: "FRDONION", kind: "modifier", lineIndices: [9], name: "FRD ONION", parentBlockId: "STEAK", proposedAmountId: "A5" },
      { blockId: "CHIX", kind: "item", lineIndices: [10], name: "Chix Cheesesteak", parentBlockId: null, proposedAmountId: null },
      { blockId: "SUBTOTAL", kind: "summary", lineIndices: [11], name: "SUB-TOTAL", parentBlockId: null, proposedAmountId: null },
    ];
    const { formDetected, hypothesisAdopted, finalBlocks } = runOffsetArbitration(blocks, ledger, ocr.lines, "USD");
    assertEqual(formDetected, true);
    assertEqual(hypothesisAdopted, "H1");

    const finalAssignments = assignmentsFromBlocks(finalBlocks);
    const finalValidations = validateAssignments(finalBlocks, finalAssignments, ledger);
    const { payload } = buildFinalPayload("Hollywood Cafe", "USD", ocr.lines.map((l) => l.text), finalBlocks, finalValidations, ledger);
    const reconciliation = reconcile(payload);
    assertEqual(reconciliation.calculatedSubtotalMinor, 2522, "the five items must sum to exactly the printed 25.22");

    const valueByName = new Map<string, number | null>();
    for (const item of payload.items) valueByName.set(item.name, item.baseLineTotal ?? item.unitPrice);
    for (const item of payload.items) {
      for (const m of item.modifiers ?? []) valueByName.set(m.name, m.price);
    }
    assertEqual(valueByName.get("SODA"), 2.49);
    assertEqual(valueByName.get("CHEESE STEAK"), 10.49);
    assertEqual(valueByName.get("AMERICAN CHS"), 1.0);
    assertEqual(valueByName.get("FRD ONION"), 0.75);
    assertEqual(valueByName.get("Chix Cheesesteak"), 10.49);
  });

  it("DD — the FIX 24 reproduction, updated to the TRUE constant-offset shape (not the old 'clean swap' FIX 26 disproved): H1 corrects it, and it reconciles on the CORRECT total, never the wrong one", () => {
    const lines: OcrLine[] = [
      makeLine(0, [makeWord("v0", "2.49", 300, 0)]),
      makeLine(1, [makeWord("n1", "SODA", 0, 20), makeWord("v1", "10.49", 300, 20)]),
      makeLine(2, [makeWord("n2", "CHEESESTEAK", 0, 40)]),
      makeLine(3, [makeWord("st", "Subtotal", 0, 60), makeWord("stv", "12.98", 300, 60)]),
    ];
    const ledger: LedgerEntry[] = [entry("A1", 2.49, 0, 0), entry("A2", 10.49, 1, 20), entry("A3", 12.98, 3, 60)];
    const blocks: PriceBlockInput[] = [
      { blockId: "SODA", kind: "item", lineIndices: [0], name: "SODA", parentBlockId: null, proposedAmountId: null },
      { blockId: "STEAK", kind: "item", lineIndices: [1], name: "CHEESESTEAK", parentBlockId: null, proposedAmountId: null },
      { blockId: "SUB", kind: "summary", lineIndices: [3], name: "Subtotal", parentBlockId: null, proposedAmountId: null },
    ];
    const { hypothesisAdopted, finalBlocks } = runOffsetArbitration(blocks, ledger, lines, "USD");
    assertEqual(hypothesisAdopted, "H1");
    const finalAssignments = assignmentsFromBlocks(finalBlocks);
    const finalValidations = validateAssignments(finalBlocks, finalAssignments, ledger);
    const { payload } = buildFinalPayload(null, "USD", [], finalBlocks, finalValidations, ledger);
    const reconciliation = reconcile(payload);
    assertEqual(
      reconciliation.reconciles,
      true,
      "the WRONG (H0) structure never reaches reconciliation — H1 corrects it first, so this reconciles on the RIGHT total (12.98), not the old FALSE_VALID one"
    );
    assertEqual(payload.items.find((i) => i.name === "SODA")?.baseLineTotal, 2.49);
    assertEqual(payload.items.find((i) => i.name === "CHEESESTEAK")?.baseLineTotal, 10.49);
  });

  it("CY — a normal, correctly two-line-per-item receipt (name on one line, its own price on the very next, for every item) is never marked — consistency is not a constant offset", () => {
    // Confirmed by direct construction to be a real false-positive risk
    // before the raw-line-ownership guard (below, in ownership.ts) was
    // added: without it, "Beta"/"Gamma" here would each be silently
    // reassigned the PREVIOUS item's price. GPT reports each item's own
    // multi-line span (both the name line and its own price line) — that
    // reported span is exactly what marks the price line as already
    // explained, not orphaned.
    const lines: OcrLine[] = [
      makeLine(0, [makeWord("n1", "Alpha", 0, 0)]),
      makeLine(1, [makeWord("v1", "5.00", 300, 20)]),
      makeLine(2, [makeWord("n2", "Beta", 0, 40)]),
      makeLine(3, [makeWord("v2", "7.00", 300, 60)]),
      makeLine(4, [makeWord("n3", "Gamma", 0, 80)]),
      makeLine(5, [makeWord("v3", "9.00", 300, 100)]),
      makeLine(6, [makeWord("st", "Total", 0, 120), makeWord("stv", "21.00", 300, 120)]),
    ];
    const ledger: LedgerEntry[] = [entry("A1", 5.0, 1, 20), entry("A2", 7.0, 3, 60), entry("A3", 9.0, 5, 100), entry("A4", 21.0, 6, 120)];
    const blocks: PriceBlockInput[] = [
      { blockId: "alpha", kind: "item", lineIndices: [0, 1], name: "Alpha", parentBlockId: null, proposedAmountId: null },
      { blockId: "beta", kind: "item", lineIndices: [2, 3], name: "Beta", parentBlockId: null, proposedAmountId: null },
      { blockId: "gamma", kind: "item", lineIndices: [4, 5], name: "Gamma", parentBlockId: null, proposedAmountId: null },
      { blockId: "total", kind: "summary", lineIndices: [6], name: "Total", parentBlockId: null, proposedAmountId: null },
    ];
    const { hypothesisAdopted, finalBlocks } = runOffsetArbitration(blocks, ledger, lines, "USD");
    assertEqual(hypothesisAdopted, "H0", "a plain multi-line-per-item receipt must never be reassigned");
    assertEqual(finalBlocks.find((b) => b.blockId === "beta")?.amountId, "A2", "Beta must keep its OWN price, never Alpha's");
    assertEqual(finalBlocks.find((b) => b.blockId === "gamma")?.amountId, "A3", "Gamma must keep its OWN price, never Beta's");
  });

  it("CZ — Augustiner real fixture: the 'HELLES 0,5L' unit-price line does trigger Step 1 (the round's own prediction that it would not is wrong, reported honestly), but the reassignment is inert — H1 offers the SAME value the block already has, and H0 stands", () => {
    // Real blocks, exactly as GPT reported them for this receipt. Traced:
    // "3 x 11,50" (line14) then "33,60" (line15, VALUE_ONLY) then
    // "Currywurst + Pommes 34,502" (line16 — OCR-garbled quantity glued to
    // the price, no valid decimal token survives, so this line reads as
    // NAME_ONLY) forms a real Step-1 shape. But Currywurst's own block
    // already claims line15 as part of its OWN reported span — the guard
    // that protects CY does NOT reject this one, because the only owner
    // of that value (Currywurst's own block) IS the block being
    // "reassigned", so H1 hands it back the exact value it already had.
    const { ocr, ledger } = loadRealFixture("vision-augustiner-de.json");
    // FIX 40 — every lineIndex below is found by real printed content
    // (lineOf/entryNear), not hardcoded, so this test survives line
    // reconstruction changing (FIX 39's geometric path consolidates many of
    // these lines). b1's own [x11,50-line, 33,60-line] intentionally does
    // NOT include the "Currywurst + Pommes 34,502" line itself — that
    // mismatch (GPT's own real, misaligned block span for this receipt) is
    // the exact shape this test exists to reproduce.
    const blocks: PriceBlockInput[] = [
      { blockId: "b0", kind: "item", lineIndices: [lineOf(ocr, "x4,20"), lineOf(ocr, "HELLES")], name: "HELLES 0,5L", parentBlockId: null, proposedAmountId: null },
      {
        blockId: "b1",
        kind: "item",
        lineIndices: [lineOf(ocr, "x 11,50"), lineOf(ocr, "33,60")],
        name: "Currywurst + Pommes",
        parentBlockId: null,
        proposedAmountId: entryNear(ocr, ledger, "Weisswürste", "7,50", 3).amountId,
      },
      { blockId: "b2", kind: "item", lineIndices: [lineOf(ocr, "Leberkäs")], name: "Leberkäs", parentBlockId: null, proposedAmountId: null },
      { blockId: "b3", kind: "item", lineIndices: [lineOf(ocr, "Weisswürste")], name: "Weisswürste", parentBlockId: null, proposedAmountId: null },
      { blockId: "b4", kind: "item", lineIndices: [lineOf(ocr, "Brez'n")], name: "Brez'n", parentBlockId: null, proposedAmountId: null },
      {
        blockId: "b5",
        kind: "item",
        lineIndices: [...new Set([lineOf(ocr, "Aqua Panna"), lineOf(ocr, "6,90")])],
        name: "Aqua Panna 0,75L",
        parentBlockId: null,
        proposedAmountId: null,
      },
      { blockId: "b6", kind: "summary", lineIndices: [lineOf(ocr, "Total")], name: "Total", parentBlockId: null, proposedAmountId: null },
    ];
    const itemsRegionEnd = computeItemsRegionEnd(blocks as unknown as StructureBlock[]);
    const ownership = computeGeometricOwnership(blocks, ledger, ocr.lines, itemsRegionEnd);
    const h0Currywurst = ownership.find((r) => r.blockId === "b1")!.amountId;

    const { formDetected, hypothesisAdopted, finalBlocks } = runOffsetArbitration(blocks, ledger, ocr.lines, "EUR");
    assertEqual(formDetected, true, "EMPIRICAL RESULT: Step 1 does detect a shape here, contradicting the round's own prediction — reported, not hidden");
    // Whatever hypothesisAdopted ends up being (this receipt's own "Total"
    // — not "Subtotal" — never satisfies the named-subtotal precondition
    // at all, so it must stay H0), Currywurst's value must be UNCHANGED.
    assertEqual(hypothesisAdopted, "H0", "no named 'subtotal' block exists on this receipt (only 'Total') — Step 2 never runs");
    assertEqual(finalBlocks.find((b) => b.blockId === "b1")?.amountId, h0Currywurst, "even if arbitration ran, the reassignment is a same-value no-op");
  });

  it("DA — Mad God real fixture: repeated-name/repeated-price items (Truffle x3, Kids x3) never trigger Step 1", () => {
    const { ocr, ledger } = loadRealFixture("vision-madgod-pt.json");
    // A representative slice around one real Truffle occurrence — every
    // line in this receipt's item region is MIXED (name and price share a
    // line), so no VALUE_ONLY line exists anywhere for Step 1 to anchor on.
    const blocks: PriceBlockInput[] = [
      { blockId: "b1", kind: "item", lineIndices: [17], name: "Cerveja Heineken", parentBlockId: null, proposedAmountId: null },
      { blockId: "b2", kind: "item", lineIndices: [20], name: "Scary", parentBlockId: null, proposedAmountId: null },
      { blockId: "b3", kind: "item", lineIndices: [23], name: "Project", parentBlockId: null, proposedAmountId: null },
      { blockId: "b4", kind: "item", lineIndices: [26], name: "Kiss of Death", parentBlockId: null, proposedAmountId: null },
      { blockId: "b5", kind: "item", lineIndices: [29], name: "Shroom of doom", parentBlockId: null, proposedAmountId: null },
      { blockId: "b6", kind: "item", lineIndices: [39], name: "Truffle", parentBlockId: null, proposedAmountId: null },
      { blockId: "b7", kind: "summary", lineIndices: [41], name: "Subtotal", parentBlockId: null, proposedAmountId: null },
    ];
    const { formDetected } = runOffsetArbitration(blocks, ledger, ocr.lines, "EUR");
    assertEqual(formDetected, false, "every line in this slice is MIXED — no VALUE_ONLY/NAME_ONLY chain exists to detect");
  });

  it("DE — Buca di Beppo real fixture (CR's own block array): no viable reassignment despite FIX 25's known unresolved-modifier shape", () => {
    const { ocr, ledger } = loadRealFixture("vision-bucadibeppo-en.json");
    const blocks: PriceBlockInput[] = [
      { blockId: "b1", kind: "unclassified", lineIndices: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14], name: null, parentBlockId: null, proposedAmountId: null },
      { blockId: "b2", kind: "item", lineIndices: [15], name: "Iced Tea", parentBlockId: null, proposedAmountId: null },
      { blockId: "b3", kind: "item", lineIndices: [16], name: "Sm Garlic Bread", parentBlockId: null, proposedAmountId: null },
      { blockId: "b4", kind: "item", lineIndices: [17], name: "9oz Buca Chianti", parentBlockId: null, proposedAmountId: null },
      { blockId: "b5", kind: "item", lineIndices: [18], name: "G1 Buca Chianti", parentBlockId: null, proposedAmountId: null },
      { blockId: "b6", kind: "item", lineIndices: [19], name: "Sm Chop Antipasto Salad", parentBlockId: null, proposedAmountId: null },
      { blockId: "b7", kind: "item", lineIndices: [20], name: "Lg Supremo Pizza", parentBlockId: null, proposedAmountId: null },
      { blockId: "b15", kind: "unclassified", lineIndices: [28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43], name: null, parentBlockId: null, proposedAmountId: null },
      { blockId: "b16", kind: "summary", lineIndices: [44, 45, 46, 47, 48], name: "Subtotal", parentBlockId: null, proposedAmountId: null },
      { blockId: "b17", kind: "summary", lineIndices: [45, 46, 47, 48], name: "Tax", parentBlockId: null, proposedAmountId: null },
      { blockId: "b18", kind: "summary", lineIndices: [48, 49, 50, 51, 52, 53], name: "Total", parentBlockId: null, proposedAmountId: null },
    ];
    const { hypothesisAdopted } = runOffsetArbitration(blocks, ledger, ocr.lines, "USD");
    assertEqual(hypothesisAdopted, "H0");
  });

  it("DF — the shape is detected but neither hypothesis closes against the printed subtotal: H0 stands, nothing changes", () => {
    const lines: OcrLine[] = [
      makeLine(0, [makeWord("v0", "0.00", 300, 0)]),
      makeLine(1, [makeWord("n1", "Alpha", 0, 20), makeWord("v1", "5.00", 300, 20)]),
      makeLine(2, [makeWord("n2", "Beta", 0, 40)]),
      makeLine(3, [makeWord("st", "Subtotal", 0, 60), makeWord("stv", "99.99", 300, 60)]),
    ];
    const ledger: LedgerEntry[] = [entry("A1", 0.0, 0, 0), entry("A2", 5.0, 1, 20), entry("A3", 99.99, 3, 60)];
    const blocks: PriceBlockInput[] = [
      { blockId: "Alpha", kind: "item", lineIndices: [0], name: "Alpha", parentBlockId: null, proposedAmountId: null },
      { blockId: "Beta", kind: "item", lineIndices: [2], name: "Beta", parentBlockId: null, proposedAmountId: null },
      { blockId: "SUB", kind: "summary", lineIndices: [3], name: "Subtotal", parentBlockId: null, proposedAmountId: null },
    ];
    const { formDetected, hypothesisAdopted, finalBlocks } = runOffsetArbitration(blocks, ledger, lines, "USD");
    assertEqual(formDetected, true);
    assertEqual(hypothesisAdopted, "H0");
    // H0's OWN baseline (unrelated to this test) already corrects Alpha's
    // anchor to line1 (its real name text) and grabs that line's own value
    // (A2, 5.00) via the pre-existing same-line first pass — exactly the
    // Hollywood Cafe mechanism. What THIS test verifies is that H0 is left
    // untouched by FIX 27 when neither hypothesis closes, not what H0's
    // own value happens to be.
    assertEqual(finalBlocks.find((b) => b.blockId === "Alpha")?.amountId, "A2");
    assertEqual(finalBlocks.find((b) => b.blockId === "Beta")?.amountId, null);
  });

  it("DG — the shape is detected and BOTH hypotheses close against the printed subtotal (a zero-valued leading orphan makes H1's sum identical to H0's): ambiguous, nothing is chosen", () => {
    const lines: OcrLine[] = [
      makeLine(0, [makeWord("v0", "0.00", 300, 0)]),
      makeLine(1, [makeWord("n1", "Alpha", 0, 20), makeWord("v1", "5.00", 300, 20)]),
      makeLine(2, [makeWord("n2", "Beta", 0, 40)]),
      makeLine(3, [makeWord("st", "Subtotal", 0, 60), makeWord("stv", "5.00", 300, 60)]),
    ];
    const ledger: LedgerEntry[] = [entry("A1", 0.0, 0, 0), entry("A2", 5.0, 1, 20), entry("A3", 5.0, 3, 60)];
    const blocks: PriceBlockInput[] = [
      { blockId: "Alpha", kind: "item", lineIndices: [0], name: "Alpha", parentBlockId: null, proposedAmountId: null },
      { blockId: "Beta", kind: "item", lineIndices: [2], name: "Beta", parentBlockId: null, proposedAmountId: null },
      { blockId: "SUB", kind: "summary", lineIndices: [3], name: "Subtotal", parentBlockId: null, proposedAmountId: null },
    ];
    const { formDetected, hypothesisAdopted, finalBlocks } = runOffsetArbitration(blocks, ledger, lines, "USD");
    assertEqual(formDetected, true);
    assertEqual(hypothesisAdopted, "AMBIGUOUS");
    assertEqual(finalBlocks.find((b) => b.blockId === "Alpha")?.amountId, null, "neither side is guessed to be right");
    assertEqual(finalBlocks.find((b) => b.blockId === "Beta")?.amountId, null);
  });

  it("DH — no printed subtotal block exists on the receipt: Step 2 never runs, H0 stands even though the shape is detected", () => {
    const lines: OcrLine[] = [
      makeLine(0, [makeWord("v0", "0.00", 300, 0)]),
      makeLine(1, [makeWord("n1", "Alpha", 0, 20), makeWord("v1", "5.00", 300, 20)]),
      makeLine(2, [makeWord("n2", "Beta", 0, 40)]),
    ];
    const ledger: LedgerEntry[] = [entry("A1", 0.0, 0, 0), entry("A2", 5.0, 1, 20)];
    const blocks: PriceBlockInput[] = [
      { blockId: "Alpha", kind: "item", lineIndices: [0], name: "Alpha", parentBlockId: null, proposedAmountId: null },
      { blockId: "Beta", kind: "item", lineIndices: [2], name: "Beta", parentBlockId: null, proposedAmountId: null },
    ];
    const { formDetected, hypothesisAdopted } = runOffsetArbitration(blocks, ledger, lines, "USD");
    assertEqual(formDetected, true);
    assertEqual(hypothesisAdopted, "H0", "no named subtotal block at all — arbitration must not run");
  });
});
