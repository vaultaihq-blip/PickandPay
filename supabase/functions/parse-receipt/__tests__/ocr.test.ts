import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, assert, assertEqual } from "./harness";
import {
  reconstructLines,
  normalizeVisionResponse,
  resetWordIdCounterForTests,
  type OcrWord,
  type BoundingBox,
} from "../ocr";
import { buildLedgerFromOcr, resetAmountIdCounterForTests } from "../ledger";

function loadFixture(name: string) {
  const path = join(process.cwd(), "supabase/functions/parse-receipt/__fixtures__/", name);
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  resetWordIdCounterForTests();
  const ocr = normalizeVisionResponse(raw);
  resetAmountIdCounterForTests();
  const ledger = buildLedgerFromOcr(ocr.lines);
  return { ocr, ledger };
}

function rectBox(x: number, y: number, w: number, h: number): BoundingBox {
  return {
    vertices: [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ],
  };
}

/** A box already rotated ~90°: tall and narrow, matching the real fixture's
 *  geometry for an EXIF-rotated photo (raw pixel width small, raw pixel
 *  height large, for a word that reads horizontally once displayed
 *  upright). Used to prove the fallback path is rotation-independent, not
 *  just the primary word-order path. */
function rotatedBox(centerX: number, centerY: number, thickness = 20, extent = 60): BoundingBox {
  const hw = thickness / 2;
  const he = extent / 2;
  return {
    vertices: [
      { x: centerX - hw, y: centerY - he },
      { x: centerX + hw, y: centerY - he },
      { x: centerX + hw, y: centerY + he },
      { x: centerX - hw, y: centerY + he },
    ],
  };
}

function word(
  id: string,
  text: string,
  box: BoundingBox,
  breakType: string | null = null,
  confidence = 0.99
): OcrWord {
  return { wordId: id, text, boundingBox: box, confidence, lineIndex: -1, breakType };
}

describe("ocr: reconstructLines — primary path (word order + break type)", () => {
  it("uses word order and LINE_BREAK to split lines, ignoring geometry entirely", () => {
    // Deliberately scrambled geometry (as if from a rotated photo) — the
    // primary path must not care, since it never looks at coordinates. Uses
    // non-price content so the (separately tested) two-column merge pass
    // can't interfere with isolating this specific claim.
    const words = [
      word("w1", "Zebra", rectBox(900, 50, 10, 10), null),
      word("w2", "Apple", rectBox(10, 900, 10, 10), "LINE_BREAK"),
      word("w3", "Mango", rectBox(500, 5, 10, 10), null),
      word("w4", "Banana", rectBox(5, 5, 10, 10), "LINE_BREAK"),
    ];
    const lines = reconstructLines(words);
    assertEqual(lines.length, 2);
    assertEqual(lines[0].text, "Zebra Apple");
    assertEqual(lines[1].text, "Mango Banana");
  });

  it("EOL_SURE_SPACE also terminates a line", () => {
    const words = [
      word("w1", "Alpha", rectBox(0, 0, 10, 10), "EOL_SURE_SPACE"),
      word("w2", "Beta", rectBox(0, 0, 10, 10), "LINE_BREAK"),
    ];
    const lines = reconstructLines(words);
    assertEqual(lines.length, 2);
    assertEqual(lines[0].text, "Alpha");
    assertEqual(lines[1].text, "Beta");
  });

  it("HYPHEN terminates a line (documented choice: our word-level model holds no sub-word fragments)", () => {
    const words = [
      word("w1", "Kitchen-", rectBox(0, 0, 10, 10), "HYPHEN"),
      word("w2", "Uptown", rectBox(0, 0, 10, 10), "LINE_BREAK"),
    ];
    const lines = reconstructLines(words);
    assertEqual(lines.length, 2);
  });

  it("SPACE and SURE_SPACE do not terminate a line", () => {
    const words = [
      word("w1", "Pai", rectBox(0, 0, 10, 10), "SPACE"),
      word("w2", "Northern", rectBox(0, 0, 10, 10), "SURE_SPACE"),
      word("w3", "Thai", rectBox(0, 0, 10, 10), "LINE_BREAK"),
    ];
    const lines = reconstructLines(words);
    assertEqual(lines.length, 1);
    assertEqual(lines[0].text, "Pai Northern Thai");
  });

  it("a missing/null break type defaults to non-terminating, never falls back to raw geometry when other words have break info", () => {
    const words = [
      word("w1", "Server", rectBox(0, 0, 10, 10), null),
      word("w2", ":", rectBox(0, 0, 10, 10), null),
      word("w3", "Kevin", rectBox(0, 0, 10, 10), "LINE_BREAK"),
    ];
    const lines = reconstructLines(words);
    assertEqual(lines.length, 1);
    assertEqual(lines[0].text, "Server : Kevin");
  });

  it("closes a trailing group with no explicit terminating break at the end of the document", () => {
    const words = [word("w1", "HST", rectBox(0, 0, 10, 10), "SPACE"), word("w2", "707577110", rectBox(0, 0, 10, 10), null)];
    const lines = reconstructLines(words);
    assertEqual(lines.length, 1);
    assertEqual(lines[0].text, "HST 707577110");
  });
});

