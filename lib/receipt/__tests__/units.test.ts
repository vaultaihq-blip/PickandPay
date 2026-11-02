import { groupItems, groupState, lineUnits, selectionAmount, sessionInitials, unitWeight } from "../../units";
import { calculateSplit } from "../../../utils/splitter";
import { assert, assertEqual, describe, it } from "./harness";

const item = (id: string, name: string, quantity: number, unitPrice: number) => ({
  id, name, category: "drinks", quantity, unitPrice, totalPrice: unitPrice * quantity, type: "individual",
}) as any;

describe("R12: units and items", () => {
  it("a line has its quantity in units; a non-whole quantity is one unit", () => {
    assertEqual(lineUnits({ quantity: 2 }), 2);
    assertEqual(lineUnits({ quantity: 0.5 }), 1);
    assertEqual(lineUnits({ quantity: 0 }), 1);
  });

  it("two Moskow Mule lines (one with a trailing space) are one item of 2 units", () => {
    const g = groupItems([item("m1", "Moskow Mule", 1, 1100), item("m2", "Moskow Mule ", 1, 1100), item("w1", "Wisky Sour", 2, 1100)]);
    assertEqual(g.length, 2);
    assertEqual(g[0].kind, "merged");
    assertEqual(g[0].units, 2);
    assertEqual(g[0].lineIds.join(","), "m1,m2");
    assertEqual(g[1].kind, "single");
    assertEqual(g[1].units, 2);
  });

  it("the same name at another price is another item, flagged", () => {
    const g = groupItems([item("a", "Vinho", 1, 18), item("b", "Vinho", 1, 22)]);
    assertEqual(g.length, 2);
    assert(g[0].priceVariant && g[1].priceVariant, "both flagged");
  });

  it("free units come from the holders on each unit", () => {
    // A holds m1 alone; B and C share m2 (unitSplits [2] each)
    const people = [
      { userId: "a", selections: [{ itemId: "m1", quantity: 1, isShared: false, unitSplits: [1] }] },
      { userId: "b", selections: [{ itemId: "m2", quantity: 1, isShared: true, unitSplits: [2] }] },
      { userId: "c", selections: [{ itemId: "m2", quantity: 1, isShared: true, unitSplits: [2] }] },
    ];
    const s = groupState(["m1", "m2"], 2, people, "c");
    assertEqual(s.freeUnits, 0);
    assertEqual(s.myUnits, 1);
    assertEqual(s.holders.length, 3);
    assert(s.holders[1].shared && !s.holders[0].shared, "b shares, a does not");
    assertEqual(groupState(["m1", "m2"], 2, people.slice(0, 1), "a").freeUnits, 1);
  });

  it("a share of a unit costs the unit over its holders", () => {
    const m = item("m2", "Moskow Mule", 1, 1100);
    assertEqual(selectionAmount(m, { itemId: "m2", quantity: 1, isShared: true, unitSplits: [2] }), 550);
    assertEqual(unitWeight({ quantity: 2, unitSplits: [1, 3] }), 1 + 1 / 3);
    assertEqual(unitWeight({ quantity: 2 }), 2);
  });

  it("initials: one letter, two when repeated (RI / RU), unique", () => {
    const m = sessionInitials([
      { userId: "1", name: "Ricardo Costa" }, { userId: "2", name: "Rui" }, { userId: "3", name: "Ana" },
      { userId: "4", name: "Bruno" }, { userId: "5", name: "Bruna Lima" },
    ]);
    assertEqual(m.get("1"), "RI");
    assertEqual(m.get("2"), "RU");
    assertEqual(m.get("3"), "A");
    assertEqual(m.get("4"), "BR");
    assertEqual(m.get("5"), "BL");
    assertEqual(new Set(m.values()).size, 5);
  });
});

describe("R12: the split follows the units", () => {
  const receipt = (lines: any[]) => ({
    categories: { starters: [], mains: [], desserts: [], others: [], drinks: lines },
    globalCosts: [], tipMode: "equal", selectedTip: 0,
  });
  const sel = (itemId: string, quantity: number, unitSplits: number[], sharedWith: string[] = []) =>
    ({ itemId, quantity, isShared: unitSplits.some((k) => k > 1), sharedWith, unitSplits });

  it("C shares B's Moskow Mule: A 1.100, B 550, C 550", () => {
    const res = calculateSplit({
      receipt: receipt([item("m1", "Moskow Mule", 1, 1100), item("m2", "Moskow Mule", 1, 1100)]),
      participants: [
        { userId: "a", selections: [sel("m1", 1, [1])] },
        { userId: "b", selections: [sel("m2", 1, [2], ["b", "c"])] },
        { userId: "c", selections: [sel("m2", 1, [2], ["b", "c"])] },
      ],
    } as any);
    assertEqual(res.get("a")!.amount, 1100);
    assertEqual(res.get("b")!.amount, 550);
    assertEqual(res.get("c")!.amount, 550);
    assertEqual(res.get("c")!.itemBreakdown[0].sharedWith?.join(","), "b");
  });

  it("one rice shared by three: a third each, to the cent", () => {
    const res = calculateSplit({
      receipt: receipt([item("r1", "Arroz de Pato", 1, 24)]),
      participants: ["a", "b", "c"].map((u) => ({ userId: u, selections: [sel("r1", 1, [3], ["a", "b", "c"])] })),
    } as any);
    assertEqual(["a", "b", "c"].reduce((s, u) => s + Math.round(res.get(u)!.amount * 100), 0), 2400);
    assertEqual(res.get("a")!.amount, 8);
  });

  it("1 of 2 picked on a quantity-2 line pays one unit, not both", () => {
    const res = calculateSplit({
      receipt: receipt([item("w1", "Wisky Sour", 2, 1100)]),
      participants: [{ userId: "a", selections: [sel("w1", 1, [1])] }],
    } as any);
    assertEqual(res.get("a")!.amount, 1100);
    assertEqual(res.get("a")!.itemBreakdown[0].units, 1);
  });
});
