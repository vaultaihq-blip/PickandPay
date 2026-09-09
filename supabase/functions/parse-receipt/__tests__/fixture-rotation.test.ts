/**
 * Structural proof against the real golden fixture
 * (__fixtures__/vision-pai-toronto-rotated.json) — a genuine Google Vision
 * DOCUMENT_TEXT_DETECTION response for a receipt photographed with EXIF
 * Orientation 6 (rotated 90°). This is the fixture that caught the original
 * bug: raw pixel-coordinate clustering merged the entire price column into
 * one fake line and every item name into others.
 *
 * These tests never synthesize rotated geometry by hand — per the fix
 * spec, only a real captured response counts as proof for the rotation
 * case itself. They also never call GPT: everything here is deterministic
 * (OCR normalization + the monetary ledger), which is exactly the layer
 * this fix touches. The keyword-based subtotal/service/tax/total
 * classification below exists ONLY in this test, to prove the deterministic
 * layers restored correct structure — it is not, and must not become,
 * production classification logic (that stays GPT's job, validated
 * afterward by validate.ts).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, assert, assertEqual } from "./harness";
import { normalizeVisionResponse, resetWordIdCounterForTests } from "../ocr";
import { buildLedgerFromOcr, resetAmountIdCounterForTests } from "../ledger";
import { reconcile } from "../reconcile";
import { computeGeometricOwnership, type PriceBlockInput } from "../ownership";
import type { RawPayload } from "../types";

const FIXTURE_PATH = join(
  process.cwd(),
  "supabase/functions/parse-receipt/__fixtures__/vision-pai-toronto-rotated.json"
);

function loadFixtureResult() {
  const raw = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"));
  resetWordIdCounterForTests();
  const ocr = normalizeVisionResponse(raw);
  resetAmountIdCounterForTests();
  const ledger = buildLedgerFromOcr(ocr.lines);
  return { ocr, ledger };
}

describe("fixture (real, rotated receipt): structural reconstruction", () => {
  it("never collapses the receipt into one line of names and one line of prices", () => {
    const { ocr } = loadFixtureResult();
    const priceShapedTokenCount = (text: string) => (text.match(/\d[.,]\d{2}/g) ?? []).length;
    const maxPricesOnOneLine = Math.max(...ocr.lines.map((l) => priceShapedTokenCount(l.text)));
    assert(
      maxPricesOnOneLine <= 2,
      `expected no line to accumulate more than a couple of prices; found a line with ${maxPricesOnOneLine}`
    );
    assert(ocr.lines.length > 20, "a real ~50-line receipt must not collapse into a handful of giant lines");
  });

  it("keeps 'Khao Soi' adjacent to its own price, for both occurrences on the receipt", () => {
    const { ocr } = loadFixtureResult();
    const khaoSoiLines = ocr.lines.filter((l) => l.text.includes("Khao") && l.text.includes("Soi"));
    assertEqual(khaoSoiLines.length, 2, "this receipt has two separate Khao Soi occurrences");
    for (const line of khaoSoiLines) {
      assert(line.text.includes("23.75"), `expected "${line.text}" to contain its own price 23.75`);
    }
  });

  it("keeps every printed summary label adjacent to its own value", () => {
    const { ocr } = loadFixtureResult();
    const findLine = (re: RegExp) => ocr.lines.find((l) => re.test(l.text));
    const subtotal = findLine(/subtotal/i);
    const tax = findLine(/\btax\b/i);
    const total = findLine(/\btotal\b/i);
    assert(subtotal !== undefined && subtotal.text.includes("374.25"), "Subtotal must be adjacent to 374.25");
    assert(tax !== undefined && tax.text.includes("57.42"), "Tax must be adjacent to 57.42");
    assert(total !== undefined && total.text.includes("499.03"), "Total must be adjacent to 499.03");
  });

  it("the two-column 'BTL Campo Viejo Tempranillo' line stays a single occurrence worth 48, never inflated by the adjacent '4 Glasses' modifier", () => {
    const { ledger } = loadFixtureResult();
    const bottleEntries = ledger.filter((e) => e.rawText === "48.00");
    assertEqual(bottleEntries.length, 2, "two bottles were ordered, each its own ledger occurrence");
    for (const entry of bottleEntries) {
      assertEqual(entry.value, 48, "each bottle's ledger value must be 48, never 192 (48 x 4 glasses)");
    }
  });

  it("does not let the '18.00%' service rate enter the ledger", () => {
    const { ledger } = loadFixtureResult();
    assert(!ledger.some((e) => e.value === 18), "18.00 is the service rate's percentage, not a monetary amount");
  });
});

describe("fixture (real, rotated receipt): arithmetic invariant", () => {
  // Test-only classification, shared by both tests below: real printed
  // prices on this receipt are always written with a decimal separator
  // (".XX"); the handful of bare integers that also enter the ledger (a
  // postal code fragment, a table number, a guest count, a registration
  // number, a bare quantity line) never carry one. This is a
  // receipt-agnostic distinction, not a hardcoded merchant/item assumption.
  function classify(ocrLines: ReturnType<typeof loadFixtureResult>["ocr"]["lines"], ledger: ReturnType<typeof loadFixtureResult>["ledger"]) {
    const decimalEntries = ledger.filter((e) => /[.,]\d{2}$/.test(e.rawText));
    const integerEntries = ledger.filter((e) => !/[.,]\d{2}$/.test(e.rawText));

    let subtotal: number | null = null;
    let service: number | null = null;
    let tax: number | null = null;
    let total: number | null = null;
    const itemValues: number[] = [];

    for (const entry of decimalEntries) {
      const lineText = ocrLines[entry.lineIndex]?.text ?? "";
      if (/subtotal/i.test(lineText)) subtotal = entry.value;
      else if (/service/i.test(lineText)) service = entry.value;
      else if (/\btax\b/i.test(lineText)) tax = entry.value;
      else if (/\btotal\b/i.test(lineText)) total = entry.value;
      else itemValues.push(entry.value);
    }

    return { subtotal, service, tax, total, itemValues, integerEntries };
  }

  it("sum(items) + service + tax equals the printed total (property of the receipt data itself)", () => {
    const { ocr, ledger } = loadFixtureResult();
    const { subtotal, service, tax, total, itemValues } = classify(ocr.lines, ledger);
    assert(subtotal !== null && service !== null && tax !== null && total !== null, "all four summary values must be found");

    const itemSum = Math.round(itemValues.reduce((s, v) => s + v, 0) * 100) / 100;
    assertEqual(itemSum, subtotal, "item prices must sum to exactly the printed subtotal");

    const reconstructedTotal = Math.round((itemSum + (service ?? 0) + (tax ?? 0)) * 100) / 100;
    assertEqual(reconstructedTotal, total, "subtotal + service + tax must equal exactly the printed total");
  });

  it("the REAL reconcile() function accepts this receipt, including its real unresolved noise — this is the check that previously passed in a reimplementation while the actual pipeline failed", () => {
    const { ocr, ledger } = loadFixtureResult();
    const { subtotal, total, itemValues, integerEntries } = classify(ocr.lines, ledger);
    assert(subtotal !== null, "subtotal must be found");

    const payload: RawPayload = {
      currency: "CAD",
      items: itemValues.map((value, i) => ({ id: `item${i}`, name: `item${i}`, quantity: 1, unitPrice: value })),
      printedSubtotal: subtotal,
      printedTotal: total,
      // The real bare-integer noise this fixture actually produces (table
      // number, guest count, postal-code fragment, etc.) — not fabricated.
      unresolvedLines: integerEntries.map((e) => ({ id: `orphan_${e.amountId}`, amount: e.value, text: e.rawText, lineIndex: e.lineIndex })),
    };

    const result = reconcile(payload);
    assertEqual(result.reconciles, true, "perfect item-sum arithmetic must reconcile despite this receipt's real unresolved noise");
    assertEqual(result.subtotalDeltaMinor, 0);
    assert(result.unresolvedCount > 0, "the real noise must still be reported, just not folded into reconciles");
  });
});

describe("fixture (real, rotated receipt): geometric ownership — the test that matters most", () => {
  // Deterministic, no network call. Proves the tail region that every one
  // of three live GPT runs got wrong (Garlic Shrimp landing at 0, Pad See
  // Ew/Lowry/Gai Satay shifted differently each run) is now resolved
  // correctly by geometry alone. Block lineIndices here reflect what
  // structural grouping should report for this receipt (this test is about
  // ownership, not grouping) — matching the actual reconstructed lines from
  // the real fixture, not fabricated.
  it("resolves Garlic Shrimp, Pad See Ew, Lowry, and Gai Satay to their real, distinct prices", () => {
    const { ocr, ledger } = loadFixtureResult();

    const blocks: PriceBlockInput[] = [
      { blockId: "garlicShrimp", kind: "item", lineIndices: [38], name: "Garlic Shrimp", proposedAmountId: null },
      { blockId: "padSeeEw", kind: "item", lineIndices: [39], name: "Pad See Ew", proposedAmountId: null },
      { blockId: "lowry", kind: "item", lineIndices: [43], name: "Lowry", proposedAmountId: null },
      { blockId: "gaiSatay", kind: "item", lineIndices: [44], name: "Gai Satay", proposedAmountId: null },
    ];

    const results = computeGeometricOwnership(blocks, ledger, ocr.lines);
    const valueOf = (blockId: string) => {
      const amountId = results.find((r) => r.blockId === blockId)?.amountId;
      return amountId ? ledger.find((e) => e.amountId === amountId)?.value : null;
    };

    assertEqual(valueOf("garlicShrimp"), 17, "Garlic Shrimp got 0 in all three live runs — must resolve to 17.00 here");
    assertEqual(valueOf("padSeeEw"), 24.25);
    assertEqual(valueOf("lowry"), 15);
    assertEqual(valueOf("gaiSatay"), 20);

    const sum = [valueOf("garlicShrimp"), valueOf("padSeeEw"), valueOf("lowry"), valueOf("gaiSatay")].reduce(
      (s, v) => s + (v ?? 0),
      0
    );
    assertEqual(sum, 76.25, "17 + 24.25 + 15 + 20 must sum exactly");
  });

  it("also resolves the two 'BTL Campo Viejo Tempranillo' bottles, each split from its price by an intervening '4 Glasses' modifier line", () => {
    const { ocr, ledger } = loadFixtureResult();
    const blocks: PriceBlockInput[] = [
      { blockId: "btl1", kind: "item", lineIndices: [31], name: "BTL Campo Viejo Tempranillo", proposedAmountId: null },
    ];
    const results = computeGeometricOwnership(blocks, ledger, ocr.lines);
    const amountId = results.find((r) => r.blockId === "btl1")?.amountId;
    const value = amountId ? ledger.find((e) => e.amountId === amountId)?.value : null;
    assertEqual(value, 48, "must be 48, never confused with the '4' in '4 Glasses'");
  });
});

describe("fixture (real, rotated receipt): FIX 7 regression — a dropped modifier block must not corrupt a neighbour (run3 reproduction)", () => {
  // Reproduces the real run3 bug from the fixture, without any network call:
  // GPT sometimes fails to form a block for line 30 ("Add Shrimp $ 6.00"),
  // leaving that 6.00 an orphan. The pre-FIX-7 matcher pulled it into "1 BTL
  // Campo Viejo Tempranillo" (line 31) — the very next block in reading
  // order, and geometrically closer to the orphan than BTL's own real price
  // (line 33) — cascading into wrong values for Garlic Shrimp and Pad See Ew
  // too. This test builds the realistic block structure for this whole
  // region (mirroring what GPT actually reports for this receipt) MINUS the
  // "Add Shrimp" block, and proves the 6.00 stays a genuine orphan instead.
  it("leaves the dropped modifier's 6.00 unclaimed instead of pulling it into BTL Tempranillo", () => {
    const { ocr, ledger } = loadFixtureResult();

    const item = (blockId: string, lineIndex: number, name: string): PriceBlockInput => ({
      blockId,
      kind: "item",
      lineIndices: [lineIndex],
      name,
      parentBlockId: null,
      proposedAmountId: null,
    });
    const modifier = (blockId: string, lineIndex: number, parentBlockId: string): PriceBlockInput => ({
      blockId,
      kind: "modifier",
      lineIndices: [lineIndex],
      name: null,
      parentBlockId,
      proposedAmountId: null,
    });

    const blocks: PriceBlockInput[] = [
      item("wings", 11, "Thai Chicken Wings"),
      modifier("wingsMod", 13, "wings"),
      item("padGraProw", 14, "Pad Gra Prow"),
      item("padThai1", 17, "Chef Nuit Pad Thai"),
      modifier("ptShrimp", 18, "padThai1"),
      item("springRolls", 20, "Spring Rolls"),
      item("khaoSoi1", 21, "Khao Soi"),
      modifier("ksShrimp", 22, "khaoSoi1"),
      item("sleeman", 23, "Sleeman Honey Lager"),
      item("padThai2", 24, "Chef Nuit Pad Thai"),
      item("greenCurry", 27, "Green Curry"),
      modifier("gcShrimp", 28, "greenCurry"),
      // Line 30, "Add Shrimp $ 6.00", is INTENTIONALLY OMITTED — this is the
      // exact structural gap that produced the real run3 bug.
      item("btl1", 31, "BTL Campo Viejo Tempranillo"),
      item("btl2", 34, "BTL Campo Viejo Tempranillo"),
      item("khaoSoi2", 36, "Khao Soi"),
      item("garlicShrimp", 38, "Garlic Shrimp"),
      item("padSeeEw", 39, "Pad See Ew"),
      item("lowry", 43, "Lowry"),
      item("gaiSatay", 44, "Gai Satay"),
    ];

    const results = computeGeometricOwnership(blocks, ledger, ocr.lines);
    const valueOf = (blockId: string) => {
      const amountId = results.find((r) => r.blockId === blockId)?.amountId;
      return amountId ? ledger.find((e) => e.amountId === amountId)?.value : null;
    };
    const amountIdOf = (blockId: string) => results.find((r) => r.blockId === blockId)?.amountId ?? null;

    const droppedAmountId = ledger.find((e) => e.lineIndex === 30 && e.value === 6)?.amountId;
    assert(droppedAmountId !== undefined, "fixture must still contain the 6.00 Add Shrimp ledger entry");

    // The core assertion: the orphaned 6.00 must never end up claimed by
    // BTL Tempranillo (the run3 bug) or by any other block.
    assert(amountIdOf("btl1") !== droppedAmountId, "BTL Tempranillo (bottle 1) must never absorb the dropped modifier's orphaned 6.00");
    const claimedByAnyone = results.some((r) => r.amountId === droppedAmountId);
    assert(!claimedByAnyone, "the dropped modifier's 6.00 must remain a genuine, unclaimed orphan — not silently absorbed by ANY block");

    // BTL Tempranillo must either resolve correctly (48) or stay honestly
    // unresolved (null) — both are acceptable per the fix; landing on 6 is
    // the only unacceptable outcome, already checked above.
    const btl1Value = valueOf("btl1");
    assert(btl1Value === null || btl1Value === 48, `BTL Tempranillo (bottle 1) must be 48 or unresolved, never ${btl1Value}`);
    assertEqual(valueOf("btl2"), 48, "the second, same-line BTL bottle is unaffected and must still resolve to 48");

    // The tail region (already proven correct in isolation above) must not
    // regress now that it's resolved alongside the rest of the receipt and
    // the upstream structural gap.
    assertEqual(valueOf("garlicShrimp"), 17, "Garlic Shrimp must not regress under the cascade this bug used to cause");
    assertEqual(valueOf("padSeeEw"), 24.25, "Pad See Ew must not regress under the cascade this bug used to cause");
    assertEqual(valueOf("lowry"), 15);
    assertEqual(valueOf("gaiSatay"), 20);
  });
});