describe("ocr: reconstructLines — geometric fallback (no usable break metadata at all)", () => {
  it("groups an upright, break-free document by normalized position", () => {
    const words = [
      word("w1", "Subtotal", rectBox(0, 100, 60, 20), null),
      word("w2", "374.25", rectBox(300, 100, 60, 20), null),
      word("w3", "Total", rectBox(0, 200, 60, 20), null),
      word("w4", "499.03", rectBox(300, 200, 60, 20), null),
    ];
    const lines = reconstructLines(words);
    assertEqual(lines.length, 2);
    assertEqual(lines[0].text, "Subtotal 374.25");
    assertEqual(lines[1].text, "Total 499.03");
  });

  it("is rotation-independent: a ~90°-rotated, break-free document still groups correctly by dominant-angle normalization", () => {
    // Two "rows" laid out along the X axis (as a genuinely rotated photo's
    // raw pixel buffer would present them), each row's two words stacked
    // along Y — mirrors the real fixture's geometry, with no break info at
    // all, forcing the fallback path.
    const words = [
      word("w1", "Subtotal", rotatedBox(100, 500), null),
      word("w2", "374.25", rotatedBox(100, 300), null),
      word("w3", "Total", rotatedBox(400, 500), null),
      word("w4", "499.03", rotatedBox(400, 300), null),
    ];
    const lines = reconstructLines(words);
    assertEqual(lines.length, 2, "expected two rows, not one giant row or four singletons");
    assert(
      lines.every((l) => l.text.split(" ").length === 2),
      "each reconstructed row must contain exactly its own label and value, not a mix"
    );
  });
});

describe("ocr: reconstructLines — two-column merge", () => {
  it("merges a text-only line immediately followed by a price-only line when their bands overlap", () => {
    const words = [
      word("w1", "Khao", rectBox(0, 500, 40, 30), "SPACE"),
      word("w2", "Soi", rectBox(50, 500, 30, 30), "LINE_BREAK"),
      word("w3", "$", rectBox(300, 505, 10, 20), null),
      word("w4", "23.75", rectBox(320, 500, 50, 30), "LINE_BREAK"),
    ];
    const lines = reconstructLines(words);
    assertEqual(lines.length, 1, "expected the name line and price line to merge into one logical line");
    assertEqual(lines[0].text, "Khao Soi $ 23.75");
  });

  it("does NOT merge two lines that both carry descriptive text", () => {
    const words = [
      word("w1", "PGP", rectBox(0, 500, 40, 30), "LINE_BREAK"),
      word("w2", "Mild", rectBox(0, 500, 40, 30), "LINE_BREAK"),
    ];
    const lines = reconstructLines(words);
    assertEqual(lines.length, 2, "two text-only lines must never be merged");
  });

  it("does NOT merge two lines that both carry a price", () => {
    const words = [
      word("w1", "23.75", rectBox(0, 500, 40, 30), "LINE_BREAK"),
      word("w2", "2.00", rectBox(0, 500, 40, 30), "LINE_BREAK"),
    ];
    const lines = reconstructLines(words);
    assertEqual(lines.length, 2, "two price-only lines must never be merged");
  });

  it("does NOT merge a text line and a price line whose bands do not overlap at all", () => {
    const words = [
      word("w1", "Khao Soi", rectBox(0, 100, 40, 20), "LINE_BREAK"),
      word("w2", "23.75", rectBox(0, 900, 40, 20), "LINE_BREAK"), // far away — different row
    ];
    const lines = reconstructLines(words);
    assertEqual(lines.length, 2, "conservative: no overlap, no merge");
  });
});

