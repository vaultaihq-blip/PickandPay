import { describe, it, assert, assertEqual } from "./harness";
import {
  parseAmbiguousNumber,
  findMoneyTokens,
  buildLedgerFromOcr,
  resetAmountIdCounterForTests,
} from "../ledger";
import { normalizeVisionResponse, splitNumberWordAtGap } from "../ocr";
import type { OcrLine, OcrWord, BoundingBox } from "../ocr";
import { readFileSync } from "node:fs";

describe("ledger: parseAmbiguousNumber", () => {
  it("parses plain 2-decimal", () => {
    assertEqual(parseAmbiguousNumber("23.75"), 23.75);
  });
  it("parses decimal comma", () => {
    assertEqual(parseAmbiguousNumber("23,75"), 23.75);
  });
  it("parses dot-thousands + comma-decimal", () => {
    assertEqual(parseAmbiguousNumber("1.234,56"), 1234.56);
  });
  it("parses comma-thousands + dot-decimal", () => {
    assertEqual(parseAmbiguousNumber("1,234.56"), 1234.56);
  });
  it("parses a single-decimal-digit amount (the regression case)", () => {
    assertEqual(parseAmbiguousNumber("8.5"), 8.5);
  });
  it("parses a bare integer", () => {
    assertEqual(parseAmbiguousNumber("23"), 23);
  });
  it("parses parenthesised negative", () => {
    assertEqual(parseAmbiguousNumber("(4.50)"), -4.5);
  });
  it("parses leading-minus negative", () => {
    assertEqual(parseAmbiguousNumber("-4.50"), -4.5);
  });
});

describe("ledger: findMoneyTokens — inclusion", () => {
  it("finds a 2-decimal price at end of line", () => {
    const tokens = findMoneyTokens("1 Khao Soi                    23.75");
    assert(tokens.some((t) => t.value === 23.75), "expected to find 23.75");
  });
  it("finds a 1-decimal price (non-2-decimal format)", () => {
    const tokens = findMoneyTokens("Coffee                         8.5");
    assert(tokens.some((t) => t.value === 8.5), "expected to find 8.5");
  });
  it("finds a currency-symbol-adjacent bare integer", () => {
    const tokens = findMoneyTokens("Cover charge $10");
    assert(tokens.some((t) => t.value === 10), "expected to find 10 near a currency symbol");
  });
  it("finds a bare integer at the end of a line (label ... price layout)", () => {
    const tokens = findMoneyTokens("Service                          15");
    assert(tokens.some((t) => t.value === 15), "expected to find trailing bare integer 15");
  });
  it("finds decimal-comma amounts (EUR style)", () => {
    const tokens = findMoneyTokens("Menu du jour            12,50 EUR");
    assert(tokens.some((t) => t.value === 12.5), "expected to find 12.50");
  });
  it("finds thousands-separator amounts", () => {
    const tokens = findMoneyTokens("Grand Total          1,234.56");
    assert(tokens.some((t) => t.value === 1234.56), "expected to find 1234.56");
  });
});

