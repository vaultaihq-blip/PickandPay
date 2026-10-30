# Archived design: deterministic items-region start detection

**Status: not implemented.** Archived 2026-09-23 during FIX 37 Part 2. Two
attempts, both measured against all 11 corpus fixtures before touching
production code; both regressed at least one of the four approved receipts,
losing a real item's own price from the items region. Do not build this
speculatively — only revive it against a concrete real receipt failure, and
only after solving the false-positive pattern documented below.

## Why this exists

`computeItemsRegionEnd` (coverage.ts) already knows where the items region
ends, derived from GPT's own structure blocks. Nothing derives where it
*starts* — the header above the first item (merchant name, date/time,
table/bill number) is never excluded, so anything header-shaped that
happens to look like a price gets read as one. V&RO Bengaluru's own
`Date: 30-05-23 Time: 15.19` is exactly this: `15.19` has the identical
shape as a real price elsewhere on the same receipt, so nothing that
excludes by SHAPE can ever catch it — only POSITION can, per this round's
own framing.

## Attempt 1 — same reconstructed line only

Signal: the first line (top to bottom) carrying both descriptive text and a
decimal-shaped value inside the receipt's own authoritative (rightmost
dense) column, **on the same reconstructed OCR line**.

Measured against all 11 fixtures before wiring anything in. Result: badly
wrong on most of them, catastrophically wrong on three of the four approved
receipts:

| Fatura | Chosen start | Problem |
|---|---|---|
| **Sulbarreiro** (approved) | `"TOTAL LEVAR Total (incl IVA) 8.25"` | loses every single item — lands in the summary region |
| **Ramires** (approved) | line 28 | loses item rows before it |
| **Quebra Mar** (approved) | line 57 | loses item rows before it |
| **V&RO** | `"Date: 30-05-23 Time: 15.19"` | picks the exact line the fix exists to exclude |
| Buca di Beppo, Mademoiselle | summary-region lines | lose every item |
| Mad God | line 0 | excludes nothing, not even the merchant header |

Root cause: the authoritative column is computed receipt-wide (items AND
summary share the same right-aligned X position, by design — that's what
makes it "authoritative" for FIX 11's own purpose elsewhere), so a summary
value satisfies the signal just as well as an item's. And on several real
receipts, an item's own name and its column-aligned value print on
DIFFERENT reconstructed lines (the same two-column-split shape already
documented in `summary-region-orphan-pairing.md`) — so the first line
where text and a same-line value coincide is very often not an item row at
all, sometimes not even close to one.

## Attempt 2 — same line OR the immediately-next line

Signal: descriptive text on line N, with a value in the authoritative
column on line N or line N+1 (strict adjacency, no intercalation — the
same guard already measured safe for the FIX 37 Part 1 summary-region
pairing exploration).

This fixed Sulbarreiro cleanly: the receipt's own real shape is `"1 Mn
DoubleChees 3.48 13%"` (item name + an embedded, off-column unit price)
immediately followed by `"3.48"` alone (the row's true column value, an
echo) — exactly the adjacent-line pattern this version targets. Detected
start: line 20, the first real item, item count unaffected.

But it introduced a DIFFERENT false positive on two more approved
receipts, both through the same mechanism: a `"Preco: X,XX/Uni"`
unit-price annotation line (already known and excluded elsewhere — see
`columns.test.ts`'s own test AB) is itself descriptive text, and it can sit
immediately before a LATER, unrelated item's own fully-merged
name+price line. The annotation line then falsely satisfies "text on line
N, in-band value on line N+1" — pointing the detected start at that later
item, after several genuine earlier items.

Confirmed real item loss:

- **Ramires** (approved): detected start = line 27 (`"Preco: 8,00/Uni"`,
  an annotation for the row at line 24-26). This excludes TWO real items
  before it — `"1 Uni Frango"` (price 16,00, line 20) and `"1 Uni 1/2
  Frango"` (price 8,00, line 26) — both genuinely printed, real items,
  both lost.
- **Quebra Mar** (approved): detected start = line 56 (also a `"Preco:
  .../uni"` annotation line), excluding roughly two dozen real item-row
  decimal values printed earlier in the receipt.

Per this round's own stated condition ("se alguma aprovada perder um item,
não implementes"), this was not implemented; the code was written,
measured, and then reverted out of `columns.ts` rather than left in
unused.

## What would need to change before trying a third attempt

The annotation-line false positive in attempt 2 suggests the signal needs
to distinguish "a text line that is itself an item's OWN name" from "a
text line that is an ANNOTATION of a nearby value" (the `"Preco:"` prefix
is exactly this — already a recognized, excluded shape elsewhere in this
codebase, in `columns.test.ts`'s own AB rule). A third attempt would need
to exclude known-annotation-shaped lines from being a valid anchor for the
adjacency signal, not just from being a line-price candidate. Not
attempted this round — the two-attempt budget in FIX 37 was spent.

## V&RO's own `Time: 15.19` — registered as a known, documented gap

Both attempts correctly identified that this needs a POSITIONAL exclusion,
never a shape-based one (a date/time string has the exact same shape as a
real price). Neither attempt is safe to ship, so the gap stays open: `15.19`
still enters the ledger today. This does not change V&RO's own overall
classification — it was already blocked, for separate, larger, unrelated
reasons documented in FIX 36 (ten flavor items at 0.00, a rounding line,
several split charges).
