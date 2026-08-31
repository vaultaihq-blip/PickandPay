# Receipt pipeline

Structural parsing, deterministic reconciliation, error localisation and
targeted correction for scanned receipts.

## Why this exists

The previous pipeline asked the vision model to both read the receipt *and*
report whether its own reading was valid. The client then compared the model's
`computedTotal` against the model's `receiptTotal` — two numbers the model had
authored itself. They always agreed, so a receipt whose items were short by
€8.25 still rendered a green "totals match" banner.

Paid modifiers made it worse: the item sum used by the review gate never
included add-ons, so every priced extra silently vanished from the bill.

This pipeline removes both failure modes:

- The model is a **reader**, never a calculator. It reports printed values and
  structure; it is never asked for a total or a verdict.
- Every derived amount is recomputed here, in **integer minor units**.
- A receipt that cannot be checked is `unverifiable`, never `reconciled`.

## Flow

```
raw model JSON
  → normalizeRawReceipt()   structure + exact money, no trusted arithmetic
  → analyzeReceipt()        reconcile, then diagnose if it does not balance
  → [user correction]       applyEdits() / applyProposal() → re-analyzed
  → toParsedReceipt()       projection onto the legacy shape for old screens
```

## Modules

| Module           | Responsibility                                                |
| ---------------- | ------------------------------------------------------------- |
| `money.ts`       | Exact arithmetic in minor units; parsing; currency metadata    |
| `model.ts`       | Canonical types: items, modifiers, charges, issues, evidence   |
| `normalizer.ts`  | Raw model JSON → canonical model; recomputes every total       |
| `reconciler.ts`  | Calculated vs printed; produces the validation status          |
| `diagnostics.ts` | Delta matching and error localisation; ranked issues           |
| `correction.ts`  | Applies user edits and revalidates                             |
| `adapter.ts`     | Bridge to and from the legacy `ParsedReceipt`                  |

## Validation statuses

| Status         | Meaning                                                       |
| -------------- | ------------------------------------------------------------- |
| `reconciled`   | Every printed anchor matches and no money is unattributed      |
| `needs_review` | An anchor disagrees, or a priced line was never attributed     |
| `unverifiable` | The receipt printed nothing to reconcile against               |

`unverifiable` is deliberately distinct from `reconciled`. A receipt with no
printed subtotal has not been verified and must not render as success.

Tolerance is **zero** by default. All arithmetic upstream is exact, so genuine
rounding error cannot occur — any non-zero delta is a real discrepancy the user
should see. `CURRENCY_TOLERANCE_MINOR` exists only for jurisdictions that print
cash-rounded totals.

## Diagnostics

When reconciliation fails, `diagnoseReceipt` searches for the smallest
correction that explains the delta:

1. An unattributed priced line, alone or in a small subset
2. A paid modifier whose price could not be read
3. A duplicated line, when we counted too much
4. A misread quantity — the delta is a multiple of a unit price
5. A misread price — preferring single-digit OCR confusions
6. A whole missing item

Candidates are ranked by arithmetic fit, then penalised for weak structure and
large corrections. If nothing fits, the result is an honest `unclassified`
issue with low confidence — never a confident wrong guess.

A proposal is only attached at `medium` confidence or above, and is **never**
applied without an explicit user action.

## Unresolved monetary lines

Every priced line must end up as an item, a modifier, a charge, a printed total
field, or an entry in `unresolvedMonetaryLines`. A priced line is never
silently dropped. Unattributed money forces `needs_review` even when the
subtotal happens to agree, because the parse is incomplete.

## Tests

```
npm run test:receipt
```

58 regression tests covering multiline items, free and paid modifiers,
quantities, duplicates, discounts, tax, service, tips, EUR comma decimals,
JPY zero-decimal amounts, orphan lines, each diagnosis type, the iterative
correction flow, and the Toronto receipt fixture.

> The suite runs on `tsx`, which is **not** currently in `devDependencies` —
> `npm run test:receipt` will use whatever `tsx` is resolvable. Adding
> `tsx` (or a full test runner) to `devDependencies` is a maintainer decision
> and was deliberately left out of this change.

## Adding a currency

Add the ISO code to `SUPPORTED_CURRENCIES` in `money.ts`. Zero-decimal
currencies also go in `ZERO_DECIMAL_CURRENCIES`. Ambiguous symbols are
deliberately **not** auto-resolved: `"$"` returns `null` rather than guessing
between USD and CAD, because a wrong guess silently corrupts every amount on
the receipt. The receipt is flagged `currencyAssumed` so the UI can ask.
