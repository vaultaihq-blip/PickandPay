/**
 * Deterministic geometric price ownership.
 *
 * FIX 6 proved (Step 0, against the real rotated fixture) that the printed
 * name column and price column drift apart progressively down this
 * receipt, and built a drift-corrected DP matcher that fixed the originally
 * broken tail region (Garlic Shrimp/Pad See Ew/Lowry/Gai Satay).
 *
 * FIX 7 hardens that matcher after live testing surfaced a more dangerous
 * failure: when the semantic pass drops or merges a modifier block (e.g.
 * "Add Shrimp $6.00" silently absorbed into a neighbouring block's line
 * span instead of getting its own), the dropped amount's ledger entry has
 * no owner, and a purely distance/order-based matcher can "heal" that hole
 * by handing the orphaned value to the NEXT block in reading order — which
 * is wrong, and on one real run produced a receipt whose subtotal still
 * matched the printed total by coincidence while three items were actually
 * scrambled. Reconciliation succeeding is therefore never treated as
 * evidence that ownership was correct; it isn't consulted here at all.
 *
 * The fix is territorial, not a distance tweak: every block's OWN reported
 * lineIndices (from the semantic pass, whether or not that block ends up
 * needing a price itself) marks those specific lines as belonging to it.
 * A candidate whose line is already inside a DIFFERENT, unrelated block's
 * territory is never eligible for this block — only genuinely unclaimed
 * lines (no block claims them at all) are searchable across a gap. This is
 * what lets the drift matcher keep reaching forward through several
 * unpriced item names to their shared price cluster (the case FIX 6 fixed)
 * while refusing to reach backward into a neighbour's already-claimed
 * territory (the case that broke FIX 6 under live testing).
 *
 * Pure TypeScript — no Deno-specific imports.
 */

import type { OcrLine, OcrWord } from "./ocr.ts";
import { dominantAngle, toReadingFrame } from "./ocr.ts";
import type { LedgerEntry } from "./ledger.ts";

export interface PriceBlockInput {
  blockId: string;
  kind: "item" | "modifier" | "summary" | "quantity" | "unclassified";
  lineIndices: number[];
  name: string | null;
  parentBlockId: string | null;
  /** GPT's own proposal — used only as a free/paid hint for modifiers, and
   *  as a last-resort (never-confident) fallback when the geometric layer
   *  is genuinely ambiguous. Never the source of which specific value an
   *  item/summary block gets — that is decided here, geometrically. */
  proposedAmountId: string | null;
}

export interface OwnershipResult {
  blockId: string;
  amountId: string | null;
  /** False means the geometric layer could not confidently decide — the
   *  caller must treat this as needing targeted verification or surfacing
   *  as unresolved, never silently accepting whatever amountId is present. */
  confident: boolean;
  /** The block's OWN claimed lineIndices didn't actually contain its name
   *  text, and a different line was found instead — surfaced for logging,
   *  never receipt content. */
  anchorCorrected: boolean;
  /** FIX 25 Part 2 — this block's claimed value crossed order with another
   *  block's (see detectCrossings). Distinct from a generic `confident:
   *  false` DP ambiguity: a crossing is a direct logical contradiction
   *  (reading order disagrees with claimed-value order), not merely two
   *  close candidates — surfaced separately so the caller/diagnostics can
   *  tell the two apart. Never true when amountId is null. */
  crossingDetected: boolean;
}

// ─── Anchor-line correction ─────────────────────────────────────────────────

