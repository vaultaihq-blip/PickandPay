/**
 * Monetary Evidence Ledger.
 *
 * Pure TypeScript, zero Deno-specific imports — runs unmodified under the
 * Edge Function (Deno) and under Node's `tsx` (for local unit tests).
 *
 * Every ledger entry is built from a single OCR word (see ocr.ts) — never
 * from an LLM-generated value. The semantic LLM pass later refers to these
 * entries only by amountId; it is schema-incapable of inventing a value
 * (see schema.ts). Every monetary OCCURRENCE printed on a receipt gets its
 * own amountId, even when two occurrences share the same numeric value (two
 * lines both showing "23.75" are two separate pieces of evidence, never
 * merged).
 */

// ─── Number-token finding and normalization ────────────────────────────────
//
// Two concerns, kept deliberately separate:
//   1. Which substrings of a line LOOK like a monetary amount at all
//      (findMoneyTokens) — contextual, conservative, not "every digit run".
//   2. Given a candidate token, what number does it represent
//      (parseAmbiguousNumber) — locale-ambiguous decimal/thousands
//      resolution, ported from lib/receipt/money.ts's parseMoneyString
//      (kept here rather than imported, so this file has no dependency
//      outside its own directory and stays deployable standalone).

/**
 * A number-shaped run: digits, optional grouping/decimal separators.
 *
 * FIX 36 — two alternatives, tried in order at each position:
 *   1. a PROPERLY GROUPED number: 1-3 leading digits, then ONE OR MORE
 *      thousands groups of exactly 3 digits each (each preceded by a
 *      separator), then an optional decimal suffix. The `+` here (not the
 *      original `*`) is load-bearing: it requires at least one genuine
 *      group before this alternative can match at all. With `*` (zero
 *      groups allowed), this alternative alone could already match a bare
 *      1-3-digit PREFIX of a longer, ungrouped run and stop there — exactly
 *      the FIX 30/35 bug: "4525.00" (no thousands separator at all, since
 *      "4,525.00" would have been the properly grouped form) matched only
 *      "452" here, and independently the leftover "5.00" then matched as
 *      its own, wrong, token via alternative 2 below; "500094969" (a
 *      tax/loyalty ID, not money at all) matched only its trailing "969".
 *   2. a BARE run: one or more digits with no internal separators at all,
 *      plus the same optional decimal suffix. This is what alternative 1
 *      degenerating to zero groups used to mean, made explicit and — the
 *      actual fix — no longer capped at 3 leading digits, so "4525" (or
 *      "500094969") is consumed WHOLE rather than only its first 1-3
 *      digits. A token must consume the receipt's entire contiguous
 *      digit-and-separator run or not match there at all — reading a
 *      PIECE of a printed number (36.00 read from a photo's fragment) is
 *      worse than not reading it, never better.
 *
 * Never changes what a PROPERLY separator-grouped number resolves to —
 * "34,502" (comma + exactly 3 digits) still matches alternative 1 whole,
 * unchanged from before this fix; "3,590.00" and "1.234,56" likewise. The
 * decimal-vs-thousands disambiguation itself (parseAmbiguousNumber) is
 * untouched — this only changes which SUBSTRING becomes a candidate token
 * in the first place.
 */
const NUMBER_TOKEN_PATTERN =
  /-?\(?\d{1,3}(?:[.,\s  ]\d{3})+(?:[.,]\d{1,2})?\)?|-?\(?\d+(?:[.,]\d{1,2})?\)?/g;

const CURRENCY_SYMBOLS = /[$€£¥₩₹]/;
const CURRENCY_CODE_NEARBY = /\b(USD|EUR|GBP|CAD|AUD|CHF|JPY|CNY|HKD|SGD|BRL|MXN)\b/i;

