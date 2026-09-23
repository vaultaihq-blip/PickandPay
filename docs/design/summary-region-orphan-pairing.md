# Archived design: summary-region orphan label/value pairing

**Status: not implemented.** Archived 2026-09-23 during FIX 37 so the
measurement isn't lost if a future receipt actually needs it. Measured clean
(zero wrong pairings across all 11 corpus fixtures) but does not solve the
case that motivated it — do not build this speculatively; only revive it
against a concrete real receipt where it would change the outcome.

## Why this exists

FIX 37's motivating case: V&RO Bengaluru prints its summary region as two
physically separate columns — labels (`Total Amount`, `SERC @ 10%`, `State
Gst @ 2.5%`, `Central Gst @ 2.5%`, `Round Off`, `Net Amount`) on the left,
values on the right, with a large horizontal gap. `reconstructLines`'s own
two-column merge (FIX 1, `mergeAdjacentTwoColumnLines` in `ocr.ts`) already
solves this shape for a single text-line immediately followed by a single
price-line (the common item-row case), and does correctly merge V&RO's own
`Total Amount 4525.00` (label+value land on the same OCR-reconstructed line).
But four of V&RO's summary lines — `State Gst`, `Central Gst`, `Round Off`,
`Net Amount` — have NO value on their own reconstructed line at all; their
four values (`124.49`, `124.49`, `-0.48`, `5226.00`) land eight lines later,
as their own consecutive run, separated from the labels by four lines of
unrelated trailer text (`KOT NO`, `Total Items`, `User ID`, `Thank You`).

The idea: generalize the two-column merge from "1 text line + 1 price line"
to "N consecutive orphan text lines + N consecutive orphan price lines,
paired in order" — scoped to the summary region only (never items, where a
coincidental count match risked a real regression — see Measurement below).

## Measurement (FIX 37, all 11 corpus fixtures, summary region only)

Definitions used: a line is `TEXT_ONLY` (descriptive text, no decimal
value), `PRICE_ONLY` (a decimal value, no descriptive text), `BOTH`, or
`NEITHER` (no decimal, e.g. a bare reference number). `NEITHER` lines are
transparent — they don't break a run. A `BOTH` line breaks a run outright
(it already has its own decimal, so it can never be an orphan).

| Fatura | Candidate found | Counts match | Result |
|---|---|---|---|
| Augustiner, Hollywood Cafe, Pai, Sulbarreiro | none | — | no risk |
| Buca di Beppo | `Subtotal,Tax` → `100.26,9.02,109.28` | 2≠3 | rejected |
| **Mademoiselle** | `Subtotal,HST` → `$45.00,$5.85` | **2=2** | **correct** (45+5.85=50.85) |
| Mad God | `Total liq.` → 4 values | 1≠4 | rejected |
| Quebra Mar | 2 candidates | no | rejected |
| Ramires | 2 candidates | no | rejected |
| Zoca | 2 candidates | no (6≠3, 1≠3) | rejected |
| V&RO | `Total Items,User ID,Thank You` → `124.49,124.49,-0.48,5226.00` | 3≠4 | rejected |

Zero wrong pairings. The single genuine match (Mademoiselle's `Subtotal`/
`HST`) is correct. This is a clean, safe result by the letter of the guards.

### Why V&RO still isn't solved

`KOT NO : 4797,4806,4834,4852` sits between `Net Amount`'s label line and
its value. Its trailing fragment `4797,48` has decimal shape, so this line
classifies `BOTH`, not `NEITHER` — it is not transparent noise, it breaks
the run. The orphan run of labels (`State Gst`, `Central Gst`, `Round Off`,
`Net Amount`) is cut short right there, before it can accumulate the 4
members needed to match the 4-member value run 8 lines below. What survives
after the break (`Total Items`, `User ID`, `Thank You` — 3 labels) no longer
even has the right count against the 4 orphan values. So the mechanism
measures clean not because it's been proven to solve hard cases, but because
its only two candidate-forming opportunities in this corpus are a case that
happens to be right (Mademoiselle) and a case that happens to fail closed
for an unrelated structural reason (V&RO).

## Decision

Not implemented. Building it would add an un-tested code path (nothing in
FIX 37's own test list needs Mademoiselle's `Subtotal`/`HST` pairing) that
does not unblock the case it was designed for. If a future receipt's total
selection genuinely depends on this kind of pairing, this document has the
guards already measured safe:

- restrict to the summary region only (never items — an early, unscoped
  version of this measurement found a coincidental count match in
  Sulbarreiro's own item rows — `1 Batata Média`/`1 HM Hamburguer` against
  an unrelated pair of VAT-annotated prices two lines later — that would
  have silently mismatched two real items)
- orphan label run and orphan value run must be strictly contiguous and
  immediately adjacent (transparent `NEITHER` lines may sit between them;
  anything with its own decimal value may not)
- counts must match exactly, or the rule does not fire (fail closed)
- pairing preserves order, always
- a label that already has a value on its own line is never part of the
  orphan sequence

## V&RO's own `Net Amount` — registered as a known, documented gap

`Net Amount` (V&RO's real total, 5226.00) has no mechanism in this codebase
that pairs it with its printed value. Total selection for V&RO fails closed
on this specific candidate — Part 1's total-witness logic never gets to
apply its position-vs-charges rule to `Net Amount` at all, because it never
resolves a value for that label in the first place. This is a known,
accepted gap, not a silent failure: V&RO is not one of the four
approved receipts, and its overall classification is unaffected (it was
already blocked, for separate items-region reasons — see FIX 36).
