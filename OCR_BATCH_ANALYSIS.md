# Pick&Pay — OCR Batch Analysis Report
**200 receipts · 2 passes max · GPT-4o · Google Vision OCR**
*Generated: 2026-06-02*

---

## 1. Executive Summary

| Metric | Value |
|---|---|
| Receipts processed | 200 |
| **Accuracy (corrected metric)** | **74.0% (148/200)** |
| Failed even after 2nd pass | 52 (26%) |
| 2nd pass triggered | 68 (34%) |
| 2nd pass success rate | 16/68 = **23.5%** |
| 1st pass success rate | 132/132 = **100%** |
| Internal validation agrees | 197/200 = 98.5% |

**Key finding:** The edge function's `buildFromParsed()` correctly detects ALL failures and triggers the 2nd pass. The problem is that the 2nd pass (STRICT MODE) is only effective in 23.5% of cases — the remaining 52 failures are not fixable with the current prompt strategy.

---

## 2. Metric Correction

The batch script (`batch-ocr-test.js`) originally reported **8.5% accuracy** — a false negative caused by comparing only `itemsSum` (categories) against `printedTotal`, excluding `globalCosts` (tax, service charges, gratuity).

**Corrected metric:** `itemsSum + globalCostsSum` vs `printedTotal`, tolerance `< $0.50`

| Old metric (items only) | Corrected metric (items + costs) |
|---|---|
| OK: 17 (8.5%) | OK: 148 (74.0%) |
| ERROR: 183 (91.5%) | ERROR: 52 (26.0%) |

The corrected metric is used throughout this report and in `report.html`.

---

## 3. Pass Distribution

```
1st pass only (no retry needed):   132 receipts → ALL 132 are OK  (100%)
2nd pass triggered:                  68 receipts
  └─ 2nd pass fixed:                 16 receipts  (23.5%)
  └─ Still ERROR after 2nd pass:     52 receipts  (76.5%)
```

**Insight:** The 2nd pass is rarely effective. The STRICT MODE prompt does not significantly change GPT's output when it fundamentally cannot balance the receipt. This means improving the 2nd pass prompt or changing strategy is the highest-leverage fix.

---

## 4. Error Taxonomy

The 52 receipts that fail after 2 passes break down into 4 categories:

### Category A — Zero Items Extracted (16 receipts, 8%)

GPT extracts NO line items at all. `categories` is empty. Costs/taxes may be partially captured in `globalCosts` but `itemsSum = 0`. All 16 triggered the 2nd pass, none were fixed.

Examples:
| # | Restaurant | Printed | Computed | Diff |
|---|---|---|---|---|
| 038 | Panda Express | $164.89 | $13.89 | $151.00 |
| 118 | Kobe Japanese Steak | $158.07 | $0.00 | $158.07 |
| 159 | MITASU (MYR) | MYR 780.45 | 0 | MYR 780.45 |
| 027 | CHRIS'S HAMBURGERS | $51.82 | $4.39 | $47.43 |
| 023 | Moonstar Restaurant | $37.37 | $7.49 | $29.88 |

**Root causes:**
- Receipt uses format GPT doesn't recognise as line items (e.g., table format, non-standard layout)
- Non-English text with mixed scripts (Japanese, Malay)
- Very long multi-page receipts where Google Vision stitches awkwardly
- Thermal print degradation making text ambiguous at the item level
- Fast-food/drive-thru receipts without explicit per-item price column

**Fix strategy:** Detect zero-item result early and use a different, more aggressive extraction prompt focused solely on "list every item with a price". Currently the STRICT MODE prompt asks GPT to "re-examine each line carefully" without changing the parsing strategy.

---

### Category B — Over-Extraction (15 receipts, 7.5%)

`computed > printed` — GPT extracted MORE value than the real total. This means GPT either hallucinated items, counted subtotals as items (double-counting), or read prices from wrong columns.

Examples:
| # | Restaurant | Printed | Items | Costs | Computed | Over by |
|---|---|---|---|---|---|---|
| 043 | Unknown | $55.39 | $69.90 | $3.44 | $73.34 | +$17.95 |
| 064 | Primo Family | $32.47 | $49.50 | $2.97 | $52.47 | +$20.00 |
| 030 | RINCON MEXICANO | $30.98 | $38.95 | $2.03 | $40.98 | +$10.00 |
| 016 | HAMMOCKS | $50.29 | $59.00 | $3.29 | $62.29 | +$12.00 |
| 087 | Calagero's | $157.51 | $157.00 | $12.51 | $169.51 | +$12.00 |
| 057 | ZOCA RESTAURANT | $152.00 | $164.00 | $0.00 | $164.00 | +$12.00 |