function textOverlapScore(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const wordsB = new Set(b.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let shared = 0;
  for (const w of wordsA) if (wordsB.has(w)) shared += 1;
  return shared / Math.max(wordsA.size, wordsB.size);
}

/**
 * A block's claimed lineIndices come from the semantic pass and are not
 * trusted blindly. If the block's own name doesn't textually appear on any
 * of its claimed lines, the whole document is searched for the line that
 * actually contains it, and that is used as the geometric anchor instead —
 * this is what eliminates the "block claims a real but wrong line" error
 * class regardless of what caused the wrong claim.
 */
export function correctAnchorLine(block: PriceBlockInput, lines: OcrLine[]): { line: number; corrected: boolean } {
  const claimed = block.lineIndices.filter((i) => i >= 0 && i < lines.length);
  const firstClaimed = claimed.length > 0 ? claimed[0] : 0;
  if (!block.name) return { line: firstClaimed, corrected: false };

  const matchesSomeClaimed = claimed.some((i) => textOverlapScore(block.name as string, lines[i]?.text ?? "") > 0);
  if (matchesSomeClaimed) return { line: firstClaimed, corrected: false };

  let bestLine = firstClaimed;
  let bestScore = 0;
  for (let i = 0; i < lines.length; i++) {
    const score = textOverlapScore(block.name, lines[i].text);
    if (score > bestScore) {
      bestScore = score;
      bestLine = i;
    }
  }
  return bestScore > 0 ? { line: bestLine, corrected: true } : { line: firstClaimed, corrected: false };
}

// ─── Geometry helpers over ledger/line word boxes ───────────────────────────

function wordsNormalY(words: OcrWord[], angle: number): number {
  const ys = words.flatMap((w) => w.boundingBox.vertices.map((v) => toReadingFrame(v.x, v.y, angle).normalY));
  if (ys.length === 0) return 0;
  return (Math.min(...ys) + Math.max(...ys)) / 2;
}

function entryNormalY(entry: LedgerEntry, angle: number): number {
  const ys = entry.boundingBox.vertices.map((v) => toReadingFrame(v.x, v.y, angle).normalY);
  return (Math.min(...ys) + Math.max(...ys)) / 2;
}

/** Median gap between consecutive printed lines' own normalY — a
 *  resolution-independent "one row" scale, used to bound how far a match
 *  can plausibly reach regardless of the source image's pixel dimensions. */
function typicalLineSpacing(lines: OcrLine[], angle: number): number {
  const ys = lines
    .map((l) => wordsNormalY(l.words.map((wo) => wo.word), angle))
    .filter((y) => Number.isFinite(y))
    .sort((a, b) => a - b);
  if (ys.length < 2) return 1;
  const gaps: number[] = [];
  for (let i = 1; i < ys.length; i++) gaps.push(ys[i] - ys[i - 1]);
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 === 0 ? (gaps[mid - 1] + gaps[mid]) / 2 : gaps[mid];
}

// ─── Territory — the local ownership corridor mechanism ────────────────────
//
// Every block's OWN reported lineIndices (from the semantic pass) claims
// those exact lines, regardless of whether that block itself ends up
// needing a price. A candidate sitting on a line some OTHER, unrelated
// block already claims is off-limits — this is what stops a structural
// omission (a dropped modifier block) from being "healed" by a neighbour
// stealing its amount, instead of it correctly surfacing as unresolved.

function buildLineOwnership(blocks: PriceBlockInput[]): Map<number, string> {
  const owner = new Map<number, string>();
  for (const b of blocks) {
    for (const li of b.lineIndices) {
      if (!owner.has(li)) owner.set(li, b.blockId);
    }
  }
  return owner;
}

function isSameFamily(blockId: string, otherBlockId: string, blocks: PriceBlockInput[]): boolean {
  if (blockId === otherBlockId) return true;
  const byId = new Map(blocks.map((b) => [b.blockId, b]));
  const a = byId.get(blockId);
  const b = byId.get(otherBlockId);
  if (!a || !b) return false;
  return a.parentBlockId === otherBlockId || b.parentBlockId === blockId;
}

// ─── Drift regression ───────────────────────────────────────────────────────

interface DriftFit {
  a: number;
  b: number;
}

/** gap ~= a + b * nameY, fit from unambiguous same-line pairs. Requires at
 *  least 3 points; with fewer, drift correction is skipped (gap treated as
 *  0) rather than fit to noise. */
function fitDrift(points: Array<{ nameY: number; gap: number }>): DriftFit | null {
  const n = points.length;
  if (n < 3) return null;
  const sumX = points.reduce((s, p) => s + p.nameY, 0);
  const sumY = points.reduce((s, p) => s + p.gap, 0);
  const sumXY = points.reduce((s, p) => s + p.nameY * p.gap, 0);
  const sumXX = points.reduce((s, p) => s + p.nameY * p.nameY, 0);
  const denom = n * sumXX - sumX * sumX;
  if (Math.abs(denom) < 1e-6) return null;
  const b = (n * sumXY - sumX * sumY) / denom;
  const a = (sumY - b * sumX) / n;
  return { a, b };
}

/**
 * FIX 7.2 — sample standard deviation of the fit's OWN residuals (observed
 * gap minus the gap the fit predicts) over the exact same confident pairs
 * fitDrift used. This is the "typical noise" scale for this receipt's own
 * geometry — used afterward to tell a candidate that is merely a weak match
 * apart from one that is nowhere near where the model says this block's
 * price should be (see RESIDUAL_SIGMA_MULTIPLIER below). Always defined
 * when a drift fit exists, since fitDrift itself already requires 3+ points.
 */
function driftResidualStdDev(points: Array<{ nameY: number; gap: number }>, drift: DriftFit): number {
  const residuals = points.map((p) => p.gap - (drift.a + drift.b * p.nameY));
  const mean = residuals.reduce((s, r) => s + r, 0) / residuals.length;
  const variance =
    residuals.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(1, residuals.length - 1);
  return Math.sqrt(variance);
}

// ─── Global monotonic matcher (dynamic programming) ─────────────────────────
//
// Receipt lines preserve order: for items A, B, C and prices A, B, C,
// ownership must be monotonic (no crossing) unless the geometric evidence
// overwhelmingly says otherwise. This is a direct sequence-alignment DP —
// it explicitly supports a SKIP_BLOCK move (leave a block unmatched) and a
// SKIP_CANDIDATE move (leave a candidate an orphan) at every step, never
// only a forced match. Skipping a candidate is free; skipping a block costs
// a fixed penalty — but that penalty is deliberately modest (a small
// multiple of one printed line's typical spacing, not an arbitrarily huge
// constant), so a sufficiently bad match legitimately loses to leaving the
// block unmatched, per requirement: never optimise for maximum match count.

/** Two candidates within this many normalized units of each other are
 *  "too close to call" for a given block — never guessed, escalated instead. */
const AMBIGUITY_MARGIN = 3;

/**
 * FIX 7.2 — a candidate whose residual against the drift model exceeds this
 * many standard deviations of the model's own fit noise is not a weak
 * match, it belongs somewhere else.
 *
 * Measured against the real fixture (supabase/functions/parse-receipt/
 * __fixtures__/vision-pai-toronto-rotated.json), full-receipt block context,
 * residualStdDev ~= 0.98: the spec's starting point of 3sigma (~2.94) is too
 * tight — it rejects two genuinely correct matches (Garlic Shrimp's real
 * price at 3.74sigma, Pad See Ew's at 4.19sigma), while the actual bad case
 * this guard exists to catch (the orphaned "Add Shrimp" 6.00 pulled toward
 * BTL Tempranillo) sits at ~53.6sigma. 3sigma does not separate good from
 * bad on this data; 6sigma does, with a comfortable margin on both sides
 * (~1.4x above the worst observed good residual, ~9x below the smallest
 * observed bad one) — chosen from that separation, not to make a specific
 * test pass. */
const RESIDUAL_SIGMA_MULTIPLIER = 6;

function monotonicMatch(
  blocks: Array<{ blockId: string; kind: PriceBlockInput["kind"]; nameY: number; proposedAmountId: string | null; eligible: (candidateIndex: number) => boolean }>,
  candidates: LedgerEntry[],
  angle: number,
  drift: DriftFit | null,
  unmatchedBlockPenalty: number,
  maxPlausibleDistance: number,
  residualStdDev: number | null,
  itemsRegionEnd: number,
  summaryBoundaryPenalty: number
): OwnershipResult[] {
  const n = blocks.length;
  const m = candidates.length;
  const candY = candidates.map((c) => entryNormalY(c, angle));

  const predictedPriceY = (i: number) => blocks[i].nameY + (drift ? drift.a + drift.b * blocks[i].nameY : 0);
  const rawCost = (i: number, j: number) => Math.abs(candY[j] - predictedPriceY(i));
  const residualLimit = residualStdDev !== null ? RESIDUAL_SIGMA_MULTIPLIER * residualStdDev : null;
  // Ineligible (wrong territory, or implausibly far) candidates are
  // infinitely costly — the DP will always prefer skipping over them.
  const cost = (i: number, j: number) => {
    if (!blocks[i].eligible(j)) return Infinity;
    // FIX 7.1 — hard guard: a line's own printed price never sits ABOVE
    // that line's name in reading order. A candidate positioned before the
    // block's own anchor line is not a weak match, it is a geometrically
    // impossible one — reject outright, never silently absorb it.
    if (candY[j] < blocks[i].nameY) return Infinity;
    const d = rawCost(i, j);
    if (d > maxPlausibleDistance) return Infinity;
    // FIX 7.2 — residual guard: a candidate whose deviation from the drift
    // model's own predicted position dwarfs the model's own fit noise is
    // not "the nearest thing left over", it is evidence this value belongs
    // to a block that doesn't exist in this structure (e.g. a dropped
    // modifier) — leaving it an orphan is the honest outcome, not handing
    // it to whichever block happens to be next in reading order.
    if (residualLimit !== null && d > residualLimit) return Infinity;
    // FIX 25 Part 1 — an item/modifier block reaching a candidate at or
    // past itemsRegionEnd pays a strong penalty, same pattern as
    // unmatchedBlockPenalty: never infinite (Mad God has a real, correct
    // claim past the boundary when its own summary label appears early in
    // read order while item content still follows — a hard wall would
    // break it), but calibrated high enough that a legitimate in-region
    // candidate always wins when one exists (see the calibration note on
    // SUMMARY_BOUNDARY_PENALTY below). Summary blocks are exempt — their
    // own values legitimately live at or past this boundary.
    const crossesBoundary =
      (blocks[i].kind === "item" || blocks[i].kind === "modifier") && candidates[j].lineIndex >= itemsRegionEnd;
    return crossesBoundary ? d + summaryBoundaryPenalty : d;
  };

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  const move: string[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(""));
  for (let i = 1; i <= n; i++) {
    dp[i][0] = dp[i - 1][0] + unmatchedBlockPenalty;
    move[i][0] = "skipBlock";
  }
  for (let j = 1; j <= m; j++) {
    dp[0][j] = dp[0][j - 1];
    move[0][j] = "skipCandidate";
  }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const c = cost(i - 1, j - 1);
      const viaMatch = c === Infinity ? Infinity : dp[i - 1][j - 1] + c;
      const viaSkipCandidate = dp[i][j - 1];
      const viaSkipBlock = dp[i - 1][j] + unmatchedBlockPenalty;
      if (viaMatch <= viaSkipCandidate && viaMatch <= viaSkipBlock) {
        dp[i][j] = viaMatch;
        move[i][j] = "match";
      } else if (viaSkipCandidate <= viaSkipBlock) {
        dp[i][j] = viaSkipCandidate;
        move[i][j] = "skipCandidate";
      } else {
        dp[i][j] = viaSkipBlock;
        move[i][j] = "skipBlock";
      }
    }
  }

  const matchedBlockToCandidate = new Map<number, number>();
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const m2 = i > 0 && j > 0 ? move[i][j] : i > 0 ? "skipBlock" : "skipCandidate";
    if (m2 === "match") {
      matchedBlockToCandidate.set(i - 1, j - 1);
      i -= 1;
      j -= 1;
    } else if (m2 === "skipCandidate") {
      j -= 1;
    } else {
      i -= 1;
    }
  }

  const results: OwnershipResult[] = [];
  for (let bi = 0; bi < n; bi++) {
    const matchedJ = matchedBlockToCandidate.get(bi);
    if (matchedJ === undefined) {
      results.push({ blockId: blocks[bi].blockId, amountId: null, confident: false, anchorCorrected: false, crossingDetected: false });
      continue;
    }
    const costs = candidates.map((_, cj) => cost(bi, cj));
    const sorted = [...costs].sort((x, y) => x - y);
    const best = sorted[0];
    const second = sorted.length > 1 ? sorted[1] : Infinity;
    const confident = second - best > AMBIGUITY_MARGIN;
    results.push({
      blockId: blocks[bi].blockId,
      amountId: confident ? candidates[matchedJ].amountId : null,
      confident,
      anchorCorrected: false,
      crossingDetected: false,
    });
  }
  return results;
}

