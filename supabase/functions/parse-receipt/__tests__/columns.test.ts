/**
 * FIX 11 (Group 1) — column disambiguation, proven against the real
 * fixtures exactly like fixture-rotation.test.ts's test J: no network call,
 * deterministic OCR + ledger construction, real captured Vision responses.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, assert, assertEqual } from "./harness";
import { normalizeVisionResponse, resetWordIdCounterForTests } from "../ocr";
import { buildLedgerFromOcr, resetAmountIdCounterForTests } from "../ledger";
import { detectAuthoritativeColumn, filterToAuthoritativeColumn } from "../columns";
import type { OcrLine, OcrWord, BoundingBox } from "../ocr";
import type { LedgerEntry } from "../ledger";

function loadFixture(name: string) {
  const path = join(process.cwd(), "supabase/functions/parse-receipt/__fixtures__/", name);
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  resetWordIdCounterForTests();
  const ocr = normalizeVisionResponse(raw);
  resetAmountIdCounterForTests();
  const ledger = buildLedgerFromOcr(ocr.lines);
  return { ocr, ledger };
}

function excludedIds(kept: LedgerEntry[], full: LedgerEntry[]): Set<string> {
  const keptIds = new Set(kept.map((e) => e.amountId));
  return new Set(full.filter((e) => !keptIds.has(e.amountId)).map((e) => e.amountId));
}

/**
 * FIX 40 — finds a ledger entry by its RAW TEXT, anchored to a nearby line
 * matching `marker` (a real, distinctive substring from the receipt's own
 * printed content) rather than a hardcoded lineIndex. Line numbers shift
 * whenever line reconstruction changes (FIX 39's own geometric path
 * consolidates many of these fixtures' lines); the printed CONTENT does
 * not. `maxDistance` tolerates the value landing on the same reconstructed
 * line as the marker (0) or a few lines away (whichever reconstruction is
 * active) without needing to know which.
 */
function findEntryNear(
  ocr: { lines: OcrLine[] },
  ledger: LedgerEntry[],
  marker: string,
  rawText: string,
  maxDistance = 3,
  which: "first" | "last" = "first"
): LedgerEntry | undefined {
  const markerLine = ocr.lines.find((l) => l.text.includes(marker));
  if (!markerLine) return undefined;
  const matches = ledger.filter((e) => e.rawText === rawText && Math.abs(e.lineIndex - markerLine.lineIndex) <= maxDistance);
  if (matches.length === 0) return undefined;
  return which === "first" ? matches[0] : matches[matches.length - 1];
}

describe("columns: Y — a number inside the item's own name, outside the authoritative column, is never a candidate (Quebra Mar)", () => {
  it("excludes the '2.00' embedded in 'FINO 2.00 €', keeps the real 5,25 VALOR entry elsewhere", () => {
    const { ocr, ledger } = loadFixture("vision-quebra-mar-pt.json");
    const finoEmbedded = findEntryNear(ocr, ledger, "FINO", "2.00", 0);
    assert(finoEmbedded !== undefined, "fixture must still contain the FINO name-embedded '2.00' token");
    const realValor = findEntryNear(ocr, ledger, "SAFATA", "5,25", 3);
    assert(realValor !== undefined, "fixture must still contain the real 5,25 VALOR entry (near 'SAFATA DE PAO', an unrelated earlier item)");

    const filtered = filterToAuthoritativeColumn(ledger, ocr.lines, new Set());
    const excluded = excludedIds(filtered, ledger);
    assert(excluded.has(finoEmbedded!.amountId), "the name-embedded '2.00' must be excluded from the authoritative column");
    assert(!excluded.has(realValor!.amountId), "the real VALOR entry must remain a candidate");
  });
});

