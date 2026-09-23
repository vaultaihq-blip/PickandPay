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
  /** FIX 12 — set only on a synthetic word produced by glueOcrFragments:
   *  the wordIds of every original Vision word this one was fused from, in
   *  order. `wordId` itself stays the FIRST component's id (so every other
   *  consumer that expects one id per word, e.g. the ledger, keeps
   *  working unchanged) — this field is the traceability record for the
   *  fusion itself. Absent on an ordinary, unfused word. */
  sourceWordIds?: string[];
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

// ─── Geometric line reconstruction (FIX 39) ────────────────────────────────
//
// FIX 38 measured that Vision's own block traversal order is NOT top-to-
// bottom on any of the 11 corpus fixtures (5-60 adjacent block inversions
// each) — V&RO's own "Net Amount" and its value "5226.00" sit at nearly
// identical height (reading-frame center-Y within 6 units) but 8
// reconstructed lines apart, because Vision listed unrelated footer blocks
// between them in its own traversal order. reconstructByWordOrderAndBreaks
// (the primary path above) trusts that traversal order completely; this is
// an alternative that ignores it entirely and groups by measured geometry
// instead — height-grouped, never order-trusted.
//
// EXPERIMENTAL — gated behind reconstructLines'/normalizeVisionResponse's
// own `geometricReconstruction` option, default false. The production path
// above is untouched and remains the default; this function is reachable
// only when a caller explicitly opts in (see this round's own measurement
// script and FQ/FR/FS/FT/FU in ocr.test.ts). Do not wire this into index.ts
// or debug-parse-receipt.ts's default path this round — that decision
// belongs to whichever round actually flips the flag, against the
// pre-registered criteria in this round's own report.
//
// Grouping rule, exactly as measured working in FIX 38 (after two rejected
// attempts — raw Y-range IoU was noise, IoU>=0.5 flagged genuinely correct
// same-line pairs like Augustiner's own "Total 96,50" as bad joins): two
// words belong to the same printed line when their reading-frame center-Y
// distance is under half the document's own MEDIAN WORD HEIGHT. Median word
// height, never the gap between today's own reconstructed lines — many of
// today's lines are already split fragments of one physical row, which
// would make that reference circular (FIX 38's own report).
function medianOf(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

const GEOMETRIC_SAME_ROW_FRACTION = 0.5;

function reconstructByHeightGrouping(words: OcrWord[], angle: number): OcrWord[][] {
  if (words.length === 0) return [];

  const framed = words.map((w) => {
    const pts = w.boundingBox.vertices.map((v) => toReadingFrame(v.x, v.y, angle));
    const ys = pts.map((p) => p.normalY);
    const xs = pts.map((p) => p.normalX);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    return { word: w, centerY: (minY + maxY) / 2, minX: Math.min(...xs), height: maxY - minY };
  });

  const typicalHeight = medianOf(framed.map((f) => f.height));
  const threshold = GEOMETRIC_SAME_ROW_FRACTION * typicalHeight;

  // Union-Find over EVERY pair whose center-Y distance is under the
  // threshold — not just consecutive-in-sort-order pairs — exactly the
  // pairwise relation FIX 38 measured against this corpus (a running/chained
  // comparison risks a different failure mode: a long near-continuous smear
  // of centers silently bridging two genuinely different rows one small
  // step at a time). Small n per receipt (a few hundred words at most) — a
  // full O(n^2) pass is cheap here.
  const parent = framed.map((_, i) => i);
  function find(i: number): number {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  }
  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }
  for (let i = 0; i < framed.length; i++) {
    for (let j = i + 1; j < framed.length; j++) {
      if (Math.abs(framed[i].centerY - framed[j].centerY) < threshold) union(i, j);
    }
  }

  const groups = new Map<number, typeof framed>();
  for (let i = 0; i < framed.length; i++) {
    const root = find(i);
    const existing = groups.get(root);
    if (existing) existing.push(framed[i]);
    else groups.set(root, [framed[i]]);
  }

  const lineGroups = [...groups.values()];
  lineGroups.sort((a, b) => {
    const meanA = a.reduce((s, f) => s + f.centerY, 0) / a.length;
    const meanB = b.reduce((s, f) => s + f.centerY, 0) / b.length;
    return meanA - meanB;
  });

  return lineGroups.map((group) => [...group].sort((a, b) => a.minX - b.minX).map((f) => f.word));
}