describe("ocr: normalizeVisionResponse", () => {
  it("flattens a Vision-shaped response into words and reconstructed lines, preserving break type", () => {
    resetWordIdCounterForTests();
    const fixture = {
      fullTextAnnotation: {
        pages: [
          {
            width: 800,
            height: 1200,
            blocks: [
              {
                paragraphs: [
                  {
                    words: [
                      {
                        confidence: 0.95,
                        boundingBox: { vertices: [{ x: 0, y: 100 }, { x: 40, y: 100 }, { x: 40, y: 112 }, { x: 0, y: 112 }] },
                        symbols: [
                          { text: "T" },
                          { text: "o" },
                          { text: "t" },
                          { text: "a" },
                          { text: "l", property: { detectedBreak: { type: "SPACE" } } },
                        ],
                      },
                      {
                        confidence: 0.88,
                        boundingBox: { vertices: [{ x: 300, y: 100 }, { x: 340, y: 100 }, { x: 340, y: 112 }, { x: 300, y: 112 }] },
                        symbols: [
                          { text: "6" },
                          { text: "7" },
                          { text: "." },
                          { text: "3" },
                          { text: "6", property: { detectedBreak: { type: "LINE_BREAK" } } },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    };

    const result = normalizeVisionResponse(fixture);
    assertEqual(result.pageWidth, 800);
    assertEqual(result.pageHeight, 1200);
    assertEqual(result.words.length, 2);
    assertEqual(result.lines.length, 1);
    assertEqual(result.lines[0].text, "Total 67.36");
    assertEqual(result.words[1].confidence, 0.88);
    assertEqual(result.words[1].breakType, "LINE_BREAK");
  });

  it("skips a word with no symbols rather than producing an empty-text word", () => {
    const fixture = {
      fullTextAnnotation: {
        pages: [
          {
            blocks: [{ paragraphs: [{ words: [{ confidence: 0.9, boundingBox: { vertices: [] }, symbols: [] }] }] }],
          },
        ],
      },
    };
    const result = normalizeVisionResponse(fixture);
    assertEqual(result.words.length, 0);
  });

  it("handles a missing fullTextAnnotation without throwing", () => {
    const result = normalizeVisionResponse({});
    assertEqual(result.lines.length, 0);
    assertEqual(result.words.length, 0);
    assertEqual(result.pageWidth, null);
  });
});

describe("ocr: AF — glued OCR fragments are reassembled into one decimal (Augustiner, real fixture, no network)", () => {
  it("'33' ',' '60' (touching glyphs) resolve to one ledger entry, value 33.60", () => {
    const { ocr, ledger } = loadFixture("vision-augustiner-de.json");
    const glued = ledger.find((e) => Math.abs(e.value - 33.6) < 0.001);
    assert(glued !== undefined, "the split '33,60' must resolve to a single 33.6 ledger entry");
    assertEqual(glued!.rawText, "33,60");
    const line = ocr.lines.find((l) => l.lineIndex === glued!.lineIndex);
    assertEqual(line!.text, "33,60", "the reconstructed line itself must read as one glued token, not '33 , 60'");
  });
});

describe("ocr: AG — words with a normal separation gap are never glued (Augustiner, real fixture)", () => {
  it("'Total' and '96,50' stay two distinct words, not 'Total96,50'", () => {
    const { ocr } = loadFixture("vision-augustiner-de.json");
    const totalLine = ocr.lines.find((l) => l.text.startsWith("Total"));
    assert(totalLine !== undefined, "fixture must still contain the Total line");
    assertEqual(totalLine!.text, "Total 96,50", "conservative: a normal word gap must never be glued");
  });
});

describe("ocr: AH — lineHasPriceShape recognizes a split decimal even when glueOcrFragments doesn't fire", () => {
  function box(x: number, y: number, w: number, h: number): BoundingBox {
    return { vertices: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }] };
  }
  function word(id: string, text: string, b: BoundingBox, breakType: string | null): OcrWord {
    return { wordId: id, text, boundingBox: b, confidence: 0.99, lineIndex: -1, breakType };
  }

  it("merges a name line with a price line whose decimal is split across two words with a normal (non-glue) gap between them", () => {
    // Gaps sized so glueOcrFragments' own threshold (derived from THIS
    // synthetic document's median gap) does not fire on either pair — "23,"
    // is not a bare separator word (isBareSeparatorWord requires EXACTLY
    // "." or ","), so the separator-specific rule doesn't apply either.
    // This isolates the claim: the merge succeeds because lineHasPriceShape
    // itself now scans joined text, not because gluing happened to help.
    const words = [
      word("w1", "Khao", box(0, 500, 40, 30), "SPACE"),
      word("w2", "Soi", box(90, 500, 30, 30), "LINE_BREAK"),
      word("w3", "23,", box(300, 500, 40, 30), "SPACE"),
      word("w4", "75", box(400, 500, 30, 30), "LINE_BREAK"),
    ];
    const lines = reconstructLines(words);
    assertEqual(lines.length, 1, "expected the name line and the split-price line to merge");
    assert(lines[0].text.includes("23,") && lines[0].text.includes("75"), "both price fragments must survive the merge");
  });
});

describe("ocr: AI — a glued word preserves traceability to its original OCR words", () => {
  function box(x: number, y: number, w: number, h: number): BoundingBox {
    return { vertices: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }] };
  }
  function word(id: string, text: string, b: BoundingBox, breakType: string | null, confidence = 0.99): OcrWord {
    return { wordId: id, text, boundingBox: b, confidence, lineIndex: -1, breakType };
  }

  it("wordId stays the first component's id, sourceWordIds lists every fused word, confidence is the minimum", () => {
    // A run of normal-spacing words establishes the reference gap, then a
    // touching triple ("9" "," "50") gets glued.
    const words = [
      word("w1", "Item", box(0, 0, 40, 20), "SPACE", 0.99),
      word("w2", "Name", box(90, 0, 40, 20), "LINE_BREAK", 0.99),
      word("w3", "9", box(300, 0, 15, 20), null, 0.9),
      word("w4", ",", box(316, 0, 6, 20), "SPACE", 0.85),
      word("w5", "50", box(323, 0, 20, 20), "LINE_BREAK", 0.95),
    ];
    const lines = reconstructLines(words);
    const priceLine = lines.find((l) => l.text.includes("9"));
    assert(priceLine !== undefined, "expected a line containing the glued price");
    const gluedWord = priceLine!.words.find((wo) => wo.word.text === "9,50");
    assert(gluedWord !== undefined, "expected '9' ',' '50' to have fused into one '9,50' word");
    assertEqual(gluedWord!.word.wordId, "w3", "wordId must stay the first original component's id");
    assertEqual(JSON.stringify(gluedWord!.word.sourceWordIds), JSON.stringify(["w3", "w4", "w5"]), "sourceWordIds must list every fused word in order");
    assertEqual(gluedWord!.word.confidence, 0.85, "confidence must be the minimum across the fused words");

    resetAmountIdCounterForTests();
    const ledger = buildLedgerFromOcr(lines);
    const entry = ledger.find((e) => e.value === 9.5);
    assert(entry !== undefined, "the ledger must still resolve an amountId for the glued value");
    assertEqual(entry!.wordId, "w3", "the ledger entry's wordId must trace back to the first original OCR word");
  });
});

describe("ocr: AJ — a receipt with no glued fragments is unaffected (Ramires, real fixture)", () => {
  it("the derived cut glues nothing that would change an already-correct value", () => {
    const before = { ledgerLength: undefined as number | undefined };
    const { ledger } = loadFixture("vision-ramires-pt.json");
    before.ledgerLength = ledger.length;
    // Regression floor, not a magic number: this fixture had 52 ledger
    // entries before FIX 12 (see the FIX 11 validation round). Gluing
    // fragments can only ever reduce this count (two tokens becoming one) —
    // if it drops meaningfully below that, something is being glued that
    // shouldn't be.
    assert(ledger.length >= 50, `expected close to the pre-FIX-12 entry count (52), got ${ledger.length} — over-gluing would shrink this`);

    const decimalEntries = ledger.filter((e) => /[.,]\d{2}$/.test(e.rawText));
    assert(decimalEntries.length > 20, "sanity check: this fixture has plenty of decimal entries, unaffected by FIX 12");
  });
});
