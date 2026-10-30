# Archived design: summary closure arithmetic-identity engine

**Status: not implemented, not approved for implementation.** Archived 2026-09-10
during FIX 15 so the thinking isn't lost if a real invoice ever demonstrates the
need. Do not build this speculatively — only revive it against a concrete,
real-receipt failure that the simple FIX 15.1 condition (see
`coverage.ts`'s FIX 15 header and `validate.ts`'s `buildFinalPayload`) cannot
cover.

## Why this exists

FIX 15 Phase 2 explored recovering the FALSE_VALID fix's accuracy cost —
receipts where subtotal and total share one occurrence that has REAL
unclaimed decimal siblings in the summary region (a tax-rate breakdown table,
a chained sub-total structure, a discount/rounding adjustment) still get
rejected to `UNRESOLVED` under the shipped FIX 15.1 rule, even when the
siblings are legitimate, fully-explainable breakdown detail rather than a
genuine ambiguity. A general "arithmetic identity graph" was designed to
recover those cases automatically. It was NOT approved for implementation:
every worked example that motivated it (AW/Ramires-chain, BD/duplicate-value
siblings, BE/genuine-ambiguity, BA-BB/discount-rounding) was a synthetic
fixture built to exercise the mechanism, not a failure actually observed in
the 10-receipt real corpus. The team's standing bar — only ship a change that
fixes a class seen across multiple real invoices, or a critical FALSE_VALID —
was not met by the engine itself, only by the single narrow condition
extracted into FIX 15.1.

## Core idea

Separate two questions that the earlier (reverted) implementation conflated:

1. **Mathematical independence** — is a candidate arithmetic identity new
   information, or just an algebraic rearrangement of identities already
   known? (Answered with exact-rational linear algebra: canonicalize every
   found identity to a signed coefficient vector, dedupe rearrangements by
   sign-normalizing, and use Gaussian-elimination span-membership tests —
   order-independent, never used to pick "the" answer, only to detect
   redundancy within an already-admissible set.)
2. **Structural financial admissibility** — does a mathematically-valid
   identity correspond to something the receipt's actual structure supports?
   (Answered with non-arithmetic evidence: `resolveClosure` anchors, summary
   locality, block relationships, column/tabular geometry, percentage
   observations, observed negative-sign provenance, adjacency/progression
   through the summary region — explicitly never language or merchant
   hardcodes, never a magnitude/"bigger number wins" rule.)

Linear algebra proves an equation is new mathematical information. It does
NOT prove the equation describes a real financial relationship. Only
structurally-admissible identities may influence financial roles; the
mathematical layer only prunes redundancy inside that admissible set.

## Full design record