// ─── Fragment gluing (FIX 12) ───────────────────────────────────────────────
//
// FIX 11's measurement of the Augustiner fixture found two items (33.60,
// 34.50 of a 68.10 shortfall) lost not to geometry or the semantic pass, but
// to OCR itself: Vision sometimes tokenizes ONE printed number as several
// "words" — most commonly a decimal separator ("." or ",") returned as its
// own standalone word, physically touching its digit neighbours ("33" "," "60"
// for a printed "33,60"). assembleLines() always inserts a text-level space
// between words, so the reconstructed line becomes "33 , 60" — a string
// findMoneyTokens can no longer parse as one decimal, and (independently)
// lineHasPriceShape below no longer recognizes as price-shaped either, so
// this line never merges with its own item name in the two-column pass.
//
// Runs on each line GROUP, before mergeAdjacentTwoColumnLines — never after.
// Confirmed against Mad God's real fixture that running this later is unsafe:
// that merge pass already joins two DIFFERENT visual rows by Y-band overlap
// alone, no X-gap check at all, and one such joined group puts "Total" and
// "23.00" a measured -787 units apart in reading-frame X — a number that
// must never be read as "touching glyphs". Gluing only within pre-merge
// groups means the two words in that pair are never even adjacent yet.
//
// Two rules, both derived from THIS document's own geometry — never a fixed
// pixel constant (same requirement FIX 11's column band and FIX 6's drift
// regression were held to):
//
//  1. GENERAL — a gap at or below FRAGMENT_GAP_DIVISOR of the document's own
//     median "normal" inter-word gap (near-zero/negative gaps excluded from
//     that reference for the same reason columns.ts excludes them: a run of
//     touching glyphs would otherwise drag the median down and collapse the
//     threshold). Verified against all six real fixtures at divisors 2-5:
//     every pair this catches either glues a symbol into its number
//     ("$"+"13.50", "9.00"+"%") — harmless, findMoneyTokens's currency/
//     percent checks work the same whether the symbol is its own word or
//     glued text — or nothing decimal-shaped at all.
//
//  2. SEPARATOR-SPECIFIC — a standalone "." or "," word (nothing else in its
//     text) immediately beside a digit-only word, with a gap at or below the
//     document's own median gap directly (not divided down). Needed because
//     rule 1 alone doesn't fire on Augustiner's real "," -> "60" gap: at
//     ~16-25 units against a median inter-word gap of ~26.6 on that receipt,
//     it is NOT a magnitude outlier — indistinguishable from an ordinary
//     word gap by position alone (measured, not assumed: a period/comma
//     glyph's own bounding box is narrow enough that Vision's reported gap
//     around it is unreliable). Scoped narrowly — the word must be EXACTLY
//     "." or "," — specifically to avoid gluing an unrelated "A, B" pair of
//     two genuinely separate numbers; this is a check on the WORD's own
//     identity, never on how many digits follow a separator (that
//     value-shape reasoning was rejected for this fix on other grounds).
//
// Both rules share a floor: a gap more negative than the smaller of the two
// words' own box heights is never glued regardless of either rule — real
// touching glyphs overlap by at most a fraction of their own height; a gap
// far past that is evidence of a mis-grouped pair (e.g. the Mad God case
// above), not glued type.
const FRAGMENT_GAP_DIVISOR = 3;
const FRAGMENT_NEAR_ZERO_GAP = 3;

function isBareSeparatorWord(text: string): boolean {
  return text === "." || text === ",";
}
function isDigitOnlyWord(text: string): boolean {
  return /^\d+$/.test(text);
}