/**
 * FIX 25 Part 2 — a post-hoc, whole-result check: reading order (by each
 * block's own anchor Y) must agree with claimed-value order (by each
 * claimed entry's own Y), for EVERY item/modifier block that ended up with
 * ANY amountId at all, confident or not, from EITHER pass. This is the gap
 * monotonicMatch's own no-crossing guarantee never covered: it only
 * protects blocks that entered the SECOND pass (see its own header
 * comment). A block resolved by the FIRST pass's "same line, one
 * candidate" fast path (Hollywood Cafe's exact shape: a genuinely
 * row-aligned but semantically swapped OCR line — the price column sits
 * one row off from the name column, so "SODA"'s row is where Cheese
 * Steak's real price landed) never passes through the DP at all, so its
 * match is never checked against anyone else's.
 *
 * Ties in VALUE are irrelevant — only the ORDER of each block's OWN
 * claimed-value position is compared, never the value itself, so Mad
 * God's repeated-value items (three "16.95"s on three different,
 * correctly-increasing lines) never trigger this.
 *
 * Returns the set of blockIds involved in at least one crossing. The
 * caller never tries to decide which of the two is right — both are
 * demoted to unresolved (see the caller's own comment).
 */
function detectCrossings(
  claims: Array<{ blockId: string; nameY: number; amountId: string | null }>,
  ledgerByAmountId: Map<string, LedgerEntry>,
  angle: number
): Set<string> {
  const withValue = claims
    .filter((c): c is { blockId: string; nameY: number; amountId: string } => c.amountId !== null && ledgerByAmountId.has(c.amountId))
    .map((c) => ({ blockId: c.blockId, nameY: c.nameY, valueY: entryNormalY(ledgerByAmountId.get(c.amountId)!, angle) }))
    .sort((a, b) => a.nameY - b.nameY);

  const crossed = new Set<string>();
  for (let i = 1; i < withValue.length; i++) {
    if (withValue[i].valueY < withValue[i - 1].valueY) {
      crossed.add(withValue[i - 1].blockId);
      crossed.add(withValue[i].blockId);
    }
  }
  return crossed;
}

