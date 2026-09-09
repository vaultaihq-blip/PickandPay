import { describe, it, assert, assertEqual } from "./harness";
import {
  parseAmbiguousNumber,
  findMoneyTokens,
  buildLedgerFromOcr,
  resetAmountIdCounterForTests,
} from "../ledger";
import type { OcrLine, OcrWord, BoundingBox } from "../ocr";

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
