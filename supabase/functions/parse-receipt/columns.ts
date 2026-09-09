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

/**
 * A token's RIGHT edge in reading-frame X, not its center. Verified against
 * the real fixtures: a right-aligned value column's printed numbers vary in
 * digit count ("2,00" vs "300,25"), and a shorter number's box CENTER sits
 * measurably further right (relative to the column) than a longer number's
 * — center-based clustering on Quebra Mar's real data split one genuine
 * column into two. The right edge is where a right-aligned column actually
 * aligns, regardless of how many digits any one entry has.
 */
function rightEdgeX(entry: LedgerEntry, angle: number): number {
  return Math.max(...entry.boundingBox.vertices.map((v) => toReadingFrame(v.x, v.y, angle).normalX));
}

/** Only decimal-formatted tokens are candidates for column analysis — a
 *  bare integer (table number, quantity written without decimals, a
 *  postal-code fragment) was never eligible to be a line price anywhere
 *  else in this pipeline either; column detection doesn't need to see it. */
const DECIMAL_SHAPED = /[.,]\d{2}$/;

export interface ColumnBand {
  minX: number;
  maxX: number;
  memberIds: string[];
}

/**
 * A gap between consecutive sorted X positions this many times the
 * receipt's OWN typical within-column spacing marks a column boundary.
 * Measured directly against all six real fixtures (right-edge X, near-zero
 * gaps excluded from the reference — see medianOf/spacingGaps below):
 *
 *   fixture      reference gap   6x threshold   smallest real boundary
 *   Toronto            1.5             9.1      (single column — n/a)
 *   Quebra Mar         4.4            26.3            116.5
 *   Ramires           11.2            67.2            134.3
 *   Sulbarreiro        1.9            11.3            378.0
 *   Mad God            2.0            12.2             19.5
 *   Augustiner         5.5            32.9            119.9
 *
 * 6x clears the real boundary on every fixture with margin to spare — Mad
 * God is the tightest at ~1.6x headroom, everything else has 2x-33x. Not
 * tuned per-fixture; the same constant applies everywhere, and it was
 * chosen from this table, not adjusted until a specific test passed.
 */
const COLUMN_GAP_MULTIPLIER = 6;

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * 1-D clustering by biggest-relative-gap — splits sorted points into bands
 * wherever a gap exceeds COLUMN_GAP_MULTIPLIER times the median gap across
 * ALL points. The median is computed once globally (not per-cluster):
 * within-column gaps dominate a real receipt's point count, so the global
 * median is itself already a good estimate of "typical within-column
 * spacing" without needing an iterative/recursive scheme.
 */
function clusterByX(points: Array<{ id: string; x: number }>): { bands: ColumnBand[]; boundaryGap: number } {
  if (points.length === 0) return { bands: [], boundaryGap: 0 };
  const sorted = [...points].sort((a, b) => a.x - b.x);
  if (sorted.length === 1) {
    return { bands: [{ minX: sorted[0].x, maxX: sorted[0].x, memberIds: [sorted[0].id] }], boundaryGap: 0 };
  }

  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i].x - sorted[i - 1].x);
  // Repeated identical values (many "1.00" quantities, all rendering at the
  // exact same right-aligned X) produce a run of near-zero gaps that can
  // dominate the gap list and drag the median down to near zero — measured
  // on Mad God's real data: raw median gap was 0.27, collapsing the
  // boundary threshold enough to shatter the genuine Valor column into six
  // fragments. A near-zero gap says "same value repeated", not "typical
  // spacing between distinct column members" — it's excluded from the
  // reference calculation for that reason, not filtered arbitrarily.
  const NEAR_ZERO_GAP = 1;
  const spacingGaps = gaps.filter((g) => g > NEAR_ZERO_GAP);
  const referenceGap = spacingGaps.length > 0 ? medianOf(spacingGaps) : medianOf(gaps);
  // A tiny epsilon floor guards only against a degenerate zero reference
  // (every single gap near-zero) — it is never itself a real threshold.
  const boundaryGap = Math.max(referenceGap * COLUMN_GAP_MULTIPLIER, 1e-6);

  const bands: ColumnBand[] = [];
  let current: Array<{ id: string; x: number }> = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].x - sorted[i - 1].x > boundaryGap) {
      bands.push(toBand(current));
      current = [];
    }
    current.push(sorted[i]);
  }
  bands.push(toBand(current));
  return { bands, boundaryGap };
}

function toBand(points: Array<{ id: string; x: number }>): ColumnBand {
  return {
    minX: Math.min(...points.map((p) => p.x)),
    maxX: Math.max(...points.map((p) => p.x)),
    memberIds: points.map((p) => p.id),
  };
}

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
