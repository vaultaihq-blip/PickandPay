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

// ─── FIX 35 — column roles in the items region ─────────────────────────────
//
// FIX 11 already finds THE authoritative (total) band; this identifies the
// OTHER bands' roles (quantity, unit price) in the items region, using the
// exact same band geometry — detectAuthoritativeColumn's own result IS the
// "total" role here, never recomputed a second way.
//
// Measured against all 11 real corpus fixtures before writing any
// production logic (FIX 35 Part 1 report): the SAME density filter
// detectAuthoritativeColumn already applies (>=2 members, >=half the
// densest band) reliably separates real columns from noise (a date
// fragment, a page/order-number digit) — 7 of 11 real receipts have only
// ONE dense band at all (no separate unit-price column; every price is
// printed as a single combined figure), 2 have exactly two dense bands
// (a unit-price/annotation column plus the total column — Quebra Mar,
// Ramires, Sulbarreiro), and Mad God alone has four, one of which (a
// printed tax rate with no "%" character immediately adjacent, so it
// survives ledger.ts's own money-token filter) is neither quantity nor
// unit price — see the arithmetic-majority search below for why that
// band is correctly never picked.
export interface ColumnRoles {
  quantity: ColumnBand | null;
  unitPrice: ColumnBand | null;
  /** Identical to detectAuthoritativeColumn's own return — never a second,
   *  possibly-divergent definition of "the total column". */
  total: ColumnBand | null;
}

/** How many OCR lines apart a quantity/unit-price candidate and its total
 *  may sit and still be considered the same printed row — covers both the
 *  single-line case (Mad God: qty/unit/rate/total all on one line) and the
 *  multi-line case (Sulbarreiro: name+qty+unit+rate on one OCR line, the
 *  total on the line below, within the same logical row). Deliberately
 *  NOT block-membership-based — the whole point (see coverage.ts's Part 2
 *  header) is a signal that survives regardless of how the semantic pass
 *  grouped lines into blocks. */
const ROW_LINE_WINDOW = 4;

/** Exported for coverage.ts's Part 2 row-arithmetic proof, which needs the
 *  identical row-pairing rule this module already uses internally — a
 *  second reimplementation could silently diverge on the window size. */
export function nearestInBand(entry: LedgerEntry, band: ColumnBand, byAmountId: Map<string, LedgerEntry>): LedgerEntry | null {
  let best: LedgerEntry | null = null;
  let bestDist = Infinity;
  for (const id of band.memberIds) {
    const e = byAmountId.get(id);
    if (!e || e.amountId === entry.amountId) continue;
    const d = Math.abs(e.lineIndex - entry.lineIndex);
    if (d <= ROW_LINE_WINDOW && d < bestDist) {
      best = e;
      bestDist = d;
    }
  }
  return best;
}

/**
 * Every decimal-OR-bare-integer items-region ledger entry, clustered by X —
 * deliberately broader than detectAuthoritativeColumn's own decimal-only
 * pool, because a real quantity or rate column can be bare-integer-shaped
 * (Mad God's leaked rate band; a bare quantity would qualify too, though in
 * practice ledger.ts's own findMoneyTokens rarely keeps one — see this
 * function's header). The TOTAL role is still decided exclusively by
 * detectAuthoritativeColumn's own decimal-only definition, applied to the
 * FULL ledger exactly as every other caller already does — this function
 * only widens the search for what ELSE is around it.
 */