describe("ledger: findMoneyTokens — exclusion", () => {
  it("excludes a date", () => {
    const tokens = findMoneyTokens("Ordered: 2025-11-29 9:13 p.m.");
    assert(!tokens.some((t) => t.value === 11), "date fragments must not become monetary tokens");
  });
  it("excludes a slash-formatted date", () => {
    const tokens = findMoneyTokens("Date: 11/29/2025");
    assertEqual(tokens.length, 0, "expected zero monetary tokens on a pure date line");
  });
  it("excludes a phone number", () => {
    const tokens = findMoneyTokens("Tel: 416-555-0192");
    assertEqual(tokens.length, 0, "expected zero monetary tokens on a phone-number line");
  });
  it("excludes an order/table number labelled by context", () => {
    const tokens = findMoneyTokens("Table #42");
    assertEqual(tokens.length, 0, "a labelled table number is not a price");
  });
  it("does not treat a mid-line bare integer with no currency cue as money", () => {
    const tokens = findMoneyTokens("Guest Count: 10 people arrived");
    assertEqual(tokens.length, 0, "a bare count mid-sentence must not become a monetary token");
  });

  it("excludes a percentage rate glued to the number: 18.00%", () => {
    const tokens = findMoneyTokens("Service Charge 18.00% applies");
    assertEqual(tokens.length, 0, "18.00% is a rate, not a monetary amount");
  });
  it("excludes a percentage rate with a space before the glued %: 18.00 %", () => {
    const tokens = findMoneyTokens("Service Charge 18.00 % applies");
    assertEqual(tokens.length, 0);
  });
  it("excludes a bare-integer percentage: 18%", () => {
    const tokens = findMoneyTokens("Service Charge 18% applies");
    assertEqual(tokens.length, 0);
  });
  it("excludes a one-decimal percentage: 18.0%", () => {
    const tokens = findMoneyTokens("Service Charge 18.0% applies");
    assertEqual(tokens.length, 0);
  });
  it("excludes a comma-decimal percentage: 18,00%", () => {
    const tokens = findMoneyTokens("Taxa de serviço 18,00% aplica-se");
    assertEqual(tokens.length, 0);
  });
  it("excludes a percentage even when '%' is its own adjacent OCR token (reconstructed line has a space before it)", () => {
    // Simulates two separate OCR words ("18.00" and "%") joined with a
    // single space by line reconstruction — still immediate adjacency.
    const tokens = findMoneyTokens("Service Charge 18.00  % applies");
    assertEqual(tokens.length, 0);
  });
  it("still accepts a legitimate monetary value on the same line as a percentage (adjacency only, not whole-line)", () => {
    const tokens = findMoneyTokens("Service (18.00%)          67.36");
    assert(tokens.some((t) => t.value === 67.36), "a real price elsewhere on the line must still be found");
    assert(!tokens.some((t) => t.value === 18), "the percentage itself must still be excluded");
  });
});

// ─── buildLedgerFromOcr fixtures ────────────────────────────────────────────
//
// Builds synthetic OcrLine/OcrWord structures directly (bypassing ocr.ts's
// geometry-based line reconstruction, which has its own dedicated tests) so
// these tests focus purely on: does a money-shaped OCR word become a ledger
// entry correctly anchored to that specific word's id/box/confidence.

function box(id: number): BoundingBox {
  // Distinct per call so a test can assert a ledger entry's boundingBox is
  // the SPECIFIC word's box, not some other word's or a blank default.
  return { vertices: [{ x: id, y: id }, { x: id + 10, y: id }, { x: id + 10, y: id + 5 }, { x: id, y: id + 5 }] };
}

function makeLine(lineIndex: number, wordSpecs: Array<{ text: string; confidence?: number }>): OcrLine {
  let text = "";
  const words: OcrLine["words"] = [];
  wordSpecs.forEach((spec, i) => {
    if (text.length > 0) text += " ";
    const start = text.length;
    text += spec.text;
    const word: OcrWord = {
      wordId: `L${lineIndex}W${i}`,
      text: spec.text,
      boundingBox: box(lineIndex * 100 + i),
      confidence: spec.confidence ?? 0.99,
      lineIndex,
      breakType: null,
    };
    words.push({ word, start, end: text.length });
  });
  return { lineIndex, text, words };
}

describe("ledger: buildLedgerFromOcr", () => {
  it("anchors a ledger entry to the specific OCR word that produced it", () => {
    resetAmountIdCounterForTests();
    const line = makeLine(0, [{ text: "1" }, { text: "Khao" }, { text: "Soi" }, { text: "23.75" }]);
    const ledger = buildLedgerFromOcr([line]);
    assertEqual(ledger.length, 1);
    assertEqual(ledger[0].value, 23.75);
    assertEqual(ledger[0].wordId, "L0W3", "expected the entry anchored to the word carrying the price, not the whole line");
    assertEqual(ledger[0].lineIndex, 0);
  });

  it("carries the OCR word's own confidence onto the ledger entry", () => {
    resetAmountIdCounterForTests();
    const line = makeLine(0, [{ text: "Coffee" }, { text: "3.50", confidence: 0.42 }]);
    const ledger = buildLedgerFromOcr([line]);
    assertEqual(ledger.length, 1);
    assertEqual(ledger[0].ocrConfidence, 0.42);
  });

  it("never dedups repeated identical values — each stays a distinct amountId", () => {
    resetAmountIdCounterForTests();
    const lines = [
      makeLine(0, [{ text: "Item" }, { text: "A" }, { text: "9.00" }]),
      makeLine(1, [{ text: "Item" }, { text: "B" }, { text: "9.00" }]),
      makeLine(2, [{ text: "Item" }, { text: "C" }, { text: "9.00" }]),
      makeLine(3, [{ text: "Item" }, { text: "D" }, { text: "9.00" }]),
      makeLine(4, [{ text: "Item" }, { text: "E" }, { text: "9.00" }]),
    ];
    const ledger = buildLedgerFromOcr(lines);
    assertEqual(ledger.length, 5);
    assertEqual(new Set(ledger.map((e) => e.amountId)).size, 5, "expected 5 distinct amountIds, never merged");
  });

  it("produces no ledger entry for a line with no money-shaped OCR word (e.g. a date)", () => {
    resetAmountIdCounterForTests();
    const line = makeLine(0, [{ text: "Date:" }, { text: "11/29/2025" }]);
    const ledger = buildLedgerFromOcr([line]);
    assertEqual(ledger.length, 0);
  });

  it("attaches the exact bounding box of the anchoring word, not another word's", () => {
    resetAmountIdCounterForTests();
    const line = makeLine(0, [{ text: "Tax" }, { text: "5.00" }]);
    const ledger = buildLedgerFromOcr([line]);
    const priceWord = line.words[1].word;
    assertEqual(ledger[0].boundingBox, priceWord.boundingBox);
  });
});

