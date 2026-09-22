/**
 * FIX 11 (Group 1) — column disambiguation for decimal ledger candidates.
 *
 * FIX 10's measurement proved this is THE problem: item-sum deviations of
 * 1.3x-2x across five of six real receipts, with the true printed total
 * never once closing. The common cause, confirmed against the same six
 * fixtures: a printed line can carry several decimal-formatted numbers with
 * different ROLES (quantity, unit price, tax rate, line total), and nothing
 * upstream of this module distinguished them — the first-pass same-line
 * match in ownership.ts simply trusted whichever decimal it found. A
 * quantity printed as "1.00" is exactly as well-formed as a real price; no
 * rule about SHAPE can tell them apart. Only POSITION can.
 *
 * The signal: on every one of the six real fixtures (three different
 * decimal separators, one to four numeric columns per line, single- and
 * multi-column layouts), the authoritative value — the one that actually
 * feeds item totals and the printed subtotal/total — sits in a narrow band
 * of normalized X, distinct from every other column on the same line. This
 * module derives that band from the receipt's own data (never assumes a
 * column count or position) and filters the ledger pool the geometric
 * matcher sees down to it.
 *
 * This is a candidate-filtering layer ONLY. It runs entirely upstream of
 * ownership.ts's matcher — the DP, its guards (FIX 7.1/7.2), and the
 * claimed-once invariant (FIX 8.1) are untouched; they simply receive a
 * cleaner pool. Lines already claimed by a SUMMARY block are exempted
 * entirely (passed through unfiltered) — this fix is about disambiguating
 * ITEM/MODIFIER line prices, not about how summary values are found (that's
 * FIX 10's job, and it already has its own fallback via unclaimed-orphan
 * scanning that does not depend on this module at all).
 *
 * Pure TypeScript — no Deno-specific imports. ocr.ts itself is never
 * modified by this module; only its already-exported reading-frame helpers
 * are used.
 */

import type { OcrLine } from "./ocr.ts";
import { dominantAngle, toReadingFrame } from "./ocr.ts";
import type { LedgerEntry } from "./ledger.ts";
import type { ColumnBand } from "./geometry.ts";
import { clusterByX } from "./geometry.ts";

/**
 * A token's RIGHT edge in reading-frame X, not its center. Verified against
 * the real fixtures: a right-aligned value column's printed numbers vary in
 * digit count ("2,00" vs "300,25"), and a shorter number's box CENTER sits
 * measurably further right (relative to the column) than a longer number's
 * — center-based clustering on Quebra Mar's real data split one genuine
 * column into two. The right edge is where a right-aligned column actually
 * aligns, regardless of how many digits any one entry has.
 */
export function rightEdgeX(entry: LedgerEntry, angle: number): number {
  return Math.max(...entry.boundingBox.vertices.map((v) => toReadingFrame(v.x, v.y, angle).normalX));
}

/**
 * FIX 33 — the same dominantAngle computation candidatePoints already does
 * internally, exposed on its own so a caller that needs BOTH the band (from
 * detectAuthoritativeColumn) AND per-entry right-edge X (to test a specific
 * value against that band, e.g. coverage.ts's Regra A) can get the angle
 * without a second, possibly-divergent reimplementation. Never changes
 * detectAuthoritativeColumn's own return shape — existing callers/tests are
 * unaffected.
 */
export function computeReadingAngle(lines: OcrLine[]): number {
  const allWords = lines.flatMap((l) => l.words.map((wo) => wo.word));
  return dominantAngle(allWords);
}

/** Only decimal-formatted tokens are candidates for column analysis — a
 *  bare integer (table number, quantity written without decimals, a
 *  postal-code fragment) was never eligible to be a line price anywhere
 *  else in this pipeline either; column detection doesn't need to see it. */
const DECIMAL_SHAPED = /[.,]\d{2}$/;

// ColumnBand and the gap-based clusterByX clustering (COLUMN_GAP_MULTIPLIER
// = 6, measured against all six real fixtures) now live in geometry.ts,
// shared with ledger.ts's FIX 15.2 space-thousands disambiguation — the
// exact same tested band logic, not a re-tuned copy.