// ─── FIX 27 — constant column offset, arbitrated by the printed subtotal ──
//
// FIX 26 measured a name→value offset AFTER correctAnchorLine and found it
// always collapses to 0, whether the match is right or wrong — correction
// relocates a block to wherever its OWN name text is, then the first-pass
// same-line rule grabs whatever decimal sits on that same (now-correct)
// line, so the offset from the corrected anchor can never distinguish a
// genuine same-line print from a value that is really the NEXT item's price
// printed one row early. Proven against the real Hollywood Cafe fixture
// (see ownership.test.ts's DC test and this round's report): the signal
// exists only in the RAW OCR shape, before any block's value is decided —
// a bare monetary value with no descriptive text on its own line, followed
// by a run of name+value lines, ending in a bare descriptive line with no
// value at all. Detecting that shape decides nothing by itself; only the
// printed subtotal — independent testimony already on the page, derived
// from neither hypothesis — decides which reading (as printed, H0, or
// shifted back one position, H1) is adopted.

/** A line's shape, from its own OCR text and whatever ledger entries (any
 *  kind — item, modifier, or otherwise) sit on it — never from what any
 *  block claims, since a block's OWN claimed line can itself be wrong (the
 *  GPT off-by-one that made correctAnchorLine necessary in the first
 *  place). Deliberately independent of block claims for exactly that
 *  reason. */
