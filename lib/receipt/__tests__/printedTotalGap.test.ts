import {
  answerHolds,
  printedTotalGap,
  suggestGapAnswer,
  UNLINED_COST_ID,
  withGapCost,
} from "../printedTotalGap";
import { calculateSplit } from "../../../utils/splitter";
import { assert, assertEqual, describe, it } from "./harness";

describe("R2: gap to the printed total", () => {
  it("Oligark: 6.100 of items against ₺ 6.700 printed is a 600 gap under", () => {
    const gap = printedTotalGap(6100, 0, 6700);
    assertEqual(gap.kind, "under");
    assertEqual(gap.amount, 600);
  });

  it("items plus their own charge lines that reach the total leave no gap", () => {
    assertEqual(printedTotalGap(300.25, 0, 300.25).kind, "none");
    assertEqual(printedTotalGap(90, 6.5, 96.5).kind, "none");
  });

  it("items above the total are a gap over", () => {
    const gap = printedTotalGap(105, 0, 100);
    assertEqual(gap.kind, "over");
    assertEqual(gap.amount, 5);
  });

  it("without a printed total there is no gap to report", () => {
    assertEqual(printedTotalGap(50, 0, null).kind, "none");
    assertEqual(printedTotalGap(50, 0, 0).kind, "none");
  });

  it("an answer holds only for the gap it was confirmed for", () => {
    const gap = printedTotalGap(6100, 0, 6700);
    assert(answerHolds(gap, { answer: "charge", name: "Encargo", amount: 600 }), "same gap");
    assert(!answerHolds(gap, { answer: "charge", name: "Encargo", amount: 34.5 }), "gap changed");
    assert(!answerHolds(gap, { answer: "discount", name: "Desconto", amount: 600 }), "wrong side");
    assert(!answerHolds(printedTotalGap(10, 0, 10), { answer: "charge", name: "x", amount: 0 }), "no gap");
  });
});

describe("R2: suggested answer", () => {
  it("Oligark: VAT bases reaching the printed total suggest a charge, even with the OCR misread", () => {
    const gap = printedTotalGap(6100, 0, 6700);
    // As read on 2026-11-01: 6.040,98 came out as 6.040.08; 05 and 16 are the table and the time.
    const clues = { texts: ["05", "16", "659,02", "6.040.08"], amounts: [5, 16, 659.02, 6040.08], printedTotal: 6700, itemsSum: 6100 };
    assertEqual(suggestGapAnswer(gap, clues), "charge");
  });

  it("service words suggest a charge", () => {
    const gap = printedTotalGap(50, 0, 55);
    const clues = { texts: ["Servis %10"], amounts: [], printedTotal: 55, itemsSum: 50 };
    assertEqual(suggestGapAnswer(gap, clues), "charge");
    assertEqual(suggestGapAnswer(gap, { ...clues, texts: ["Couvert"] }), "charge");
  });

  it("Augustiner's first read (a missed item, no clue) suggests nothing", () => {
    const gap = printedTotalGap(62, 0, 96.5);
    const clues = { texts: ["Nettoumsatz 86,37", "55", "304"], amounts: [86.37, 55, 304, 4.2, 11.5], printedTotal: 96.5, itemsSum: 62 };
    assertEqual(suggestGapAnswer(gap, clues), null);
  });

  it("bases that add up to the items, not the total, are no clue", () => {
    const gap = printedTotalGap(100, 0, 110);
    const clues = { texts: [], amounts: [40, 60], printedTotal: 110, itemsSum: 100 };
    assertEqual(suggestGapAnswer(gap, clues), null);
  });

  it("discount words suggest a discount when the items are over", () => {
    const gap = printedTotalGap(105, 0, 100);
    assertEqual(suggestGapAnswer(gap, { texts: ["Desconto cliente"], amounts: [], printedTotal: 100, itemsSum: 105 }), "discount");
    assertEqual(suggestGapAnswer(gap, { texts: [], amounts: [], printedTotal: 100, itemsSum: 105 }), null);
  });
});

describe("R2: the answered gap becomes a proportional charge", () => {
  it("adds one named charge, replaces it on a new answer, and drops it when unanswered", () => {
    const once = withGapCost([], { answer: "charge", name: " Serviço ", amount: 600 });
    assertEqual(once.length, 1);
    assertEqual(once[0].id, UNLINED_COST_ID);
    assertEqual(once[0].name, "Serviço");
    assertEqual(once[0].amount, 600);
    assertEqual(once[0].split, "proportional");
    const again = withGapCost(once, { answer: "charge", name: "Taxa", amount: 600 });
    assertEqual(again.length, 1);
    assertEqual(again[0].name, "Taxa");
    assertEqual(withGapCost(once, null).length, 0);
    assertEqual(withGapCost([], { answer: "discount", name: "Desconto", amount: 5 })[0].amount, -5);
  });

  const item = (id: string, total: number) => ({
    id, name: id, category: "drinks", quantity: 1, unitPrice: total, totalPrice: total, type: "individual",
  });
  const person = (userId: string, itemIds: string[]) => ({
    userId, selections: itemIds.map((itemId) => ({ itemId, quantity: 1, isShared: false, sharedWith: [] })),
  });
  const session = (costs: any[]) =>
    ({
      receipt: {
        categories: {
          starters: [], mains: [], desserts: [], others: [],
          drinks: [item("b1", 1100), item("b2", 1100), item("b3", 600), item("b4", 1100), item("b5", 1100), item("b6", 1100)],
        },
        globalCosts: costs,
        tipMode: "equal",
        selectedTip: 0,
      },
      // Oligark 30-10 19:53: 1.100 / 2.200 / 2.800.
      participants: [person("h", ["b1"]), person("p1", ["b6", "b2"]), person("p2", ["b3", "b4", "b5"])],
    }) as any;

  it("Oligark: the 600 is split 1.100/2.200/2.800 and the parts add up to ₺ 6.700", () => {
    const res = calculateSplit(session(withGapCost([], { answer: "charge", name: "Encargo", amount: 600 })));
    const amounts = ["h", "p1", "p2"].map((u) => res.get(u)!.amount);
    assertEqual(Math.round(amounts.reduce((a, b) => a + b, 0) * 100), 670000);
    // 600 × 1100/6100 = 108.196…, × 2200/6100 = 216.393…, × 2800/6100 = 275.409…
    assertEqual(res.get("h")!.amount, 1208.2);
    assertEqual(res.get("p1")!.amount, 2416.39);
    assertEqual(res.get("p2")!.amount, 3075.41);
    assertEqual(res.get("p2")!.costBreakdown?.[0].name, "Encargo");
  });

  it("a proportional discount takes the same shape, negative, to the cent", () => {
    const res = calculateSplit(session(withGapCost([], { answer: "discount", name: "Desconto", amount: 100 })));
    const total = ["h", "p1", "p2"].reduce((s, u) => s + Math.round(res.get(u)!.amount * 100), 0);
    assertEqual(total, 600000);
    assert(res.get("h")!.costBreakdown![0].amount < 0, "discount share is negative");
  });

  it("an ordinary charge is still split equally", () => {
    const res = calculateSplit(session([{ id: "svc", name: "Service", amount: 30, type: "service_charge", splitByAll: true, editable: true }]));
    assertEqual(res.get("h")!.globalCostsShare, 10);
    assertEqual(res.get("p2")!.globalCostsShare, 10);
  });
});
