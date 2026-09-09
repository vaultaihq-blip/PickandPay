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

/** A number-shaped run: digits, optional grouping/decimal separators. */
const NUMBER_TOKEN_PATTERN =
  /-?\(?\d{1,3}(?:[.,\s  ]\d{3})*(?:[.,]\d{1,2})?\)?/g;

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
  const entries: LedgerEntry[] = [];

  for (const line of lines) {
    const tokens = findMoneyTokens(line.text);
    for (const token of tokens) {
      let bestOverlap = 0;
      let bestWord: OcrLine["words"][number] | null = null;
      for (const wordOffset of line.words) {
        const overlap =
          Math.min(token.endIndex, wordOffset.end) - Math.max(token.startIndex, wordOffset.start);
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestWord = wordOffset;
        }
      }
      if (bestWord === null) continue; // no OCR word backs this match — cannot anchor evidence, so skip it

      entries.push({
        amountId: nextAmountId(),
        wordId: bestWord.word.wordId,
        rawText: token.rawText,
        value: token.value,
        lineIndex: line.lineIndex,
        boundingBox: bestWord.word.boundingBox,
        ocrConfidence: bestWord.word.confidence,
        source: "ocr",
      });
    }
  }

  return entries;
}