// Context words that mean "this number is not a price even though it's
// digit-shaped" — checked in a small window before the token, not the whole
// line, so a genuine item named e.g. "Table Wine" doesn't get excluded by a
// coincidental match elsewhere.
const NON_MONEY_CONTEXT = /\b(table|order|check|invoice|ref|reference|tel|phone|fax|ext|receipt\s*#|covers?|guests?|seat)\b\s*#?\s*:?\s*$/i;

/** dd/mm/yyyy, yyyy-mm-dd, dd-mm-yy and similar — a token embedded in one of
 * these is a date fragment, not an independent monetary amount. */
const DATE_PATTERN = /\b\d{1,4}[/\-.]\d{1,2}[/\-.]\d{1,4}\b/g;

/** Phone-shaped runs: long digit sequences with phone-style separators, no
 * decimal, no currency symbol nearby. */
const PHONE_PATTERN = /\b\(?\d{2,4}\)?[\s.-]\d{3,4}[\s.-]\d{3,4}\b/g;

/** A '%' immediately after a number (optionally separated by whitespace,
 * whether glued to the same OCR token or its own adjacent one) marks a rate,
 * not a monetary amount — checked at the point of use against the text right
 * after a candidate token's end index, never against the whole line. */
const PERCENT_ADJACENT = /^\s*%/;

export interface MoneyToken {
  rawText: string;
  value: number;
  /** Character offset of the match within its source line. */
  startIndex: number;
  endIndex: number;
  hasDecimal: boolean;
  hasCurrencySymbol: boolean;
}

/**
 * Resolves a single already-isolated numeric token (e.g. "23.75", "1.234,56",
 * "23,5", "(4.50)") to a number, handling the classic decimal-vs-thousands
 * ambiguity the same way lib/receipt/money.ts:parseMoneyString does: the
 * right-most separator is the decimal point only if followed by 1-2 digits;
 * every other separator is a grouping mark.
 */
export function parseAmbiguousNumber(raw: string): number | null {
  let text = raw.trim();
  if (text.length === 0) return null;

  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1).trim();
  }
  if (text.startsWith("-")) {
    negative = true;
    text = text.slice(1);
  }

  text = text.replace(/[\s  ]/g, "");
  if (text.length === 0 || !/^[0-9.,]+$/.test(text)) return null;

  const lastDot = text.lastIndexOf(".");
  const lastComma = text.lastIndexOf(",");

  let integerPart: string;
  let fractionPart: string;

  if (lastDot === -1 && lastComma === -1) {
    integerPart = text;
    fractionPart = "";
  } else {
    const sepIndex = Math.max(lastDot, lastComma);
    const tail = text.slice(sepIndex + 1);
    const isDecimalSeparator = tail.length > 0 && tail.length <= 2 && /^[0-9]+$/.test(tail);
    if (isDecimalSeparator) {
      integerPart = text.slice(0, sepIndex);
      fractionPart = tail;
    } else {
      integerPart = text;
      fractionPart = "";
    }
  }

  integerPart = integerPart.replace(/[.,]/g, "");
  if (integerPart.length === 0) integerPart = "0";
  if (!/^[0-9]+$/.test(integerPart)) return null;
  if (fractionPart.length > 0 && !/^[0-9]+$/.test(fractionPart)) return null;

  const value = Number(`${integerPart}.${fractionPart || "0"}`);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

/**
 * Finds every plausible monetary occurrence on a single (reconstructed OCR)
 * line, conservatively. Not every digit-containing token is money: dates,
 * phone numbers, and labelled non-money numbers (order/table/check/
 * reference/covers) are excluded by context, not accepted and filtered later.
 */
// FIX 36 — diagnostic-only: how many candidate tokens this run rejected
// under the new "whole run or nothing" rule (a long bare digit run with no
// decimal and no currency cue, e.g. an ID or phone-adjacent number).
// Reset at the top of buildLedgerFromOcr so a long-lived isolate reports
// only the count for the request currently being parsed.
let partialNumberTokensRejectedCounter = 0;
export function getPartialNumberTokensRejectedCount(): number {
  return partialNumberTokensRejectedCounter;
}