type LineShape = "VALUE_ONLY" | "NAME_ONLY" | "MIXED" | "OTHER";

function lineHasDecimalValue(lineIndex: number, ledger: LedgerEntry[]): boolean {
  return ledger.some((e) => e.lineIndex === lineIndex && /[.,]\d{2}$/.test(e.rawText));
}

function classifyLineShape(lineIndex: number, lines: OcrLine[], ledger: LedgerEntry[]): LineShape {
  const hasValue = lineHasDecimalValue(lineIndex, ledger);
  const hasLetters = /[a-zA-Z]/.test(lines[lineIndex]?.text ?? "");
  if (hasValue && !hasLetters) return "VALUE_ONLY";
  if (!hasValue && hasLetters) return "NAME_ONLY";
  if (hasValue && hasLetters) return "MIXED";
  return "OTHER";
}

export interface ConstantOffsetRun {
  startLine: number;
  endLine: number;
  /** item/modifier blocks affected, in physical (corrected-anchor) order —
   *  every one of them currently owns the value that really belongs to the
   *  NEXT block in this run. */
  blockIds: string[];
  /** H1's proposed amountId per affected block: the k-th block in the run
   *  (by corrected anchor) paired with the k-th decimal value found across
   *  the run's lines (by lineIndex) — a pure positional zip, not a re-run
   *  of any distance/territory search. Null when the run's name count and
   *  value count don't match 1:1 — a malformed run is never forced into a
   *  guess; the caller simply has nothing to offer for it. */
  h1AmountIds: Map<string, string | null> | null;
}

/**
 * Step 1 (FIX 27): find every maximal run, within the items region and at
 * or after the first item/modifier block's own earliest claimed line
 * (never the receipt header — "AM Dining Rm" is NAME_ONLY too, and has
 * nothing to do with this), matching VALUE_ONLY, then zero or more MIXED,
 * then NAME_ONLY. Detection alone decides nothing — see the caller for
 * Step 2's arbitration against the printed subtotal.
 */
