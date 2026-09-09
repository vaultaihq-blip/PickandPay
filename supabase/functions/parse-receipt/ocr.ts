/**
 * Google Cloud Vision OCR — DOCUMENT_TEXT_DETECTION.
 *
 * This is the pipeline's ONLY source of monetary digits. It is deterministic
 * per input (a real OCR engine, not a generative model), and returns a
 * genuine per-word bounding box and confidence score for every printed word
 * — evidence the semantic LLM pass never sees or gets to influence.
 *
 * Line reconstruction (see reconstructLines below) uses Vision's own
 * reading-order word sequence plus symbol-level break annotations as the
 * PRIMARY source — proven against a real rotated-photo fixture
 * (__fixtures__/vision-pai-toronto-rotated.json) to correctly keep an item
 * name adjacent to its price regardless of how the source image's pixels
 * are oriented, because Vision's word order already reflects true reading
 * order internally. Raw pixel-coordinate clustering was tried first and
 * proven wrong: on a photo with EXIF Orientation 6 (rotated 90°), the whole
 * price column shares a narrow raw-pixel band and collapses onto one fake
 * "line" while item names smear onto others — see the git history on this
 * file for that failed approach and the trace that caught it. Geometry is
 * only used now as (a) an explicit fallback when Vision gives no usable
 * break metadata at all, normalized into a reading frame first rather than
 * read as raw pixels, and (b) the two-column merge pass, for the same
 * reason.
 *
 * Pure TypeScript, zero Deno-specific imports — runs unmodified under the
 * Edge Function (Deno) and under Node's `tsx` (for local unit tests).
 */

export interface BoundingBox {
  vertices: Array<{ x: number; y: number }>;
}

export interface OcrWord {
  wordId: string;
  text: string;
  boundingBox: BoundingBox;
  /** Google Vision's own reported confidence for this word, 0-1. Never
   *  blindly trusted — see validate.ts, where a low-confidence load-bearing
   *  word triggers targeted verification rather than being accepted as-is. */
  confidence: number;
  lineIndex: number;
  /** Vision's break annotation from this word's last symbol
   *  (detectedBreak.type), used to reconstruct printed line boundaries.
   *  Null when Vision attached no annotation at all to this word. */
  breakType: string | null;
}

export interface OcrLine {
  lineIndex: number;
  text: string;
  /** Each word's character offset within `text`, so a money-pattern match on
   *  the reconstructed line can be mapped back to the OCR word(s) that
   *  produced it. */
  words: Array<{ word: OcrWord; start: number; end: number }>;
}

export interface OcrResult {
  lines: OcrLine[];
  words: OcrWord[];
  pageWidth: number | null;
  pageHeight: number | null;
}

const VISION_API_URL = "https://vision.googleapis.com/v1/images:annotate";

export class OcrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OcrError";
  }
}

/**
 * Calls Google Cloud Vision DOCUMENT_TEXT_DETECTION and returns the raw
 * parsed JSON response. Kept separate from normalization so normalization
 * can be unit tested against a fixture with zero network dependency.
 */