// ─── FIX 15.2 — space as a thousands separator, disambiguated by column ────
//
// makeLine (above) packs every word at nearly-identical X, which can never
// exercise column disambiguation. These tests build lines with explicit,
// controlled X positions instead: a "quantity" word placed far left, a
// "price" word placed far right, matching a real receipt's two-column
// layout.

function boxAt(x: number, width = 30): BoundingBox {
  return { vertices: [{ x, y: 0 }, { x: x + width, y: 0 }, { x: x + width, y: 10 }, { x, y: 10 }] };
}

function wordAt(wordId: string, text: string, x: number, width = 30): OcrWord {
  return { wordId, text, boundingBox: boxAt(x, width), confidence: 0.99, lineIndex: 0, breakType: null };
}

/** Builds one OcrLine from words the caller has already positioned. */
function lineFromWords(lineIndex: number, wordSpecs: Array<{ word: OcrWord }>): OcrLine {
  let text = "";
  const words: OcrLine["words"] = [];
  for (const { word } of wordSpecs) {
    if (text.length > 0) text += " ";
    const start = text.length;
    text += word.text;
    words.push({ word: { ...word, lineIndex }, start, end: text.length });
  }
  return { lineIndex, text, words };
}

describe("ledger: FIX 15.2 — space-separated quantity/price never collapses across a column gap", () => {
  it("a quantity in a far-left column and a price in a far-right column split into two tokens, never glued", () => {
    resetAmountIdCounterForTests();
    // Two ordinary rows establish the receipt's own price column (far
    // right, ~X=500) as the corroborating signal.
    const row1 = lineFromWords(0, [{ word: wordAt("L0W0", "Widget", 10) }, { word: wordAt("L0W1", "45.00", 500) }]);
    const row2 = lineFromWords(1, [{ word: wordAt("L1W0", "Gadget", 10) }, { word: wordAt("L1W1", "12.00", 500) }]);
    // The bug row: a quantity "3" far left (same column as the item names)
    // and a price "130.00" far right (same column as the other prices) —
    // exactly the V&RO Bengaluru shape.
    const row3 = lineFromWords(2, [{ word: wordAt("L2W0", "3", 10) }, { word: wordAt("L2W1", "130.00", 500) }]);
    const ledger = buildLedgerFromOcr([row1, row2, row3]);

    assert(!ledger.some((e) => e.value === 3130), "the quantity and price must never collapse into 3130.00");
    assert(ledger.some((e) => e.value === 130 && e.lineIndex === 2), "the real price 130.00 must survive as its own entry");
    assert(!ledger.some((e) => e.value === 3 && e.lineIndex === 2), "the bare quantity 3 must not become a phantom ledger entry (it fails findMoneyTokens' own bare-integer rule)");
  });

  it("a large quantity and a small price still split — never a magnitude rule", () => {
    resetAmountIdCounterForTests();
    const row1 = lineFromWords(0, [{ word: wordAt("L0W0", "Widget", 10) }, { word: wordAt("L0W1", "45.00", 500) }]);
    const row2 = lineFromWords(1, [{ word: wordAt("L1W0", "10", 10) }, { word: wordAt("L1W1", "225.00", 500) }]);
    const ledger = buildLedgerFromOcr([row1, row2]);
    assert(!ledger.some((e) => e.value === 10225), "quantity 10 + price 225.00 must never glue into 10225.00, regardless of which number is larger");
    assert(ledger.some((e) => e.value === 225 && e.lineIndex === 1));
  });

  it("two digit groups printed in the SAME column, corroborated by other same-column values elsewhere, stay merged as one genuine thousands-grouped number", () => {
    resetAmountIdCounterForTests();
    // Several other, unrelated prices landing in the same right-edge band
    // (~135-145, with the small natural variation real digit widths
    // produce) as the "3"/"130.00" digit groups below — real,
    // multi-point corroborating column evidence, each from a genuinely
    // separate line (a single identical-X pair alone isn't enough signal
    // to distinguish "one column" from "coincidence" — the same reasoning
    // columns.ts itself applies).
    const row1 = lineFromWords(0, [{ word: wordAt("L0W0", "Widget", 90) }, { word: wordAt("L0W1", "45.00", 118, 20) }]);
    const row2 = lineFromWords(1, [{ word: wordAt("L1W0", "Gizmo", 90) }, { word: wordAt("L1W1", "9.00", 122, 18) }]);
    const row3 = lineFromWords(2, [{ word: wordAt("L2W0", "Sprocket", 90) }, { word: wordAt("L2W1", "12.50", 116, 24) }]);
    // "3" and "130.00" printed immediately adjacent, both inside that same
    // column band — a genuine "3.130,00"-shaped figure with a space
    // instead of a thousands dot.
    const row4 = lineFromWords(3, [{ word: wordAt("L3W0", "3", 100, 8) }, { word: wordAt("L3W1", "130.00", 110, 30) }]);
    const ledger = buildLedgerFromOcr([row1, row2, row3, row4]);
    assert(ledger.some((e) => e.value === 3130), "two digit groups in the same column, with corroborating same-column evidence, must merge into one grouped number");
  });

  it("with zero other decimal-shaped evidence anywhere on the receipt, a space-grouped run is split, not silently trusted", () => {
    resetAmountIdCounterForTests();
    const row = lineFromWords(0, [{ word: wordAt("L0W0", "3", 10) }, { word: wordAt("L0W1", "130.00", 500) }]);
    const ledger = buildLedgerFromOcr([row]);
    assert(!ledger.some((e) => e.value === 3130), "no column corroboration at all — never merge on faith");
  });
});