export function detectConstantOffsetRuns(
  blocks: PriceBlockInput[],
  ledger: LedgerEntry[],
  lines: OcrLine[],
  itemsRegionEnd: number
): ConstantOffsetRun[] {
  const itemLikeBlocks = blocks.filter((b) => b.kind === "item" || b.kind === "modifier");
  if (itemLikeBlocks.length === 0) return [];

  const firstItemLine = Math.min(
    ...itemLikeBlocks.map((b) => (b.lineIndices.length > 0 ? Math.min(...b.lineIndices) : Infinity))
  );
  if (!Number.isFinite(firstItemLine)) return [];

  // Corrected anchors are used here ONLY to know which physical line each
  // block's name really sits on — reliable line IDENTITY, not the offset
  // measurement FIX 26 showed is dead. A block's own raw-reported line can
  // itself be wrong (independent of the print-offset bug), so identity
  // still needs correcting; only measuring "distance from this corrected
  // line" is the dead signal, and nothing here does that.
  const blockByAnchorLine = new Map<number, string>();
  for (const b of itemLikeBlocks) {
    const { line } = correctAnchorLine(b, lines);
    if (!blockByAnchorLine.has(line)) blockByAnchorLine.set(line, b.blockId);
  }

  // A line is claimed by whichever block's OWN raw (uncorrected) lineIndices
  // lists it — this is what a normal multi-line item (name on one line,
  // its own price on the very next) already looks like: the price line is
  // legitimately part of the item's OWN reported span, not an orphan. Only
  // a candidate leading value with NO such owner — or whose only owner ends
  // up IN this same run anyway (Hollywood Cafe: GPT's own off-by-one claim
  // still names the very block the run reassigns) — is treated as the
  // genuine "unclaimed value before the chain" signal Step 1 is after.
  // Without this, a plain, correctly-printed two-line-per-item receipt
  // (CY) reads as a false positive on every consecutive item boundary —
  // confirmed by direct construction before this guard was added.
  const rawLineOwner = new Map<number, string>();
  for (const b of itemLikeBlocks) {
    for (const li of b.lineIndices) if (!rawLineOwner.has(li)) rawLineOwner.set(li, b.blockId);
  }

  const runs: ConstantOffsetRun[] = [];
  const end = Math.min(itemsRegionEnd, lines.length);
  let i = firstItemLine;
  while (i < end) {
    if (classifyLineShape(i, lines, ledger) === "VALUE_ONLY") {
      let j = i + 1;
      while (j < end && classifyLineShape(j, lines, ledger) === "MIXED") j += 1;
      if (j < end && classifyLineShape(j, lines, ledger) === "NAME_ONLY") {
        const blockIds: string[] = [];
        for (let li = i + 1; li <= j; li++) {
          const bId = blockByAnchorLine.get(li);
          if (bId) blockIds.push(bId);
        }
        const values = ledger
          .filter((e) => e.lineIndex >= i && e.lineIndex < j && /[.,]\d{2}$/.test(e.rawText))
          .sort((a, b) => a.lineIndex - b.lineIndex);
        const blockIdSet = new Set(blockIds);
        const anyValueAlreadyOwnedOutsideRun = values.some((v) => {
          const owner = rawLineOwner.get(v.lineIndex);
          return owner !== undefined && !blockIdSet.has(owner);
        });
        const countsMatch = blockIds.length > 0 && blockIds.length === values.length;
        const h1AmountIds =
          !anyValueAlreadyOwnedOutsideRun && countsMatch
            ? new Map(blockIds.map((id, idx) => [id, values[idx].amountId] as const))
            : null;
        runs.push({ startLine: i, endLine: j, blockIds, h1AmountIds });
        i = j + 1;
        continue;
      }
    }
    i += 1;
  }
  return runs;
}

// ─── Public entry point ─────────────────────────────────────────────────────