The complete design — data structures, canonical relation representation,
structural admissibility rules (S1 anchor-touching, S2 chained, S3 block
corroboration, S4 percent-adjacency exclusion, S5 negative-sign provenance,
S6 weak line-order tie-break, S7 column geometry), hypothesis generation and
comparison (`H_sum` vs. promotion hypotheses, the anchor-sign-preserved and
anchor-free-independent-support exclusion rules, the "materially different
interpretations → UNRESOLVED" comparison procedure), the
`ObservationEquivalenceClass` construction (value-duplicate grouping →
sibling-relation detection → structural precedence adjudication, with an
explicit no-clear-winner fallback that keeps observations separate rather
than guessing), and hand-verified walkthroughs against AV, AW, BD, BE, AK
(Mademoiselle), BA/BB (unsigned, correctly UNRESOLVED) and BA2/BB2 (signed,
correctly resolved) — is preserved verbatim in this session's transcript
(the two design-and-refinement turns immediately preceding FIX 15's
implementation round). Re-derive or ask to have it pulled back into a
conversation rather than re-inventing it, if a real invoice ever needs it.

## Key invariants worth keeping if this is ever revived

- **Interpretation Invariance**: a resolved (non-`UNRESOLVED`) answer must be
  the unique maximal-completeness reading across every structurally-admissible
  way of applying the evidence — never merely "the first one found," and never
  dependent on the order candidate identities were enumerated in.
- **No magnitude rule, anywhere.** Not "the bigger number is the total," not
  "the smaller adjustment wins a tie." Every directional decision must trace
  to a structural fact (sign provenance, chaining, block backing, adjacency),
  never to comparing two values' sizes.
- **Equal value is never sufficient for `ObservationEquivalenceClass`
  membership on its own** — it only triggers the investigation. `50 total` /
  `50 cash tendered` / `50 deposit` must be able to stay three distinct facts
  when structural evidence doesn't unambiguously say otherwise; ties in that
  investigation must leave every side of the tie separate (and eligible for
  `UNRESOLVED`), never force a guess.
- Complexity stays polynomial and small for a realistic summary region
  (≤15 monetary observations): bounded subset-and-sign enumeration, O(n²)
  exact-rational span tests, no combinatorial blowup risk. Re-verify this
  bound before reviving if the candidate cap or region size assumptions ever
  change.

## What shipped instead (FIX 15.1)

`buildFinalPayload` (`validate.ts`) now refuses to let one occurrence back
both the `SUBTOTAL` and `GRAND_TOTAL` roles unless every other decimal-shaped
candidate in the summary region already has a role. When it refuses, the
shared occurrence gets both roles pushed as a genuine duplicate-role claim —
caught by `findSummaryDuplicateRoles`, producing `UNRESOLVED` /
`reconciles=false`, an honest safe failure instead of a silently wrong total.
No identity graph, no equivalence classes, no hypothesis enumeration.

## FIX 15.3 postscript: the "tax table" question, answered negatively (FIX 16/17)

FIX 15.3 tried a narrower version of this same recovery — treat a losing,
block-backed summary candidate as `NON_CHARGE_INFORMATIONAL` (Quebra Mar's
VAT-rate breakdown, say) rather than `UNRESOLVED`, and separately, only
refuse a shared subtotal/total winner when a LARGER unclaimed value existed.
FIX 16 investigated whether this was safe. It was not, on two independent
grounds, both confirmed by direct, deterministic reproduction (no network,
no observed-once flakiness):

1. **The FALSE_VALID hole this reopened.** `NON_CHARGE_INFORMATIONAL` was
   assigned to a losing candidate purely because it had its own summary
   block and didn't win a closure — never because anything proved it
   informational. The exact 45.00/5.85/50.85 figures that FIX 15.1 correctly
   refuses when 5.85/50.85 arrive as bare `ledger_` orphans sail through
   completely uncontested the moment GPT's non-deterministic segmentation
   (FIX 13) happens to give them their own blocks instead — `finalReconciles
   =true`, `printedTotal=45` (wrong; the real total is 50.85). Reproduced
   deterministically as three parallel scenarios (identical evidence, only
   the block segmentation varied) in `validate.test.ts`'s BO/BP/BQ tests.
2. **The negative control proves the underlying hypothesis can't work
   generically, even without the block-backed hole.** `Question A` (can a
   tax-rate breakdown table be identified structurally — internal sum
   consistency, percentage adjacency, a base×rate=value relationship) has a
   qualified yes. `Question B` (can its values be PROVEN informational,
   rather than a real charge not yet counted) does not: a real receipt (Pai
   Northern Thai Kitchen) has a genuine, uncounted 20% surcharge
   (278.00×20%=55.60) with the IDENTICAL arithmetic shape as an
   informational VAT-rate row. No structural signal available anywhere in
   this pipeline (name, geometry, column band, magnitude) distinguishes the
   two cases. Measured geometry across the three "good" receipts was
   additionally inconsistent with itself — Quebra Mar's tax bases sit
   OUTSIDE its own items' authoritative column band (not inside, as
   initially assumed), Sulbarreiro has only 1 of 4 tax-shaped values inside
   that band (not all 4) — so column position was never going to be that
   signal either. Two of the eight sampled real base×rate→tax relationships
   also didn't survive exact-cent-rounded verification (Ramires: computed
   1.79 vs printed 1.80; Mad God: computed 23.23 vs OCR 23.20) — a reminder
   that even the "does the arithmetic match" pre-check is not perfectly
   reliable on real OCR data.