describe("columns: Z — a decimal-formatted quantity in the leftmost column is never a candidate (Mad God)", () => {
  it("excludes the '1.00' quantity, keeps the real 2,75 Valor entry on the same item", () => {
    const { ocr, ledger } = loadFixture("vision-madgod-pt.json");
    const quantity = findEntryNear(ocr, ledger, "Heineken", "1.00", 0);
    assert(quantity !== undefined, "fixture must still contain the '1.00 Cerveja Heineken' quantity token");
    // This item prints "2,75" TWICE nearby (its own unit price, then its
    // line total/Valor) — the LATER occurrence (highest lineIndex, printed
    // last) is the real Valor; the earlier one is the unit price, a
    // different value this test isn't about.
    const realValor = findEntryNear(ocr, ledger, "Heineken", "2,75", 3, "last");
    assert(realValor !== undefined, "fixture must still contain the real Valor entry for this item");

    const filtered = filterToAuthoritativeColumn(ledger, ocr.lines, new Set());
    const excluded = excludedIds(filtered, ledger);
    assert(excluded.has(quantity!.amountId), "the well-formed decimal quantity must be excluded — shape alone can never distinguish it from a price");
    assert(!excluded.has(realValor!.amountId), "the real Valor entry must remain a candidate");
  });
});

describe("columns: AA — two value columns on the same line; the authoritative one is the right column, and the correct value is zero (Sulbarreiro)", () => {
  it("excludes the UNID column's 5.20, keeps the TOTAL column's real 0.00 — never prefers the non-zero value", () => {
    const { ocr, ledger } = loadFixture("vision-sulbarreiro-pt.json");
    const unidColumn = findEntryNear(ocr, ledger, "Double Chees", "5.20", 0);
    assert(unidColumn !== undefined, "fixture must still contain 'Double Chees 5.20' UNID entry");
    const totalColumn = findEntryNear(ocr, ledger, "Double Chees", "0.00", 3);
    assert(totalColumn !== undefined, "fixture must still contain the real 0.00 TOTAL entry");

    const filtered = filterToAuthoritativeColumn(ledger, ocr.lines, new Set());
    const excluded = excludedIds(filtered, ledger);
    assert(excluded.has(unidColumn!.amountId), "the wrong (non-authoritative) column's 5.20 must be excluded");
    assert(!excluded.has(totalColumn!.amountId), "the authoritative column's real 0.00 must be kept — a solution that prefers non-zero values fails exactly here");
  });
});

describe("columns: AB — a unit-price annotation line's value is never a line-price candidate (Quebra Mar 'Preco:')", () => {
  it("excludes every 'Preco : X / Uni' annotation value", () => {
    const { ocr, ledger } = loadFixture("vision-quebra-mar-pt.json");
    // "Preco:" appears once per item on this receipt — the combined marker
    // (both "Preco" AND "1,75" on the same reconstructed line) picks out
    // this SPECIFIC annotation line regardless of which item's annotation
    // it is or which line index it lands on.
    const annotationLine = ocr.lines.find((l) => l.text.includes("Preco") && l.text.includes("1,75"));
    assert(annotationLine !== undefined, "fixture must still contain a 'Preco: 1,75/Uni' annotation line");
    const annotation = ledger.find((e) => e.lineIndex === annotationLine!.lineIndex && e.rawText === "1,75");
    assert(annotation !== undefined, "fixture must still contain the 'Preco : 1,75 / Uni' annotation entry");

    const filtered = filterToAuthoritativeColumn(ledger, ocr.lines, new Set());
    const excluded = excludedIds(filtered, ledger);
    assert(excluded.has(annotation!.amountId), "a unit-price annotation line's value must never be a line-total candidate");
  });
});