export function computeGeometricOwnership(
  blocks: PriceBlockInput[],
  ledger: LedgerEntry[],
  lines: OcrLine[],
  /** FIX 25 Part 1 — the items/summary boundary (computeItemsRegionEnd's own
   *  return value; Infinity when no summary block exists at all, which
   *  naturally makes the boundary penalty below inert). Defaults to
   *  Infinity so every existing caller/test keeps its prior behavior
   *  unchanged unless it opts in. */
  itemsRegionEnd: number = Infinity
): OwnershipResult[] {
  if (blocks.length === 0) return [];

  const allWords = lines.flatMap((l) => l.words.map((wo) => wo.word));
  const angle = dominantAngle(allWords);
  const lineOwnership = buildLineOwnership(blocks);
  const spacing = typicalLineSpacing(lines, angle);
  // A weak/implausible match must lose to leaving the value unresolved —
  // both penalties scale with this document's own geometry, never a fixed
  // pixel constant, so they hold regardless of source image resolution.
  const unmatchedBlockPenalty = spacing * 4;
  const maxPlausibleDistance = spacing * 3;
  // FIX 25 Part 1 — calibrated against all 11 corpus fixtures (see the
  // measurement report for the exact table and the calibration trace that
  // caught the first, wrong value here). MUST stay strictly LESS than
  // unmatchedBlockPenalty: a penalty at or above unmatchedBlockPenalty
  // makes crossing the boundary lose to skipping UNCONDITIONALLY,
  // regardless of match quality — an absolute wall in disguise, not "loses
  // to a legitimate alternative, wins over nothing" as required. Half of
  // unmatchedBlockPenalty leaves real headroom: a close, well-supported
  // match (Mad God's shape — a genuine claim a few lines past the
  // boundary with no in-region alternative at all) still beats skipping,
  // while a far, unsupported reach (Buca di Beppo's shape — the Subtotal/
  // Total sitting many lines away with a real, closer in-region price
  // going unused) loses to skipping just as before.
  const summaryBoundaryPenalty = unmatchedBlockPenalty / 2;

  const anchors = new Map<string, { line: number; corrected: boolean }>();
  for (const b of blocks) anchors.set(b.blockId, correctAnchorLine(b, lines));

  // A block always needs ownership if it's an item or summary; a modifier
  // needs it only when the semantic pass itself signalled a paid modifier
  // (a genuinely free modifier, e.g. "No Spice", should never be forced
  // into the search). "quantity"/"unclassified" blocks never need a price
  // themselves, but they still participate in territory below.
  const needing = blocks.filter(
    (b) => b.kind === "item" || b.kind === "summary" || (b.kind === "modifier" && b.proposedAmountId !== null)
  );

  const claimed = new Set<string>();
  const results = new Map<string, OwnershipResult>();
  const remaining: PriceBlockInput[] = [];

  // First pass: unambiguous same-line assignment — the common case, and
  // also the source of ground truth for the drift fit below.
  for (const b of needing) {
    const anchor = anchors.get(b.blockId)!;
    // Decimal-formatted only — a bare integer sharing the block's anchor
    // line (a size/quantity marker like "10" printed on its own line, which
    // OCR's bare-integer-at-end-of-line rule can admit to the ledger) is
    // never a real price, and must not be grabbed just because it happens
    // to sit on the claimed line.
    const onLine = ledger.filter((e) => e.lineIndex === anchor.line && !claimed.has(e.amountId) && /[.,]\d{2}$/.test(e.rawText));
    if (onLine.length === 1) {
      claimed.add(onLine[0].amountId);
      results.set(b.blockId, { blockId: b.blockId, amountId: onLine[0].amountId, confident: true, anchorCorrected: anchor.corrected, crossingDetected: false });
    } else {
      remaining.push(b);
    }
  }

  // Fit drift from the first-pass pairs.
  const driftPoints: Array<{ nameY: number; gap: number }> = [];
  for (const [blockId, r] of results) {
    if (r.amountId === null) continue;
    const anchor = anchors.get(blockId)!;
    const nameY = wordsNormalY(lines[anchor.line]?.words.map((wo) => wo.word) ?? [], angle);
    const entry = ledger.find((e) => e.amountId === r.amountId);
    if (!entry) continue;
    driftPoints.push({ nameY, gap: entryNormalY(entry, angle) - nameY });
  }
  const drift = fitDrift(driftPoints);
  const residualStdDev = drift ? driftResidualStdDev(driftPoints, drift) : null;

  // Second pass: DP monotonic match among leftover blocks and leftover
  // decimal-formatted (price-shaped) unclaimed ledger entries — restricted
  // per block to candidates whose line is NOT already territory of a
  // different, unrelated block (the local ownership corridor).
  const candidates = ledger
    .filter((e) => !claimed.has(e.amountId) && /[.,]\d{2}$/.test(e.rawText))
    .sort((a, b) => a.lineIndex - b.lineIndex);

  const remainingWithY = remaining
    .map((b) => {
      const anchor = anchors.get(b.blockId)!;
      const nameY = wordsNormalY(lines[anchor.line]?.words.map((wo) => wo.word) ?? [], angle);
      const eligible = (candidateIndex: number) => {
        const owner = lineOwnership.get(candidates[candidateIndex].lineIndex);
        return owner === undefined || isSameFamily(b.blockId, owner, blocks);
      };
      return { blockId: b.blockId, kind: b.kind, nameY, proposedAmountId: b.proposedAmountId, anchorCorrected: anchor.corrected, eligible };
    })
    .sort((x, y) => x.nameY - y.nameY);

  const matched = monotonicMatch(
    remainingWithY,
    candidates,
    angle,
    drift,
    unmatchedBlockPenalty,
    maxPlausibleDistance,
    residualStdDev,
    itemsRegionEnd,
    summaryBoundaryPenalty
  );
  // FIX 8.1 — the ambiguous-fallback path below (falling back to GPT's own
  // proposedAmountId when the geometric layer isn't confident) used to hand
  // out that amountId unconditionally, never checking whether some OTHER
  // block already owns it. A real run showed exactly this: GPT proposed the
  // same amountId for two different blocks (Garlic Shrimp, confidently
  // matched by the DP itself, and Pad See Ew's modifier, geometrically
  // ambiguous) and both ended up claiming it. "One monetary occurrence,
  // claimed once" was already the rule for the DP (a 1-to-1 alignment can't
  // reuse a candidate) and for first-pass same-line matches (guarded by the
  // `claimed` set) — this closes the same rule's only remaining hole.
  //
  // The check runs against `matched` in full, not incrementally per block:
  // `alreadyClaimed` is built from the first-pass `claimed` set plus every
  // CONFIDENT amountId the DP itself produced (both already-finished,
  // independent of how `matched` is ordered), and `proposalCounts` tallies
  // every fallback candidate's proposedAmountId across the WHOLE batch
  // before any of them is accepted. A fallback proposal is only accepted
  // when it clears both checks — not already owned, and not also proposed
  // by some other block in this same batch. Two blocks proposing the same
  // id are therefore decided as one group, not first-come-first-served, so
  // the outcome never depends on iteration order.
  const alreadyClaimed = new Set(claimed);
  for (const r of matched) {
    if (r.amountId !== null) alreadyClaimed.add(r.amountId);
  }
  const proposalCounts = new Map<string, number>();
  for (const r of matched) {
    if (r.amountId !== null) continue;
    const meta = remainingWithY.find((x) => x.blockId === r.blockId);
    if (!meta?.proposedAmountId) continue;
    proposalCounts.set(meta.proposedAmountId, (proposalCounts.get(meta.proposedAmountId) ?? 0) + 1);
  }
  for (const r of matched) {
    const meta = remainingWithY.find((x) => x.blockId === r.blockId);
    if (r.amountId === null && !r.confident && meta?.proposedAmountId) {
      const proposed = meta.proposedAmountId;
      const contested = (proposalCounts.get(proposed) ?? 0) > 1;
      const alreadyOwned = alreadyClaimed.has(proposed);
      if (!contested && !alreadyOwned) {
        // Geometric layer is ambiguous or found nothing eligible — fall
        // back to GPT's own proposal rather than leaving it unresolved, but
        // never mark it confident: the caller must still treat this as
        // suspicious and eligible for targeted verification.
        results.set(r.blockId, { blockId: r.blockId, amountId: proposed, confident: false, anchorCorrected: meta.anchorCorrected, crossingDetected: false });
      } else {
        // Already owned elsewhere, or another block wants the same value —
        // neither block "deserves" it more than the other; both stay
        // unresolved and honestly suspicious rather than one silently
        // winning a coin flip decided by processing order.
        results.set(r.blockId, { blockId: r.blockId, amountId: null, confident: false, anchorCorrected: meta.anchorCorrected, crossingDetected: false });
      }
    } else {
      results.set(r.blockId, { ...r, anchorCorrected: meta?.anchorCorrected ?? false });
    }
  }

  // FIX 25 Part 2 — crossing check over the FULL, final result set (both
  // passes combined). Never attempts to pick the "right" one of a crossed
  // pair — see detectCrossings's own comment. amountId is nulled (not just
  // marked unconfident) so a crossing-affected value is fully excluded from
  // arithmetic downstream (buildFinalPayload/reconcile), guaranteeing the
  // receipt is flagged rather than silently accepted with swapped values —
  // production still gets a chance to resolve it via targeted verification
  // (findOwnershipAmbiguous already covers any confident:false result with
  // a non-null amountId; this is confident:false with amountId:null, so
  // it surfaces as a genuine items-region gap instead).
  const ledgerByAmountId = new Map(ledger.map((e) => [e.amountId, e]));
  const orderedClaims = needing
    .filter((b) => b.kind === "item" || b.kind === "modifier")
    .map((b) => {
      const anchor = anchors.get(b.blockId)!;
      const nameY = wordsNormalY(lines[anchor.line]?.words.map((wo) => wo.word) ?? [], angle);
      return { blockId: b.blockId, nameY, amountId: results.get(b.blockId)?.amountId ?? null };
    });
  const crossed = detectCrossings(orderedClaims, ledgerByAmountId, angle);
  for (const blockId of crossed) {
    const r = results.get(blockId);
    if (r) results.set(blockId, { ...r, amountId: null, confident: false, crossingDetected: true });
  }

  return blocks.map(
    (b) => results.get(b.blockId) ?? { blockId: b.blockId, amountId: null, confident: true, anchorCorrected: false, crossingDetected: false }
  );
}