function wordEdgesX(word: OcrWord, angle: number): { left: number; right: number } {
  const xs = word.boundingBox.vertices.map((v) => toReadingFrame(v.x, v.y, angle).normalX);
  return { left: Math.min(...xs), right: Math.max(...xs) };
}
function wordHeight(word: OcrWord, angle: number): number {
  const ys = word.boundingBox.vertices.map((v) => toReadingFrame(v.x, v.y, angle).normalY);
  return Math.max(...ys) - Math.min(...ys);
}

function glueWords(run: OcrWord[]): OcrWord {
  const first = run[0];
  return {
    wordId: first.wordId,
    text: run.map((w) => w.text).join(""),
    boundingBox: { vertices: run.flatMap((w) => w.boundingBox.vertices) },
    confidence: Math.min(...run.map((w) => w.confidence)),
    lineIndex: first.lineIndex,
    breakType: run[run.length - 1].breakType,
    sourceWordIds: run.flatMap((w) => w.sourceWordIds ?? [w.wordId]),
  };
}

/** Glues touching-glyph fragments within each already-identified line group.
 *  Never called across groups — a group here is a printed line as Vision's
 *  own word order/break metadata (or the geometric fallback) already
 *  identified it, before the two-column merge exists to create cross-row
 *  groups. */
function glueOcrFragments(groups: OcrWord[][], angle: number): OcrWord[][] {
  // Reference gap: median of every same-group consecutive-word gap across
  // the WHOLE document, excluding near-zero ones — global, not per-line,
  // matching columns.ts's clusterByX reasoning: within-token gaps are rare
  // relative to real word gaps, so a global median is already a good
  // estimate of "typical spacing" without an iterative scheme.
  const allGaps: number[] = [];
  for (const group of groups) {
    for (let i = 1; i < group.length; i++) {
      const gap = wordEdgesX(group[i], angle).left - wordEdgesX(group[i - 1], angle).right;
      allGaps.push(gap);
    }
  }
  const normalGaps = allGaps.filter((g) => g > FRAGMENT_NEAR_ZERO_GAP);
  if (normalGaps.length === 0) return groups; // no signal to derive a reference from — glue nothing

  const sorted = [...normalGaps].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const referenceGap = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  const generalThreshold = referenceGap / FRAGMENT_GAP_DIVISOR;
  const separatorThreshold = referenceGap;

  return groups.map((group) => {
    if (group.length < 2) return group;

    const shouldGlue: boolean[] = [];
    for (let i = 1; i < group.length; i++) {
      const prev = group[i - 1];
      const cur = group[i];
      const gap = wordEdgesX(cur, angle).left - wordEdgesX(prev, angle).right;
      const floor = -Math.min(wordHeight(prev, angle), wordHeight(cur, angle));
      if (gap <= floor) {
        shouldGlue.push(false);
        continue;
      }
      const isSeparatorPair =
        (isBareSeparatorWord(prev.text) && isDigitOnlyWord(cur.text)) ||
        (isDigitOnlyWord(prev.text) && isBareSeparatorWord(cur.text));
      if (gap <= generalThreshold) {
        shouldGlue.push(true);
      } else if (isSeparatorPair && gap <= separatorThreshold) {
        shouldGlue.push(true);
      } else {
        shouldGlue.push(false);
      }
    }

    const result: OcrWord[] = [];
    let run: OcrWord[] = [group[0]];
    for (let i = 0; i < shouldGlue.length; i++) {
      if (shouldGlue[i]) {
        run.push(group[i + 1]);
      } else {
        result.push(run.length === 1 ? run[0] : glueWords(run));
        run = [group[i + 1]];
      }
    }
    result.push(run.length === 1 ? run[0] : glueWords(run));
    return result;
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
/** Checks the price-shape pattern against the GROUP's text with NO space
 *  between words (FIX 12) — deliberately not the same join assembleLines()
 *  uses for the real visible line text. A decimal split across two OCR
 *  words ("33" "," "60") never matches per-word, and a single-space join
 *  still can't bridge it either (the space sits between the digit and its
 *  separator). This is independent of glueOcrFragments succeeding — a
 *  gap this function never even looks at could in principle stop gluing
 *  from firing while the text is still, visually, one price. False
 *  positives here cost only an attempted two-column merge, never a wrong
 *  monetary value: findMoneyTokens (the actual price-parsing path) uses
 *  the real, space-joined assembled text and its own separate logic. */
function lineHasPriceShape(words: OcrWord[]): boolean {
  const text = words.map((w) => w.text).join("");
  const pattern = /\d[.,]\d{2}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    // A decimal number immediately followed by '%' (glued, or separated by
    // whitespace) is a rate — e.g. "Service (18.00%)" — not a price shape
    // for merge purposes. Mirrors ledger.ts's percent-adjacency exclusion
    // locally rather than importing it, so this module's merge heuristic
    // stays self-contained; findMoneyTokens itself is untouched.
    const after = text.slice(match.index + match[0].length);
    if (!/^\s*%/.test(after)) return true;
  }
  return false;
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
      twoColumnMergeFireCount += 1;
      i += 2;
    } else {
      merged.push(current.words);
      i += 1;
    }
  }
  return merged;
}