**Root causes:**
- GPT reads a running subtotal line as an extra item
- GPT reads the "pre-tax total" and "grand total" as two separate items
- GPT treats modifier/add-on lines as separate items at full price
- Receipts with complex quantity × price formats (e.g., "2 × 14 = 28") confuse the parser

**Fix strategy:** Add a post-processing constraint: if `sum(items) > printedTotal * 1.02`, reject and retry with explicit instruction: "DO NOT include subtotals, running totals, or the total line itself as items."

---

### Category C — Under-Extraction (21 receipts, 10.5%)

`computed < printed`, items > 0 — GPT extracted some items correctly but missed others or got prices wrong (too low).

Examples:
| # | Restaurant | Printed | Computed | Missing |
|---|---|---|---|---|
| 191 | Bombay Grill House | $154.00 | $109.83 | $44.17 |
| 171 | Buca di Beppo | $109.28 | $70.77 | $38.51 |
| 113 | COLUMBUS RESTAURANT | $184.47 | $143.88 | $40.59 |
| 111 | Chelokababi | $160.07 | $150.12* | $9.95 |
| 078 | NAANCHING | $69.79 | $56.00 | $13.79 |
| 129 | KALAVERAS | $68.99 | $51.00 | $17.99 |

**Root causes:**
- Items at bottom of long receipt cut off by Google Vision page boundary
- Items grouped under a section header that GPT reads as a single item (missing the members)
- Handwritten or faded items missed entirely
- Prices with ambiguous decimal separators (e.g., European comma vs dot)
- Combo items where the combo price is different from the sum of components

**Fix strategy:**  
- Add "expected item count" hint from People Count Detected × average items/person
- Force GPT to list every text token that looks like a currency amount and justify why it's not an item
- Better Google Vision text extraction with explicit line-by-line output format

---

### Category D — AddOn Prices Not Included in totalPrice (≥2 confirmed, likely more)

`addOns` are stored as a separate field on item objects, but `totalPrice` only reflects the base price. Our metric doesn't sum addOns. Two receipts confirmed exact match:

| # | Restaurant | addOnsTotal | Diff | Match |
|---|---|---|---|---|
| 005 | GOLDEN BOWL TERIYAKI | $1.95 | $1.95 | ✓ exact |
| 050 | KICKIN KAJUN KAPOLEI | $8.00 | $8.00 | ✓ exact |

**Root cause:** The OCR schema allows `item.addOns[].price` but `buildFromParsed()` apparently does not fold addOn prices back into `item.totalPrice`. When users see the item in the app's review screen, the addOn price is invisible in the total column.

**Fix (2 locations):**
1. `buildFromParsed()` — when assembling each item, set `totalPrice = basePrice + sum(addOns[].price)`
2. OR: move addOn costs to `globalCosts` so they appear as shared costs in the UI

---

## 5. The 2nd Pass Problem

### Current behaviour
```
buildFromParsed() detects mismatch
  → STRICT MODE prompt: "Re-examine each line carefully. Mismatch: $X"
  → GPT retries with same image/text
  → Often returns the same (wrong) result
  → Even if different, may still not balance
```