export function findMoneyTokens(line: string): MoneyToken[] {
  const excludedRanges: Array<[number, number]> = [];
  for (const pattern of [DATE_PATTERN, PHONE_PATTERN]) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(line)) !== null) {
      excludedRanges.push([m.index, m.index + m[0].length]);
      if (m[0].length === 0) pattern.lastIndex += 1; // guard zero-width loops
    }
  }
  const withinExcludedRange = (start: number, end: number) =>
    excludedRanges.some(([exStart, exEnd]) => start >= exStart && end <= exEnd);

  const tokens: MoneyToken[] = [];
  NUMBER_TOKEN_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NUMBER_TOKEN_PATTERN.exec(line)) !== null) {
    const rawText = match[0];
    const startIndex = match.index;
    const endIndex = startIndex + rawText.length;

    if (withinExcludedRange(startIndex, endIndex)) continue;

    const value = parseAmbiguousNumber(rawText);
    if (value === null) continue;

    // A number immediately followed by '%' (optionally after whitespace,
    // whether the '%' is glued to this token or is its own adjacent OCR
    // token) is a rate — e.g. the "18.00" in "Service (18.00%)" — never a
    // monetary occurrence. Adjacency only: a legitimate price elsewhere on
    // the same line is unaffected.
    if (PERCENT_ADJACENT.test(line.slice(endIndex))) continue;

    const hasDecimal = /[.,]\d{1,2}$/.test(rawText.replace(/[()]/g, ""));
    const before = line.slice(0, startIndex);
    const after = line.slice(endIndex, endIndex + 3);
    const hasCurrencySymbol =
      CURRENCY_SYMBOLS.test(before.slice(-3)) ||
      CURRENCY_SYMBOLS.test(after) ||
      CURRENCY_CODE_NEARBY.test(before.slice(-5)) ||
      CURRENCY_CODE_NEARBY.test(after);

    // A bare integer (no decimal, no currency marker) is the highest-risk
    // case for a false positive (quantity, count, piece number) — only keep
    // it when there's a currency cue, or it's the last thing on the line
    // (the common "label ........ price" layout), which are the two
    // situations that actually distinguish a price from an incidental count.
    if (!hasDecimal && !hasCurrencySymbol) {
      // FIX 36 — length is checked before position, and a long bare run
      // never gets a pass merely for being last-on-line. Capped at 3
      // digits — this grammar's own original assumption for a single
      // ungrouped figure (0-999) — because every genuine 4+-digit amount
      // observed across all 11 corpus fixtures prints WITH a decimal point
      // (4525.00, 2250.00, 5226.00); a longer bare run with neither a
      // decimal nor a currency cue is, in this corpus, always something
      // else printed nearby (Sulbarreiro's "ID 500094969", a phone number,
      // a tax ID) — never a real price. NUMBER_TOKEN_PATTERN's own FIX 36
      // change means this now sees the run's true full length, not a
      // fragment of it.
      //
      // Only applies to a token with NO separator anywhere in it — a
      // properly-grouped number like "34,502" has hasDecimal=false too
      // (its own trailing group is 3 digits, not the 1-2 a decimal suffix
      // requires) but is a structurally different, more-trusted shape than
      // an unbroken 9-digit run; it must keep going through the ordinary
      // last-on-line check below unchanged (Augustiner's own case, FIX 35
      // Part 4 — this fix never decides which reading of it is correct).
      const hasAnySeparator = /[.,\s]/.test(rawText);
      if (!hasAnySeparator && rawText.replace(/[^\d]/g, "").length > 3) {
        partialNumberTokensRejectedCounter += 1;
        continue;
      }
      const restOfLine = line.slice(endIndex).trim();
      const isLastOnLine = restOfLine.length === 0;
      if (!isLastOnLine) continue;
    }

    if (NON_MONEY_CONTEXT.test(before)) continue;

    tokens.push({ rawText, value, startIndex, endIndex, hasDecimal, hasCurrencySymbol });
  }
  return tokens;
}

// ─── Ledger entries, built directly from OCR tokens ────────────────────────

import type { BoundingBox, OcrLine } from "./ocr.ts";
import { dominantAngle, toReadingFrame } from "./ocr.ts";
import { clusterByX } from "./geometry.ts";

export interface LedgerEntry {
  amountId: string;
  /** The OCR word this value was read from — the single source of truth for
   *  this occurrence's characters. Never absent: every ledger entry is
   *  anchored to one physical OCR token. */
  wordId: string;
  /** OCR's raw matched text for this occurrence, exactly as read. */
  rawText: string;
  value: number;
  lineIndex: number;
  boundingBox: BoundingBox;
  /** Google Vision's own reported confidence for the underlying word, 0-1.
   *  Never blindly trusted — see validate.ts, where a low-confidence
   *  load-bearing entry triggers targeted verification. */
  ocrConfidence: number;
  source: "ocr";
}

let ledgerIdCounter = 0;
function nextAmountId(): string {
  ledgerIdCounter += 1;
  return `A${ledgerIdCounter}`;
}
/** Test-only: keeps generated IDs predictable across runs. */
export function resetAmountIdCounterForTests(): void {
  ledgerIdCounter = 0;
}

/** Only decimal-formatted tokens count as column-clustering candidates —
 *  the same rule columns.ts itself uses (FIX 11), reused here so the two
 *  never diverge on what "a value" looks like. */
const DECIMAL_SHAPED_TOKEN = /[.,]\d{2}$/;