// ─── 03-11-2026 — "Çerez & Meyva   1     600,00" read as 1600 ─────────────
//
// Reproduced on the real Oligark Vision response: moving the whole price
// column left (a photo taken from further away) shrinks the gap between the
// quantity "1" and "600,00"; at 10–20 px the code of parse-receipt v59 read
// 1600. The quantity sits in the receipt's quantity column, so it must split.
const OLIGARK_FIXTURE = new URL("../../../../backups/corpus-vision-2026-11-03/vision-oligark-tr.json", import.meta.url);

function oligarkWithGap(gapPx: number): OcrLine[] {
  const vision = JSON.parse(readFileSync(OLIGARK_FIXTURE, "utf8"));
  const text = (w: any) => (w.symbols ?? []).map((s: any) => s.text).join("");
  const xs = (w: any) => w.boundingBox.vertices.map((v: any) => v.x ?? 0);
  const words: any[] = [];
  for (const page of vision.fullTextAnnotation.pages) for (const bl of page.blocks) for (const p of bl.paragraphs) words.push(...p.words);
  const price = words.find((w) => text(w) === "600,00");
  const pY = Math.min(...price.boundingBox.vertices.map((v: any) => v.y ?? 0));
  const one = words.find((w) => text(w) === "1" && Math.abs(Math.min(...w.boundingBox.vertices.map((v: any) => v.y ?? 0)) - pY) < 20);
  const dx = Math.max(...xs(one)) + gapPx - Math.min(...xs(price));
  const col = Math.min(...xs(price)) - 5;
  for (const w of words) {
    if (Math.min(...xs(w)) < col) continue;
    w.boundingBox.vertices.forEach((v: any) => (v.x = (v.x ?? 0) + dx));
    (w.symbols ?? []).forEach((s: any) => s.boundingBox?.vertices.forEach((v: any) => (v.x = (v.x ?? 0) + dx)));
  }
  return normalizeVisionResponse(vision, { geometricReconstruction: true }).lines;
}

// The main case of this bug (03-11-2026): a real photo of the Oligark, as the
// app sends it (1478×3200). Vision itself returned "1600,00" as ONE word, with
// 73 px between the "1" and the "6" — v61 read 1600.
const REAL_1600_FIXTURE = new URL("../../../../corpus/oligark-istanbul-real-1600-sent.vision.json", import.meta.url);