// FIX 39 — diagnostic-only: how many times mergeAdjacentTwoColumnLines
// actually merged a pair, this call. Reset at the top of reconstructLines so
// a caller comparing the two reconstruction methods (this round's own
// measurement) can read it fresh after each call. Never consulted by any
// production logic — purely observational, to answer whether the merge
// pass is still doing work once the geometric grouping (when the flag is
// on) already puts a name and its price on one line by construction.
let twoColumnMergeFireCount = 0;
export function getTwoColumnMergeFireCount(): number {
  return twoColumnMergeFireCount;
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
 *
 * FIX 39 — `geometricReconstruction` (default false) swaps BOTH of the
 * above for reconstructByHeightGrouping, which ignores Vision's traversal
 * order entirely and groups purely by measured height/position. EXPERIMENTAL
 * — see this round's own report for the measured comparison. The two-column
 * merge and fragment-gluing passes still run afterward either way, so a
 * caller comparing both paths sees whether the new grouping already
 * achieves what the merge pass used to do alone.
 */
export function reconstructLines(words: OcrWord[], geometricReconstruction = false): OcrLine[] {
  twoColumnMergeFireCount = 0;
  if (words.length === 0) return [];

  const angle = dominantAngle(words);

  let groups: OcrWord[][];
  if (geometricReconstruction) {
    groups = reconstructByHeightGrouping(words, angle);
  } else {
    const hasUsableBreakMetadata = words.some((w) => w.breakType !== null);
    groups = hasUsableBreakMetadata ? reconstructByWordOrderAndBreaks(words) : reconstructByNormalizedGeometry(words);
  }

  // FIX 12 — before the two-column merge, never after (see glueOcrFragments'
  // own header comment for why order matters here).
  const glued = glueOcrFragments(groups, angle);
  const merged = mergeAdjacentTwoColumnLines(glued, angle);
  return assembleLines(merged);
}

/**
 * Flattens a Vision DOCUMENT_TEXT_DETECTION response into words, in
 * Vision's own natural traversal order, then reconstructs printed lines.
 *
 * FIX 39 — `options.geometricReconstruction` (default false) forwards to
 * reconstructLines; see its own header for what changes.
 */
export function normalizeVisionResponse(raw: unknown, options?: { geometricReconstruction?: boolean }): OcrResult {
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

  const lines = reconstructLines(rawWords, options?.geometricReconstruction ?? false);
  const words = lines.flatMap((l) => l.words.map((wo) => wo.word));

  return { lines, words, pageWidth: page?.width ?? null, pageHeight: page?.height ?? null };
}