function findOverlappingWord(
  words: OcrLine["words"],
  startIndex: number,
  endIndex: number
): OcrLine["words"][number] | null {
  let bestOverlap = 0;
  let best: OcrLine["words"][number] | null = null;
  for (const wordOffset of words) {
    const overlap = Math.min(endIndex, wordOffset.end) - Math.max(startIndex, wordOffset.start);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = wordOffset;
    }
  }
  return best;
}

function rightEdgeXOfBox(box: BoundingBox, angle: number): number {
  return Math.max(...box.vertices.map((v) => toReadingFrame(v.x, v.y, angle).normalX));
}

function leftEdgeXOfBox(box: BoundingBox, angle: number): number {
  return Math.min(...box.vertices.map((v) => toReadingFrame(v.x, v.y, angle).normalX));
}

/**
 * 03-11-2026 — whether `word` (a bare 1-3 digit run) sits in the receipt's
 * quantity column: at least one OTHER line has a bare 1-3 digit word whose
 * right edge is within about one character of this one's, immediately
 * followed by a price-shaped word that is NOT a plain 3-digit group (so it
 * cannot be read as that integer's continuation, e.g. "2" then "2.200,00").
 */
function alignsWithQuantityColumn(
  lines: OcrLine[],
  lineIndex: number,
  word: OcrLine["words"][number],
  charWidth: number,
  angle: number
): boolean {
  const edge = rightEdgeXOfBox(word.word.boundingBox, angle);
  const tolerance = Math.max(charWidth, 4);
  for (let li = 0; li < lines.length; li++) {
    if (li === lineIndex) continue;
    const ws = lines[li].words;
    for (let i = 0; i + 1 < ws.length; i++) {
      if (!/^\d{1,3}$/.test(ws[i].word.text)) continue;
      const next = ws[i + 1].word.text;
      if (!/\d[.,]\d{2}\)?$/.test(next) || /^\d{3}([.,]\d{1,2})?$/.test(next)) continue;
      if (Math.abs(rightEdgeXOfBox(ws[i].word.boundingBox, angle) - edge) <= tolerance) return true;
    }
  }
  return false;
}

interface RawTokenHit {
  lineIndex: number;
  token: MoneyToken;
  bestWord: OcrLine["words"][number];
}

/**
 * FIX 15.2 — a plain space is a legal thousands-grouping separator
 * (NUMBER_TOKEN_PATTERN already matches "3 130.00" as one run), but on a
 * receipt that prints "<quantity> <price>" with a single space between two
 * otherwise-unrelated columns, and the price happens to start with exactly
 * three digits, the same shape looks identical — "3 130.00" (qty 3, price
 * 130.00) is indistinguishable from "3 130.00" (the number 3130.00) by
 * SHAPE alone. Confirmed on 8 positions of a real receipt (V&RO Hospitality,
 * Bengaluru) where this collapsed a quantity and a price into one wrong
 * value. Generic: any POS that separates quantity and price with a space,
 * where the price starts with a 3-digit group, hits this.
 *
 * The disambiguating signal is the same one FIX 11 already uses for
 * same-line decimal disambiguation: COLUMN — specifically, the receipt's
 * OWN column-boundary threshold (geometry.ts's clusterByX, the exact
 * clustering FIX 11 validated on six real fixtures), computed once from
 * every OTHER decimal-shaped value's right edge. That threshold already
 * answers "how big a gap does THIS receipt need before it counts as a
 * column boundary, rather than normal same-column jitter" — comparing the
 * two digit groups' OWN right edges against each other doesn't work (the
 * left group's right edge is naturally offset from the right group's by
 * roughly the right group's own width, genuine grouped number or not), but
 * the actual PHYSICAL GAP between the left group's right edge and the
 * right group's left edge is directly comparable to that threshold: a
 * genuine thousands-grouped figure has only kerning-scale spacing between
 * its digit groups (small, well under the boundary), while a quantity and
 * a price in different columns are separated by the width of an entire
 * unused column (large, at or beyond it). This never compares magnitude (a
 * "12 9.50" quantity/price pair is treated exactly the same way as
 * "10 225.00" — only the gap, measured against this receipt's own
 * established spacing, ever decides).
 *
 * Runs once, receipt-wide, after every line's naive token pass: any token
 * whose raw text contains an internal space is a grouping candidate — split
 * it at that space into a left run and a right run, find the OCR word each
 * run's characters actually overlap, and compare the gap between them
 * against the boundary threshold. Gap within threshold → genuinely one
 * grouped number, kept merged. Gap exceeds it → two separate values; the
 * right run (the price-shaped one) becomes its own entry, and the left run
 * only becomes its own entry if it would have separately qualified as a
 * money token via a currency marker (bare-integer noise like a lone
 * quantity digit still doesn't turn into a phantom ledger entry).
 *
 * When there are fewer than two OTHER decimal-shaped values anywhere on
 * the receipt, geometry.ts's own clustering returns a zero boundary — no
 * column signal exists at all, never invented from magnitude, so any
 * positive gap fails the "within threshold" test. The fallback is
 * conservative rather than permissive: a single, isolated space-grouped
 * run with zero corroborating evidence is split, not merged — matching
 * this pipeline's standing rule that an unverifiable interpretation is
 * surfaced as two observations rather than silently trusted as one, and
 * never risking a repeat of the exact bug this fix exists to close.
 */
