import { describe, it, assert, assertEqual } from "./harness";
import { computeGeometricOwnership, type PriceBlockInput } from "../ownership";
import type { LedgerEntry } from "../ledger";
import type { OcrLine, OcrWord, BoundingBox } from "../ocr";

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
