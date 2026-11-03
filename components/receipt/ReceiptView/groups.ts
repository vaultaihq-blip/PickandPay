// D.3 (04-11-2026) — the receipt's three groups, always in this order:
// Comidas (starters, mains, desserts), Bebidas (drinks), Outros (others).
// Inside a group, the order on the receipt: by the line's place on the photo
// when the parser sent it (R10, v61+), otherwise the order the lines came in.

export type GroupKind = "food" | "drinks" | "others";
export const GROUP_ORDER: GroupKind[] = ["food", "drinks", "others"];

export function groupKindOf(category: string | undefined): GroupKind {
  if (category === "drinks") return "drinks";
  if (category === "others") return "others";
  return "food"; // starters, mains, desserts — and anything unknown
}

type Placed = { category?: string; photoBox?: readonly [number, number, number, number] };

/** The rows in their groups (empty groups left out), each in receipt order. */
export function inGroups<T extends Placed>(rows: T[]): { kind: GroupKind; rows: T[] }[] {
  const indexed = rows.map((row, i) => ({ row, i }));
  return GROUP_ORDER.map((kind) => {
    const mine = indexed.filter(({ row }) => groupKindOf(row.category) === kind);
    const placed = mine.every(({ row }) => row.photoBox);
    mine.sort((a, b) => (placed ? a.row.photoBox![1] - b.row.photoBox![1] : 0) || a.i - b.i);
    return { kind, rows: mine.map(({ row }) => row) };
  }).filter((g) => g.rows.length > 0);
}

/** The category to store when the user picks a group in the correction panel. */
export function categoryForGroup(kind: GroupKind, current?: string): string {
  if (groupKindOf(current) === kind && current) return current;
  return kind === "drinks" ? "drinks" : kind === "others" ? "others" : "mains";
}