function resplitSpaceGroupedTokens(hits: RawTokenHit[], lines: OcrLine[], angle: number): RawTokenHit[] {
  const spaceGroupedIndices = hits
    .map((hit, i) => ({ hit, i }))
    .filter(({ hit }) => hit.token.rawText.includes(" "));
  if (spaceGroupedIndices.length === 0) return hits;

  // Column bands from every decimal-shaped value on the receipt, EXCLUDING
  // the space-grouped candidates themselves (their merged value might be
  // wrong — they must never be allowed to vote on their own disambiguation).
  const referencePoints = hits
    .filter((hit) => !hit.token.rawText.includes(" ") && DECIMAL_SHAPED_TOKEN.test(hit.token.rawText))
    .map((hit) => ({ id: hit.bestWord.word.wordId, x: rightEdgeXOfBox(hit.bestWord.word.boundingBox, angle) }));

  const result: RawTokenHit[] = [];
  const spaceGroupedSet = new Set(spaceGroupedIndices.map(({ i }) => i));

  for (let i = 0; i < hits.length; i++) {
    if (!spaceGroupedSet.has(i)) {
      result.push(hits[i]);
      continue;
    }
    const hit = hits[i];
    const line = lines[hit.lineIndex];
    const spaceIndex = hit.token.rawText.indexOf(" ");
    const splitAt = hit.token.startIndex + spaceIndex;

    const leftWord = findOverlappingWord(line.words, hit.token.startIndex, splitAt);
    const rightWord = findOverlappingWord(line.words, splitAt + 1, hit.token.endIndex);

    // Degenerate: one physical OCR word already spans the whole run (Vision
    // itself read it as a single token with an embedded space) — nothing to
    // compare geometrically, defer to Vision's own word segmentation.
    if (leftWord === null || rightWord === null || leftWord.word.wordId === rightWord.word.wordId) {
      result.push(hit);
      continue;
    }

    // The physical gap between the two words, compared against THIS
    // receipt's own column-boundary threshold (computed from every other
    // decimal-shaped value alone — the candidate itself never votes on its
    // own disambiguation). Fewer than two reference points make
    // clusterByX return a zero boundary, so any real gap fails this test —
    // the documented conservative default when there's no column signal.
    const { boundaryGap } = clusterByX(referencePoints);
    const gap = leftEdgeXOfBox(rightWord.word.boundingBox, angle) - rightEdgeXOfBox(leftWord.word.boundingBox, angle);

    // 03-11-2026 (owner): "Çerez & Meyva   1     600,00" was read as 1600 —
    // on a receipt with wide columns the boundary threshold can exceed the
    // distance from the quantity column to the price column. A thousands
    // separator is one plain space, so a gap wider than about 2 characters
    // (this line's own character width, from the two words' boxes) is never
    // one number, whatever the column threshold says.
    const boxWidth = (w: OcrLine["words"][number]) =>
      rightEdgeXOfBox(w.word.boundingBox, angle) - leftEdgeXOfBox(w.word.boundingBox, angle);
    const charWidth =
      (boxWidth(leftWord) + boxWidth(rightWord)) /
      Math.max(1, leftWord.word.text.length + rightWord.word.text.length);
    const widerThanASpace = charWidth > 0 && gap > 2 * charWidth;

    // When the gap alone can't tell (a photo taken from further away shrinks
    // it to a space's width), the columns decide: a left run that sits in the
    // same column as the receipt's quantities — integers on OTHER lines that
    // are followed by a price which is clearly not their continuation
    // ("2 2.200,00") — is a quantity, never the first group of the price.
    // Lines that are themselves "1 100,00"-shaped never count as evidence,
    // so a receipt full of space-grouped totals does not split them.
    const inQuantityColumn = alignsWithQuantityColumn(lines, hit.lineIndex, leftWord, charWidth, angle);

    if (gap <= boundaryGap && !widerThanASpace && !inQuantityColumn) {
      result.push(hit); // kerning-scale spacing — one genuine grouped number, keep merged
      continue;
    }

    // Different bands: split. The right run (price-shaped) always becomes
    // its own entry. The left run — always a bare 1-3 digit integer, by
    // construction of NUMBER_TOKEN_PATTERN's grouping shape — only survives
    // as its own entry when a currency marker sits right next to it in the
    // REAL line (the same rule findMoneyTokens applies to any other bare
    // integer). It can never qualify via the "last thing on the line" rule:
    // something (the right run) always follows it here by definition, so
    // re-tokenizing the isolated substring alone would wrongly call it
    // "last on line" and must not be used.
    const rightRaw = hit.token.rawText.slice(spaceIndex + 1);
    const rightValue = parseAmbiguousNumber(rightRaw);
    if (rightValue !== null) {
      result.push({
        lineIndex: hit.lineIndex,
        token: { ...hit.token, rawText: rightRaw, value: rightValue, startIndex: splitAt + 1, hasDecimal: /[.,]\d{1,2}$/.test(rightRaw) },
        bestWord: rightWord,
      });
    }
    const leftRaw = hit.token.rawText.slice(0, spaceIndex);
    const beforeLeft = line.text.slice(0, hit.token.startIndex);
    const afterLeft = line.text.slice(hit.token.startIndex + leftRaw.length, hit.token.startIndex + leftRaw.length + 3);
    const leftHasCurrency =
      CURRENCY_SYMBOLS.test(beforeLeft.slice(-3)) ||
      CURRENCY_SYMBOLS.test(afterLeft) ||
      CURRENCY_CODE_NEARBY.test(beforeLeft.slice(-5)) ||
      CURRENCY_CODE_NEARBY.test(afterLeft);
    if (leftHasCurrency) {
      const leftValue = parseAmbiguousNumber(leftRaw);
      if (leftValue !== null) {
        result.push({
          lineIndex: hit.lineIndex,
          token: { rawText: leftRaw, value: leftValue, startIndex: hit.token.startIndex, endIndex: splitAt, hasDecimal: false, hasCurrencySymbol: true },
          bestWord: leftWord,
        });
      }
    }
  }
  return result;
}