export function detectColumnRoles(
  ledger: LedgerEntry[],
  lines: OcrLine[],
  itemsRegionEnd: number,
  exemptLineIndices: ReadonlySet<number>
): ColumnRoles {
  // detectAuthoritativeColumn's own band is receipt-WIDE (exactly like
  // every other caller uses it, e.g. ownership.ts's matching) — used here
  // ONLY to locate which items-region band is "the" authoritative one by
  // X-overlap. The band this function actually RETURNS as `total` is the
  // items-region-only restriction of it (totalBandHere, below) — returning
  // the unrestricted one would silently pull summary-region entries (a
  // VAT-rate breakdown table, a duplicate "Total Liquido" line) into any
  // items-region sum a caller builds from it. Sulbarreiro's own real shape:
  // its summary section prints multiple values in the exact same X column
  // as the items TOTAL column, and detectAuthoritativeColumn — correctly,
  // for its own purpose — merges them into one receipt-wide band.
  const fullReceiptTotal = detectAuthoritativeColumn(ledger, lines, exemptLineIndices);
  const itemsLedger = ledger.filter((e) => e.lineIndex < itemsRegionEnd);
  if (itemsLedger.length === 0 || !fullReceiptTotal) return { quantity: null, unitPrice: null, total: null };

  const angle = computeReadingAngle(lines);
  const points = itemsLedger.map((e) => ({ id: e.amountId, x: rightEdgeX(e, angle) }));
  const { bands: allBands } = clusterByX(points);
  const maxDensity = allBands.length > 0 ? Math.max(...allBands.map((b) => b.memberIds.length)) : 0;
  const denseBands = allBands.filter((b) => b.memberIds.length >= 2 && b.memberIds.length >= maxDensity / 2);

  const fullReceiptTotalIds = new Set(fullReceiptTotal.memberIds);
  const rawTotalBandHere = denseBands.find((b) => b.memberIds.some((id) => fullReceiptTotalIds.has(id))) ?? null;

  const byAmountId = new Map(itemsLedger.map((e) => [e.amountId, e]));

  // The clustering above deliberately pools decimal AND bare-integer
  // entries together (needed to SEE a quantity or leaked-rate band at
  // all — Mad God's own "23"). A "total" is always monetary, though, so
  // once the authoritative band is located, it's restricted back down to
  // decimal-shaped entries only — the exact same DECIMAL_SHAPED rule
  // detectAuthoritativeColumn itself already enforces. Without this, a
  // bare-integer OCR artifact positioned by coincidence in the same X
  // column (Sulbarreiro's own real shape: "ID 500094969" tokenizes a
  // trailing "969" that happens to align with the price column) would
  // silently inflate any sum built from this band.
  const totalBandHere = rawTotalBandHere
    ? { ...rawTotalBandHere, memberIds: rawTotalBandHere.memberIds.filter((id) => DECIMAL_SHAPED.test(byAmountId.get(id)?.rawText ?? "")) }
    : null;
  const otherBands = rawTotalBandHere ? denseBands.filter((b) => b !== rawTotalBandHere) : denseBands;
  if (!totalBandHere || totalBandHere.memberIds.length === 0 || otherBands.length === 0) {
    return { quantity: null, unitPrice: null, total: totalBandHere };
  }

  // Arithmetic-majority search — "the strongest signal is arithmetic,
  // never position" (FIX 35's own instruction): try every remaining band
  // alone (an exact echo of the total, quantity implicitly 1) and every
  // PAIR of remaining bands multiplied together against the nearest total
  // in the row window, and keep whichever combination proves the highest
  // FRACTION of the rows it could check (never a raw count — a sparse but
  // perfect 2/2 must not lose to a noisy 18/40). A band that never
  // participates in the winning combination (Mad God's rate band) is
  // simply excluded, with no rate-specific detector needed.
  let best: { idxs: number[]; proven: number; checked: number } | null = null;
  const better = (proven: number, checked: number) => {
    if (checked === 0) return false;
    if (!best) return true;
    const rate = proven / checked;
    const bestRate = best.proven / best.checked;
    return rate > bestRate || (rate === bestRate && proven > best.proven);
  };

  for (let i = 0; i < otherBands.length; i++) {
    let proven = 0;
    let checked = 0;
    for (const id of otherBands[i].memberIds) {
      const e = byAmountId.get(id)!;
      const t = nearestInBand(e, totalBandHere, byAmountId);
      if (!t) continue;
      checked++;
      if (Math.round(e.value * 100) === Math.round(t.value * 100)) proven++;
    }
    if (better(proven, checked)) best = { idxs: [i], proven, checked };

    for (let j = i + 1; j < otherBands.length; j++) {
      let proven2 = 0;
      let checked2 = 0;
      for (const id of otherBands[i].memberIds) {
        const a = byAmountId.get(id)!;
        const b = nearestInBand(a, otherBands[j], byAmountId);
        const t = nearestInBand(a, totalBandHere, byAmountId);
        if (!b || !t) continue;
        checked2++;
        if (Math.round(Math.round(a.value * 100) * b.value) === Math.round(t.value * 100)) proven2++;
      }
      if (better(proven2, checked2)) best = { idxs: [i, j], proven: proven2, checked: checked2 };
    }
  }

  if (!best) return { quantity: null, unitPrice: null, total: totalBandHere };
  if (best.idxs.length === 1) return { quantity: null, unitPrice: otherBands[best.idxs[0]], total: totalBandHere };

  // Two bands proven together: the one whose values are small whole
  // numbers is "quantity" — a unit price is essentially never printed as
  // an exact integer under 20 on every single row. Ties (ambiguous shape)
  // fall back to print position (left-to-right = qty-then-unit), the same
  // convention every one of this corpus's own headers already uses
  // (QTD/UNID/TOTAL, Qt/P.Unit./Valor, Qty/Rate/Amount) — corroboration,
  // consulted only once arithmetic alone cannot decide, never the primary
  // signal.
  const [i, j] = best.idxs;
  const looksLikeQuantity = (b: ColumnBand) => {
    const vals = b.memberIds.map((id) => byAmountId.get(id)!.value);
    return vals.every((v) => Number.isInteger(v) && v > 0 && v <= 20);
  };
  const iQty = looksLikeQuantity(otherBands[i]);
  const jQty = looksLikeQuantity(otherBands[j]);
  if (iQty && !jQty) return { quantity: otherBands[i], unitPrice: otherBands[j], total: totalBandHere };
  if (jQty && !iQty) return { quantity: otherBands[j], unitPrice: otherBands[i], total: totalBandHere };
  return otherBands[i].minX < otherBands[j].minX
    ? { quantity: otherBands[i], unitPrice: otherBands[j], total: totalBandHere }
    : { quantity: otherBands[j], unitPrice: otherBands[i], total: totalBandHere };
}