### Why the 2nd pass fails 76.5% of the time
The STRICT MODE prompt tells GPT **what is wrong** (the diff) but not **how to fix it**. GPT doesn't know if the error is:
- A missed item (should add something)
- A phantom item (should remove something)
- A wrong price (should correct a number)
- A structural issue (can't be fixed with re-reading)

### Proposed 2nd pass differentiation

Instead of one generic STRICT MODE, split into 3 targeted prompts based on `buildFromParsed()` diagnosis:

```
ZERO_ITEMS → "Extract ONLY the prices. List every currency amount on this receipt 
              as a separate item. Do not group. Do not skip."

OVER (computed > printed * 1.02) → "You included items that total MORE than the 
              receipt total. You have double-counted something — likely a subtotal 
              line. Remove any line that is a running total, subtotal, or the 
              grand total itself."

UNDER (computed < printed * 0.98) → "Items are MISSING. The difference is $X. 
              Look for items in smaller font, at the bottom, or grouped under 
              section headers. Each priced item must appear separately."
```

---

## 6. Currency & Format Breakdown

| Currency | Count | OK | Error | Accuracy |
|---|---|---|---|---|
| USD | 188 | 137 | 51 | 72.9% |
| EUR | 7 | 7 | 0 | **100%** |
| GBP | 1 | 1 | 0 | 100% |
| CAD | 1 | 0 | 1 | 0% |
| INR | 2 | 1 | 1 | 50% |
| MYR | 1 | 0 | 1 | 0% |

EUR receipts have 100% accuracy. USD has the most errors — likely because US receipts use the most diverse formats (fast-food, fine dining, ethnic, buffet) and US tax is always added at the end rather than included in prices.

---

## 7. Internal Validation vs External Metric

| | Our metric: OK | Our metric: ERROR |
|---|---|---|
| `validation.status = "ok"` | 146 | **51** |
| `validation.status = "warning"` | 2 | 0 |
| `validation.status = "error"` | 0 | **1** |

**197 receipts have GPT's self-reported `validation.status = "ok"`.** Of those, 51 are actually wrong by our metric. This means:
- GPT's self-reported validation field is **unreliable** as a correctness signal
- `buildFromParsed()` uses independent math and correctly identifies failures (hence all 52 errors trigger the 2nd pass)
- The `validation` field in the JSON should not be trusted by the app or users — it reflects GPT's claim, not verified math

**The only reliable correctness signal is `buildFromParsed().valid`**, which is already used to gate the 2nd pass. This is correctly implemented.

---

## 8. Prioritised Fixes

### Priority 1 — Fix AddOn prices in totalPrice `[Easy · High impact]`

In `buildFromParsed()`, when assembling items from GPT output, fold addOn prices into `totalPrice`:

```typescript
// In buildFromParsed(), when processing each item:
const addOnsSum = (item.addOns ?? []).reduce((s, a) => s + (a.price ?? 0), 0);
item.totalPrice = (item.unitPrice ?? 0) * (item.quantity ?? 1) + addOnsSum;
```

This fixes at least 2 confirmed errors (005, 050) and likely several more in the under-extraction group.

---

### Priority 2 — Differentiated STRICT MODE prompts `[Medium · High impact]`

Replace the single STRICT MODE prompt with 3 variants based on failure type. Expected improvement: from 23.5% to ~50%+ success rate on 2nd pass.

Estimated uplift: +8 to +12 OK receipts (4–6% accuracy gain).

---

### Priority 3 — Zero-item retry with dedicated extraction prompt `[Medium · High impact]`

When `items.length === 0` after 1st pass, the 2nd pass should use a completely different prompt style focused on raw price extraction, not schema conformance. Currently the STRICT MODE prompt assumes some items were found.

Affected: 16 receipts. Even fixing 50% of these = +8 OK receipts = +4% accuracy.

---

### Priority 4 — Google Vision pre-processing for better line detection `[Hard · High impact]`

Many zero-item failures and some under-extractions likely stem from poor text extraction, not GPT limitations. Options:
- Use `DOCUMENT_TEXT_DETECTION` with `languageHints` for non-Latin scripts
- Request bounding box data from Vision and group by vertical position (reconstruct line-by-line structure)
- Pre-crop receipt to remove whitespace/background before sending to Vision

---

### Priority 5 — Remove `validation` field from public JSON output `[Easy · Hygiene]`

The `validation.status` and `validation.computedTotal` from GPT's self-assessment are unreliable (51 false "ok" in 200 receipts). Exposing this field to the app UI or users misleads them into trusting an unverified number.

Replace with `buildFromParsed()`'s actual result:
```typescript
validation: {
  receiptTotal: built.printedTotal,
  computedTotal: Math.round((itemsSum + costsSum) * 100) / 100,
  difference: Math.round(Math.abs(itemsSum + costsSum - built.printedTotal) * 100) / 100,
  status: built.valid ? "ok" : "mismatch"
}
```

---

### Priority 6 — Restore rate limit and remove batch bypass `[Required before launch]`

After batch testing, restore in `supabase/functions/parse-receipt/index.ts`:
- `RATE_LIMIT_MAX = 20` (was 250)
- Remove `BATCH_TEST_SECRET` constant and the `isBatchTest` bypass block

---

## 9. Expected Accuracy After Fixes

| Fix | Expected gain |
|---|---|
| P1: AddOn prices folded in | +2–4 receipts |
| P2: Differentiated 2nd pass | +8–12 receipts |
| P3: Zero-item dedicated prompt | +6–10 receipts |
| P4: Vision pre-processing | +4–8 receipts |
| **Total estimated** | **+20–34 receipts** |
| **New expected accuracy** | **84–91%** |

---

## 10. Sample Receipt Inventory by Error Type

### Zero-item failures (16 receipts)
014, 023, 027, 038, 039, 062, 069, 077, 116, 118, 119, 134, 159, 160, 165, 177

### Over-extraction (15 receipts)
016, 021, 028, 030, 043, 057, 064, 080, 087, 103, 106, 127, 128, 172, 193

### Under-extraction with items (21 receipts)
013, 029, 041, 047, 048, 049, 050, 051, 053, 065, 078, 091, 100, 111, 113, 129, 145, 154, 162, 171, 191

### Confirmed addOn bug
005, 050

### Near-miss (diff < $2.00) — likely fixable with prompt tuning
005, 021, 026, 040, 051, 089, 095

---

*Report based on 200 receipts from the batch OCR test (`batch-ocr-test.js`).
JSON results in: `C:\Users\ricar\Pictures\Vault AI\PickPay\Faturas\results\`
Visual report: `report.html` in same directory.*