describe("ocr: a number word with a wide gap inside is two words (03-11-2026)", () => {
  it("real Oligark photo: the Çerez line reads 1 and 600,00, never 1600", () => {
    resetAmountIdCounterForTests();
    const lines = normalizeVisionResponse(JSON.parse(readFileSync(REAL_1600_FIXTURE, "utf8")), { geometricReconstruction: true }).lines;
    const cerez = lines.findIndex((l) => /erez/i.test(l.text));
    assert(cerez >= 0, "the Çerez line is there");
    assertEqual(lines[cerez].text, "Çerez & Meyva 1 600,00");
    const values = buildLedgerFromOcr(lines).filter((e) => e.lineIndex === cerez).map((e) => e.value);
    assert(values.includes(600) && !values.includes(1600), `read ${JSON.stringify(values)}`);
  });

  const sym = (text: string, x0: number, x1: number) => ({ text, boundingBox: { vertices: [{ x: x0, y: 0 }, { x: x1, y: 0 }, { x: x1, y: 20 }, { x: x0, y: 20 }] } });
  it("splits at a gap wider than 2 letters", () => {
    const s = splitNumberWordAtGap([sym("1", 0, 20), sym("6", 90, 115), sym("0", 117, 142), sym("0", 144, 169)]);
    assert(s !== null && s.left.text === "1" && s.right.text === "600", JSON.stringify(s));
  });
  it("keeps a word whose letters are close together", () => {
    assertEqual(splitNumberWordAtGap([sym("1", 0, 20), sym(".", 24, 30), sym("1", 34, 54), sym("0", 58, 82)]), null);
  });
  it("never splits a word that is not a number", () => {
    assertEqual(splitNumberWordAtGap([sym("A", 0, 20), sym("B", 90, 115)]), null);
  });
});

describe("ledger: a quantity never glues onto the price (03-11-2026)", () => {
  for (const gap of [20, 10]) {
    it(`Oligark, ${gap} px between "1" and "600,00": 600, never 1600`, () => {
      resetAmountIdCounterForTests();
      const lines = oligarkWithGap(gap);
      const cerez = lines.findIndex((l) => /erez/i.test(l.text));
      const values = buildLedgerFromOcr(lines).filter((e) => e.lineIndex === cerez).map((e) => e.value);
      assert(!values.includes(1600), `read ${JSON.stringify(values)}`);
      assert(values.includes(600), `read ${JSON.stringify(values)}`);
    });
  }

  it("a real space-grouped thousands figure, corroborated by its column, stays one number", () => {
    resetAmountIdCounterForTests();
    // the same corroborated price column as FIX 15.2's merge test, plus "1 100,00"
    const row1 = lineFromWords(0, [{ word: wordAt("L0W0", "Widget", 10) }, { word: wordAt("L0W1", "45.00", 118, 20) }]);
    const row2 = lineFromWords(1, [{ word: wordAt("L1W0", "Gizmo", 10) }, { word: wordAt("L1W1", "9.00", 122, 18) }]);
    const row3 = lineFromWords(2, [{ word: wordAt("L2W0", "Sprocket", 10) }, { word: wordAt("L2W1", "12.50", 116, 24) }]);
    const row4 = lineFromWords(3, [{ word: wordAt("L3W0", "TOTAL", 10) }, { word: wordAt("L3W1", "1", 100, 8) }, { word: wordAt("L3W2", "100.00", 110, 30) }]);
    const ledger = buildLedgerFromOcr([row1, row2, row3, row4]);
    assert(ledger.some((e) => e.value === 1100), "1 100.00 printed as one figure is 1100");
  });

  it("other space-grouped figures never count as a quantity column", () => {
    resetAmountIdCounterForTests();
    const row1 = lineFromWords(0, [{ word: wordAt("L0W0", "Widget", 10) }, { word: wordAt("L0W1", "45.00", 118, 20) }]);
    const row2 = lineFromWords(1, [{ word: wordAt("L1W0", "Gizmo", 10) }, { word: wordAt("L1W1", "9.00", 122, 18) }]);
    const row3 = lineFromWords(2, [{ word: wordAt("L2W0", "Sprocket", 10) }, { word: wordAt("L2W1", "12.50", 116, 24) }]);
    const row4 = lineFromWords(3, [{ word: wordAt("L3W0", "Sub", 10) }, { word: wordAt("L3W1", "1", 100, 8) }, { word: wordAt("L3W2", "100.00", 110, 30) }]);
    const row5 = lineFromWords(4, [{ word: wordAt("L4W0", "TOTAL", 10) }, { word: wordAt("L4W1", "1", 100, 8) }, { word: wordAt("L4W2", "100.00", 110, 30) }]);
    const ledger = buildLedgerFromOcr([row1, row2, row3, row4, row5]);
    assert(ledger.filter((e) => e.value === 1100).length === 2, "each 1 100.00 stays 1100");
  });
});

