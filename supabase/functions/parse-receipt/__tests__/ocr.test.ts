import { describe, it, assert, assertEqual } from "./harness";
import {
  reconstructLines,
  normalizeVisionResponse,
  resetWordIdCounterForTests,
  type OcrWord,
  type BoundingBox,
} from "../ocr";

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