/**
 * Builds the monetary ledger directly from OCR-reconstructed lines. Every
 * money-shaped match on a line is mapped back to the OCR word(s) that
 * overlap its character range — normally exactly one word, since a printed
 * price is almost always a single OCR token. The word with the greatest
 * overlap is used as that entry's evidence anchor (rawText/value already
 * come from the regex match against the line text, not from the word alone,
 * so a token spanning a currency symbol plus digits as separate OCR words
 * still resolves to the correct numeric value).
 *
 * Never deduped by value: repeated identical prices remain distinct
 * entries, because each is anchored to a physically distinct OCR word.
 */
export function buildLedgerFromOcr(lines: OcrLine[]): LedgerEntry[] {
  partialNumberTokensRejectedCounter = 0;
  const hits: RawTokenHit[] = [];

  for (const line of lines) {
    const tokens = findMoneyTokens(line.text);
    for (const token of tokens) {
      const bestWord = findOverlappingWord(line.words, token.startIndex, token.endIndex);
      if (bestWord === null) continue; // no OCR word backs this match — cannot anchor evidence, so skip it
      hits.push({ lineIndex: line.lineIndex, token, bestWord });
    }
  }

  const allWords = lines.flatMap((l) => l.words.map((wo) => wo.word));
  const angle = dominantAngle(allWords);
  const resolved = resplitSpaceGroupedTokens(hits, lines, angle);

  return resolved.map((hit) => ({
    amountId: nextAmountId(),
    wordId: hit.bestWord.word.wordId,
    rawText: hit.token.rawText,
    value: hit.token.value,
    lineIndex: hit.lineIndex,
    boundingBox: hit.bestWord.word.boundingBox,
    ocrConfidence: hit.bestWord.word.confidence,
    source: "ocr",
  }));
}