export async function callGoogleVision(
  apiKey: string,
  base64Image: string,
  languageHints: string[]
): Promise<unknown> {
  const response = await fetch(`${VISION_API_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [
        {
          image: { content: base64Image },
          features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
          imageContext: { languageHints },
        },
      ],
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new OcrError(`Google Vision ${response.status}: ${detail.slice(0, 300)}`);
  }

  const json = await response.json();
  const result = json?.responses?.[0];
  if (!result) throw new OcrError("Empty response from Google Vision");
  if (result.error) {
    throw new OcrError(`Google Vision error: ${result.error.message ?? "unknown"}`);
  }
  return result;
}

let wordIdCounter = 0;
function nextWordId(): string {
  wordIdCounter += 1;
  return `W${wordIdCounter}`;
}
/** Test-only: keeps generated IDs predictable across runs. */
export function resetWordIdCounterForTests(): void {
  wordIdCounter = 0;
}

function boxHeight(box: BoundingBox): number {
  const ys = box.vertices.map((v) => v.y);
  if (ys.length === 0) return 0;
  return Math.max(...ys) - Math.min(...ys);
}
export function boxCenter(box: BoundingBox): { x: number; y: number } {
  const xs = box.vertices.map((v) => v.x);
  const ys = box.vertices.map((v) => v.y);
  if (xs.length === 0) return { x: 0, y: 0 };
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
}

// ─── Break-type classification ─────────────────────────────────────────────
//
// Named explicitly rather than left as inline conditions, per spec.

/** Ends the current printed line. HYPHEN is included deliberately: Vision
 *  emits it when a word is split by a line-wrap hyphen, meaning the printed
 *  line ends there with the word continuing below. Our word-level model
 *  never holds sub-word fragments, so the practical effect is the same as
 *  LINE_BREAK — treated as terminating. */
const LINE_TERMINATING_BREAKS = new Set(["LINE_BREAK", "EOL_SURE_SPACE", "HYPHEN"]);
/** Explicitly does not end the line — the word continues on the same line. */
const LINE_CONTINUING_BREAKS = new Set(["SPACE", "SURE_SPACE"]);
// Anything else (null/missing, or an unrecognized type) also does not
// terminate — see reconstructByWordOrderAndBreaks: prematurely splitting a
// line (severing a name from its price) is more damaging than occasionally
// running two fragments together, which downstream ownership validation
// still tolerates.
void LINE_CONTINUING_BREAKS; // documents the explicit "does not terminate" set even though the default already covers it

/**
 * Groups words into printed lines using Vision's own reading-order sequence
 * plus its per-word break annotation. Rotation-independent by construction:
 * Vision's word order already reflects true reading order regardless of how
 * the source image's pixels are oriented, so this needs no geometry at all.
 */
function reconstructByWordOrderAndBreaks(words: OcrWord[]): OcrWord[][] {
  const groups: OcrWord[][] = [];
  let current: OcrWord[] = [];
  for (const word of words) {
    current.push(word);
    if (word.breakType !== null && LINE_TERMINATING_BREAKS.has(word.breakType)) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** The word's own "reading direction" angle, from the top-left to top-right
 *  vertex of its bounding box (vertex order follows the glyph's own
 *  upright orientation, not the raw image's). */
function wordAngle(box: BoundingBox): number {
  const [v0, v1] = box.vertices;
  if (!v0 || !v1) return 0;
  return Math.atan2(v1.y - v0.y, v1.x - v0.x);
}

/** Circular mean of every word's reading-direction angle — the dominant
 *  text orientation for the whole image, used to normalize coordinates
 *  regardless of EXIF rotation or genuine camera skew. Not hardcoded to any
 *  particular rotation (0/90/180/270); works for an arbitrary angle. */
export function dominantAngle(words: OcrWord[]): number {
  let sumX = 0;
  let sumY = 0;
  for (const w of words) {
    const a = wordAngle(w.boundingBox);
    sumX += Math.cos(a);
    sumY += Math.sin(a);
  }
  if (sumX === 0 && sumY === 0) return 0;
  return Math.atan2(sumY, sumX);
}

/** Rotates a point by -angle, mapping the dominant reading direction onto
 *  the +X axis: normalX increases moving along a printed line, normalY
 *  increases moving from one printed line to the next — independent of the
 *  source image's actual orientation or skew. */
export function toReadingFrame(x: number, y: number, angle: number): { normalX: number; normalY: number } {
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  return { normalX: x * cos - y * sin, normalY: x * sin + y * cos };
}

/**
 * Fallback for when Vision provides no usable break metadata at all. Never
 * falls back further to raw pixel coordinates — the dominant text angle is
 * measured first and coordinates are normalized into a reading frame,
 * *then* clustered on normalized Y. This is what makes the fallback itself
 * robust to rotation and mild skew, rather than repeating the mistake this
 * function replaced.
 */
function reconstructByNormalizedGeometry(words: OcrWord[]): OcrWord[][] {
  if (words.length === 0) return [];
  const angle = dominantAngle(words);

  const framed = words
    .map((word) => {
      const center = boxCenter(word.boundingBox);
      const { normalX, normalY } = toReadingFrame(center.x, center.y, angle);
      return { word, normalX, normalY, height: boxHeight(word.boundingBox) };
    })
    .sort((a, b) => a.normalY - b.normalY);

  const clusters: Array<{ normalY: number; items: typeof framed }> = [];
  for (const item of framed) {
    const tolerance = Math.max(4, item.height * 0.6);
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(item.normalY - last.normalY) <= tolerance) {
      last.items.push(item);
      last.normalY = (last.normalY * (last.items.length - 1) + item.normalY) / last.items.length;
    } else {
      clusters.push({ normalY: item.normalY, items: [item] });
    }
  }

  return clusters.map((cluster) => {
    cluster.items.sort((a, b) => a.normalX - b.normalX);
    return cluster.items.map((i) => i.word);
  });
}

// ─── Two-column merge ───────────────────────────────────────────────────────
//
// A receipt line like "Khao Soi ................ $23.75" often lands in
// separate Vision blocks/paragraphs because of the large gap between name
// and price columns — confirmed against the real rotated fixture, where
// e.g. "1 Khao Soi" and "$ 23.75" are two consecutive but separate blocks.
// Conservative by design: only merges a clean text-only line immediately
// followed by a price-only line, and only when their bands in the
// normalized reading frame overlap.

function hasLetter(text: string): boolean {
  return /\p{L}/u.test(text);
}
function lineHasDescriptiveText(words: OcrWord[]): boolean {
  return words.some((w) => w.text.length >= 2 && hasLetter(w.text));
}
function lineHasPriceShape(words: OcrWord[]): boolean {
  return words.some((w, i) => {
    if (!/\d[.,]\d{2}/.test(w.text)) return false;
    // A decimal number immediately followed by '%' (glued, or as the very
    // next OCR word) is a rate — e.g. "Service (18.00%)" — not a price
    // shape for merge purposes. Mirrors ledger.ts's percent-adjacency
    // exclusion locally rather than importing it, so this module's merge
    // heuristic stays self-contained; findMoneyTokens itself is untouched.
    if (/%$/.test(w.text)) return false;
    const next = words[i + 1];
    if (next && /^\s*%/.test(next.text)) return false;
    return true;
  });
}

function mergeAdjacentTwoColumnLines(groups: OcrWord[][], angle: number): OcrWord[][] {
  const framed = groups.map((group) => {
    // Use every vertex of every word, not just word centers: a single
    // word's own box already spans a normalY range close to a full row's
    // thickness (confirmed against the real rotated fixture — ~35 of the
    // ~40-unit gap between a name line and its price line's centers is
    // exactly this per-word thickness). Centers alone under-count it and
    // make two genuinely-adjacent-row bands look non-overlapping.
    const normalYs = group.flatMap((w) =>
      w.boundingBox.vertices.map((v) => toReadingFrame(v.x, v.y, angle).normalY)
    );
    return {
      words: group,
      minY: Math.min(...normalYs),
      maxY: Math.max(...normalYs),
      hasText: lineHasDescriptiveText(group),
      hasPrice: lineHasPriceShape(group),
    };
  });

  const merged: OcrWord[][] = [];
  let i = 0;
  while (i < framed.length) {
    const current = framed[i];
    const next = framed[i + 1];
    const bandsOverlap = next !== undefined && current.maxY >= next.minY && next.maxY >= current.minY;

    if (
      next !== undefined &&
      current.hasText &&
      !current.hasPrice &&
      next.hasPrice &&
      !next.hasText &&
      bandsOverlap
    ) {
      merged.push([...current.words, ...next.words]);
      i += 2;
    } else {
      merged.push(current.words);
      i += 1;
    }
  }
  return merged;
}

function assembleLines(groups: OcrWord[][]): OcrLine[] {
  return groups.map((groupWords, lineIndex) => {
    let text = "";
    const wordOffsets: OcrLine["words"] = [];
    for (const word of groupWords) {
      if (text.length > 0) text += " ";
      const start = text.length;
      text += word.text;
      word.lineIndex = lineIndex;
      wordOffsets.push({ word, start, end: text.length });
    }
    return { lineIndex, text, words: wordOffsets };
  });
}

/**
 * Groups OCR words into printed lines. Primary path uses Vision's own
 * reading-order word sequence and break annotations (rotation-independent
 * by construction). Falls back to geometry — normalized into a reading
 * frame via the dominant text angle, never raw pixel coordinates — only
 * when Vision provides no usable break metadata at all. Either path then
 * goes through the same conservative two-column merge pass.
 *
 * `words` must be in Vision's own natural traversal order (page -> block ->
 * paragraph -> word) for the primary path to work correctly.
 */
export function reconstructLines(words: OcrWord[]): OcrLine[] {
  if (words.length === 0) return [];

  const hasUsableBreakMetadata = words.some((w) => w.breakType !== null);
  const angle = dominantAngle(words);

  const groups = hasUsableBreakMetadata
    ? reconstructByWordOrderAndBreaks(words)
    : reconstructByNormalizedGeometry(words);

  const merged = mergeAdjacentTwoColumnLines(groups, angle);
  return assembleLines(merged);
}

/**
 * Flattens a Vision DOCUMENT_TEXT_DETECTION response into words, in
 * Vision's own natural traversal order, then reconstructs printed lines.
 */
export function normalizeVisionResponse(raw: unknown): OcrResult {
  const result = raw as {
    fullTextAnnotation?: {
      pages?: Array<{
        width?: number;
        height?: number;
        blocks?: Array<{
          paragraphs?: Array<{
            words?: Array<{
              confidence?: number;
              boundingBox?: { vertices?: Array<{ x?: number; y?: number }> };
              symbols?: Array<{ text?: string; property?: { detectedBreak?: { type?: string } } }>;
            }>;
          }>;
        }>;
      }>;
    };
  };

  const page = result.fullTextAnnotation?.pages?.[0];
  const rawWords: OcrWord[] = [];

  for (const block of page?.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const w of paragraph.words ?? []) {
        const text = (w.symbols ?? []).map((s) => s.text ?? "").join("");
        if (text.length === 0) continue;
        const vertices = (w.boundingBox?.vertices ?? []).map((v) => ({
          x: v.x ?? 0,
          y: v.y ?? 0,
        }));
        const lastSymbol = w.symbols?.[w.symbols.length - 1];
        const breakType = lastSymbol?.property?.detectedBreak?.type ?? null;
        rawWords.push({
          wordId: nextWordId(),
          text,
          boundingBox: { vertices },
          confidence: typeof w.confidence === "number" ? w.confidence : 1,
          lineIndex: -1, // assigned by reconstructLines
          breakType,
        });
      }
    }
  }

  const lines = reconstructLines(rawWords);
  const words = lines.flatMap((l) => l.words.map((wo) => wo.word));

  return { lines, words, pageWidth: page?.width ?? null, pageHeight: page?.height ?? null };
}