// ─── FIX 36 — a number token must consume the whole contiguous run ─────────
//
// NUMBER_TOKEN_PATTERN required thousands to come separator-grouped; a long
// number printed WITHOUT one (common outside a few locales — India, Japan,
// many European POS systems) couldn't be decomposed by that grammar at all,
// so the regex silently matched only a PIECE of it: "4525.00" (V&RO's own
// real total, FIX 30) matched just "5.00"; "500094969" (Sulbarreiro's own
// loyalty ID, FIX 35) matched just "969", which then polluted a column
// band. Reading a fragment of a printed number is worse than not reading it
// — a wrong value shown with full confidence, or a value that exists
// nowhere on the receipt.

describe("ledger: FIX 36 — a number token must consume the whole word, or match nothing", () => {
  it("FB — a long amount with no thousands separator extracts whole, never a fragment (V&RO's own bug)", () => {
    const tokens = findMoneyTokens("Total Amount          4525.00");
    assert(tokens.some((t) => t.value === 4525), "expected the whole 4525.00");
    assert(!tokens.some((t) => t.value === 5), "must never produce the old wrong fragment, 5.00");
  });

  it("FC — a long bare digit run with no decimal and no currency cue produces no monetary token at all, even last-on-line (Sulbarreiro's own ID number)", () => {
    const tokens = findMoneyTokens("Promotion Applied in Sale - ID 500094969");
    assertEqual(tokens.length, 0, "a 9-digit bare ID must never become money");
  });

  it("FD — a comma-thousands amount is unaffected (Cedarstay's own shape)", () => {
    const tokens = findMoneyTokens("Total                3,590.00");
    assert(tokens.some((t) => t.value === 3590));
  });

  it("FE — a dot-thousands, comma-decimal amount is unaffected (European format)", () => {
    const tokens = findMoneyTokens("Gesamtbetrag           1.234,56");
    assert(tokens.some((t) => t.value === 1234.56));
  });

  it("FF — '34,502' still resolves to 34502, unchanged — the app never silently decides which reading (34,50 vs 34502) is correct", () => {
    const tokens = findMoneyTokens("Currywurst + Pommes    34,502");
    assert(
      tokens.some((t) => t.value === 34502),
      "stays exactly as parseAmbiguousNumber already reads it — unresolved, and still the arithmetic-contradiction check's own job (FIX 35 Part 4) to flag, never this fix's to correct"
    );
  });

  it("FG — FIX 15.2 stays intact: a quantity and price in separate columns still split into two tokens, never glued (V&RO's own shape, re-verified under this fix)", () => {
    resetAmountIdCounterForTests();
    const row1 = lineFromWords(0, [{ word: wordAt("L0W0", "Widget", 10) }, { word: wordAt("L0W1", "45.00", 500) }]);
    const row2 = lineFromWords(1, [{ word: wordAt("L1W0", "Gadget", 10) }, { word: wordAt("L1W1", "12.00", 500) }]);
    const row3 = lineFromWords(2, [{ word: wordAt("L2W0", "3", 10) }, { word: wordAt("L2W1", "130.00", 500) }]);
    const ledger = buildLedgerFromOcr([row1, row2, row3]);
    assert(!ledger.some((e) => e.value === 3130), "quantity 3 + price 130.00 must never glue into 3130.00 under the new pattern either");
    assert(ledger.some((e) => e.value === 130 && e.lineIndex === 2), "the real price 130.00 must still survive as its own entry");
  });

  it("FH — a long bare number with no decimal in the items region produces no ledger entry at all", () => {
    resetAmountIdCounterForTests();
    const line = makeLine(0, [{ text: "Guest" }, { text: "ID" }, { text: "500094969" }]);
    const ledger = buildLedgerFromOcr([line]);
    assertEqual(ledger.length, 0, "no fragment, and no whole-run bare integer either — this ID must never enter the ledger");
  });
});