function candidatePoints(
  ledger: LedgerEntry[],
  lines: OcrLine[],
  exemptLineIndices: ReadonlySet<number>
): { points: Array<{ id: string; x: number }>; angle: number } {
  const allWords = lines.flatMap((l) => l.words.map((wo) => wo.word));
  const angle = dominantAngle(allWords);
  const points = ledger
    .filter((e) => !exemptLineIndices.has(e.lineIndex) && DECIMAL_SHAPED.test(e.rawText))
    .map((e) => ({ id: e.amountId, x: rightEdgeX(e, angle) }));
  return { points, angle };
}

/**
 * The authoritative value column: the RIGHTMOST band among the "dense"
 * ones — dense relative to this receipt's own busiest band (at least half
 * its member count, and at least 2 members), never an absolute count. A
 * two-item receipt's real column can legitimately have very few members; a
 * stray far-right noise token (a date fragment, a terminal ID) is what a
 * relative density floor is for. If NO band clears the relative floor (an
 * extreme edge case — e.g. every candidate is its own isolated point),
 * every band is considered and the rightmost wins regardless, rather than
 * returning nothing.
 */
export function detectAuthoritativeColumn(
  ledger: LedgerEntry[],
  lines: OcrLine[],
  exemptLineIndices: ReadonlySet<number>
): ColumnBand | null {
  const { points } = candidatePoints(ledger, lines, exemptLineIndices);
  if (points.length === 0) return null;

  const { bands } = clusterByX(points);
  if (bands.length === 0) return null;

  const maxDensity = Math.max(...bands.map((b) => b.memberIds.length));
  const denseBands = bands.filter((b) => b.memberIds.length >= 2 && b.memberIds.length >= maxDensity / 2);
  const pool = denseBands.length > 0 ? denseBands : bands;
  return pool.reduce((rightmost, b) => (b.maxX > rightmost.maxX ? b : rightmost));
}

/**
 * Filters the ledger down to what's allowed to be considered a line-price
 * candidate: anything on a summary-claimed line (untouched — FIX 10 handles
 * those), and any decimal entry within the authoritative column's band
 * (with a tolerance margin — half the same gap-derived threshold used to
 * find the column boundaries, so a slightly wider/narrower printed number
 * doesn't fall just outside a hard edge). Everything else — including a
 * non-decimal (bare-integer) entry — is dropped.
 *
 * Bare integers are excluded here, not just left for the matcher's own
 * decimal-only candidate filters to catch: this ledger also becomes GPT's
 * OWN amountId enum (see index.ts) and feeds the ambiguous-fallback path
 * (FIX 8.1) when the geometric layer isn't confident — that fallback trusts
 * whatever GPT proposed with no decimal-shape check of its own. Measured on
 * Mad God: a tax-rate code printed bare ("23", no "%" sign) sat right next
 * to an item whose real price wasn't found, GPT proposed it, and nothing
 * downstream would have caught it if this filter had let it through. This
 * doesn't change any deterministic matching path's behavior — those already
 * required a decimal shape — it closes the one path that didn't.
 *
 * Never mutates or shrinks the caller's own `ledger` reference — returns a
 * new array. Callers that need the FULL ledger for orphan-surfacing or
 * FIX 10's total-closure search must keep using the original, unfiltered
 * ledger for that; only the pool handed to GPT and to
 * computeGeometricOwnership should be the filtered one.
 */
export function filterToAuthoritativeColumn(
  ledger: LedgerEntry[],
  lines: OcrLine[],
  exemptLineIndices: ReadonlySet<number>
): LedgerEntry[] {
  const { points, angle } = candidatePoints(ledger, lines, exemptLineIndices);
  if (points.length === 0) return ledger; // nothing to disambiguate — no signal, remove nothing

  const { bands, boundaryGap } = clusterByX(points);
  const maxDensity = Math.max(...bands.map((b) => b.memberIds.length));
  const denseBands = bands.filter((b) => b.memberIds.length >= 2 && b.memberIds.length >= maxDensity / 2);
  const pool = denseBands.length > 0 ? denseBands : bands;
  const band = pool.reduce((rightmost, b) => (b.maxX > rightmost.maxX ? b : rightmost));
  const margin = boundaryGap / 2;

  return ledger.filter((e) => {
    if (exemptLineIndices.has(e.lineIndex)) return true;
    if (!DECIMAL_SHAPED.test(e.rawText)) return false;
    const x = rightEdgeX(e, angle);
    return x >= band.minX - margin && x <= band.maxX + margin;
  });
}