**Conclusion, treated as a result, not a gap:** there is no known generic,
merchant/language/country-independent signal that proves a block-backed,
unclosed summary value is informational rather than a real, uncounted
charge. FIX 17 Part 1 removed `NON_CHARGE_INFORMATIONAL` as a role
entirely — a losing candidate is always `UNRESOLVED` now, regardless of
whether it has its own block. Quebra Mar, Ramires, and Sulbarreiro remain
`SAFE_FAILURE` (correct total, flagged invalid) rather than reaching
`VALID`; per FIX 16's independent audit, they were already blocked upstream
by unrelated items-region coverage gaps in every sampled run regardless
(`unresolvedLoadBearingCount` 10–20, FIX 7, never touched by any FIX 15.x
work), so the exception never actually restored a single receipt to fully
valid — it only reopened a FALSE_VALID path. If a future receipt makes this
worth revisiting, question B — not question A — is where new evidence is
needed, and the Pai negative control above must be checked first, before
any implementation.

## FIX 24/25 postscript: Zoca — a real sign-inversion-shaped charge, S5 never implemented

FIX 24 investigated a real receipt (Zoca Restaurant, promoted into the
corpus that round) where a "Sales Tax" charge came out as **+12.00** when
the receipt's real comp/discount was **−12.00** — the exact FALSE_VALID
shape S5 (this document's own archived guard: "a value with a negative
sign is definitively a modifier, never a total") was designed to close.
Traced to exact code, not inferred:

1. **The sign did not invert.** The ledger entry for the real `-12.00`
   comp carries it correctly (`parseAmbiguousNumber` detects the leading
   minus exactly as designed) — verified directly against the real
   fixture's own ledger.
2. **It is two independent `12.00`-shaped print occurrences, not one value
   with a flipped sign.** This receipt's OCR line reconstruction garbles
   its summary region (labels — "Sub-total"/"Sales Tax"/"TOTAL" — end up
   detached from their true values into two separate clusters). A block
   confidently but wrongly named "Sales Tax" latches onto an unrelated
   `+12.00` sitting in that scrambled cluster; the real comp
   (correctly `-12.00`) is captured separately, by a different,
   correctly-named "ITEM COMPS" block. The root cause is the OCR/line-
   reconstruction garbling for this specific photo, not a classification
   or sign-handling defect.
3. **S5 is not implemented anywhere in code.** `resolveClosure`
   (validate.ts) has zero sign-awareness — read end to end to confirm.
   This document is the ONLY place S5 exists, as a name pointing to a
   design-session transcript not present in this codebase.
4. **Proven, not estimated, that this class CAN produce `finalReconciles
   = true` with a fabricated charge value.** A direct reproduction using
   the real `buildFinalPayload`/`reconcile`/`classifySummaryCoverage`/
   `determineSummaryValidity` functions (items correctly summing to a
   correctly-claimed printed subtotal, plus a charge block whose NAME
   matches a known pattern but whose claimed VALUE is wrong, with no
   competing unresolved value left over) produces exactly that outcome —
   the FIX 17 class, reopened through a different door than the one FIX 25
   closed (item-ownership swaps; see this codebase's `ownership.test.ts`
   FIX 25 section for the parallel proof on that door).

**Zoca itself was deliberately left untreated in FIX 25** — no known safe
minimal fix was found (the obvious approaches all reduce to guessing by
magnitude, the discipline this document and `RESIDUAL_SIGMA_MULTIPLIER`
have both consistently refused). **S5 is worth evaluating on its own
merits in a future round, independent of Zoca**: unlike a magnitude rule,
it is a deterministic claim about SIGN provenance (a candidate carrying a
verified negative sign, from `parseAmbiguousNumber`'s own parenthesis/minus
detection, is structurally never a total/subtotal candidate) — the kind of
non-magnitude, non-guessing signal this document's own invariants call
for. Whether it would have caught Zoca's specific case is a separate,
open question (the wrongly-claimed `+12.00` here is NOT itself negative —
S5 guards a different failure shape, a negative value being wrongly
treated as a total, not a positive value being wrongly treated as a
charge) and should be checked explicitly before any implementation, not
assumed.