describe("columns: AC — a unit price on its own line, above the item name, is never a candidate (Augustiner)", () => {
  it("excludes '4,20' from '8 x 4,20' and '11,50' from '3 x 11,50'", () => {
    const { ocr, ledger } = loadFixture("vision-augustiner-de.json");
    const helles = findEntryNear(ocr, ledger, "x4,20", "4,20", 0);
    assert(helles !== undefined, "fixture must still contain the '8 x 4,20' unit-price entry");
    // "11,50" also prints later as "Leberkäs 11,50" (a different item's own
    // line total) — anchoring on "x 11,50" / "x11,50" (the multiplier
    // notation) picks out specifically the "3 x 11,50" unit-price line, not
    // that unrelated later occurrence.
    const curryLine = ocr.lines.find((l) => /x\s*11,50/.test(l.text));
    assert(curryLine !== undefined, "fixture must still contain a '3 x 11,50' unit-price line");
    const curry = ledger.find((e) => e.lineIndex === curryLine!.lineIndex && e.rawText === "11,50");
    assert(curry !== undefined, "fixture must still contain the '3 x 11,50' unit-price entry");

    const filtered = filterToAuthoritativeColumn(ledger, ocr.lines, new Set());
    const excluded = excludedIds(filtered, ledger);
    assert(excluded.has(helles!.amountId), "a unit price printed above the item name must never be a line-price candidate");
    assert(excluded.has(curry!.amountId), "same for the second item's own unit-price-above-name line");
  });
});

describe("columns: AD — a single-column receipt is not artificially split (Toronto)", () => {
  it("keeps every decimal-formatted item/modifier/summary value as one authoritative band", () => {
    const { ocr, ledger } = loadFixture("vision-pai-toronto-rotated.json");
    const decimalEntries = ledger.filter((e) => /[.,]\d{2}$/.test(e.rawText));
    assert(decimalEntries.length > 20, "sanity check: this fixture has plenty of decimal entries");

    const filtered = filterToAuthoritativeColumn(ledger, ocr.lines, new Set());
    const keptIds = new Set(filtered.map((e) => e.amountId));
    // Bare-integer noise (table numbers, postal-code fragments) is correctly
    // dropped by this filter too — that's not what this test is about; it's
    // about the single, real decimal-value column not being fragmented.
    const excludedDecimals = decimalEntries.filter((e) => !keptIds.has(e.amountId));
    assertEqual(excludedDecimals.length, 0, "a genuinely single-column receipt must not have any of its real decimal values excluded");
  });
});

describe("columns: AE — a gradually drifting value column is still identified as one band (synthetic)", () => {
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
  function entry(amountId: string, value: number, lineIndex: number, x: number, y: number): LedgerEntry {
    return { amountId, wordId: `W_${amountId}`, rawText: value.toFixed(2), value, lineIndex, boundingBox: box(x, y), ocrConfidence: 0.99, source: "ocr" };
  }

  it("a value column whose X drifts smoothly down the page stays one band, distinct from a fixed noise column", () => {
    const n = 20;
    const lines: OcrLine[] = [];
    const ledger: LedgerEntry[] = [];
    for (let i = 0; i < n; i++) {
      const y = i * 100;
      // Noise column: fixed at X=0, tiny bare-integer-shaped text (not
      // decimal-formatted, so it never enters column analysis anyway — a
      // stand-in for a table/order number repeated down the page).
      lines.push(makeLine(i * 2, [makeWord(`noise${i}`, "7", 0, y)]));
      // Value column: drifts smoothly by 2.5 units/row (50 units total
      // across the receipt) while its own row-to-row spacing (2.5) stays
      // far smaller than its separation from the noise column (always
      // >= 100).
      const driftX = 300 + i * 2.5;
      lines.push(makeLine(i * 2 + 1, [makeWord(`val${i}`, (i + 1).toFixed(2), driftX, y)]));
      ledger.push(entry(`A${i}`, i + 1, i * 2 + 1, driftX, y));
    }

    const band = detectAuthoritativeColumn(ledger, lines, new Set());
    assert(band !== null, "must detect a band at all");
    assertEqual(band!.memberIds.length, n, "the drifting value column must form ONE band, not be fragmented by its own drift");

    const filtered = filterToAuthoritativeColumn(ledger, lines, new Set());
    assertEqual(filtered.length, n, "every drifting value entry must remain a candidate");
  });
});
