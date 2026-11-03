/**
 * Generic 1-D X-band clustering, extracted from columns.ts (FIX 11) so it
 * can be reused by ledger.ts (FIX 15.2) without creating a circular import
 * (columns.ts already imports LedgerEntry from ledger.ts). Pure geometry —
 * no knowledge of ledger entries, receipts, or money.
 *
 * Pure TypeScript — no Deno-specific imports.
 */

export interface ColumnBand {
  minX: number;
  maxX: number;
  memberIds: string[];
}

/**
 * A gap between consecutive sorted X positions this many times the data's
 * OWN typical within-band spacing marks a band boundary. See columns.ts's
 * own header comment for the six-fixture measurement this constant was
 * chosen from — reused verbatim here, never re-tuned per call site.
 */
const GAP_MULTIPLIER = 6;

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function toBand(points: Array<{ id: string; x: number }>): ColumnBand {
  return {
    minX: Math.min(...points.map((p) => p.x)),
    maxX: Math.max(...points.map((p) => p.x)),
    memberIds: points.map((p) => p.id),
  };
}

/**
 * 1-D clustering by biggest-relative-gap — splits sorted points into bands
 * wherever a gap exceeds GAP_MULTIPLIER times the median gap across ALL
 * points. See columns.ts's own comment on why near-zero (repeated-value)
 * gaps are excluded from the reference calculation.
 */
export function clusterByX(points: Array<{ id: string; x: number }>): { bands: ColumnBand[]; boundaryGap: number } {
  if (points.length === 0) return { bands: [], boundaryGap: 0 };
  const sorted = [...points].sort((a, b) => a.x - b.x);
  if (sorted.length === 1) {
    return { bands: [{ minX: sorted[0].x, maxX: sorted[0].x, memberIds: [sorted[0].id] }], boundaryGap: 0 };
  }

  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i].x - sorted[i - 1].x);
  const NEAR_ZERO_GAP = 1;
  const spacingGaps = gaps.filter((g) => g > NEAR_ZERO_GAP);
  const referenceGap = spacingGaps.length > 0 ? medianOf(spacingGaps) : medianOf(gaps);
  const boundaryGap = Math.max(referenceGap * GAP_MULTIPLIER, 1e-6);

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
