// R12 — units of a receipt, the way the server counts them
// (supabase/migrations/20261102090000_r12_units_and_shares.sql, receipt_units):
// every line has `quantity` units (a whole number ≥ 1, else 1); lines with the
// same category, name and unit price are one item. Who holds which unit is
// decided by the server; each person's selections carry, per line, how many
// people hold each of their units (unitSplits).

import { ItemSelection, ReceiptItem } from "@/types";

export function lineUnits(item: Pick<ReceiptItem, "quantity">): number {
  const q = item.quantity;
  return Number.isInteger(q) && q >= 1 ? Math.min(q, 99) : 1;
}

export function unitPriceOf(item: Pick<ReceiptItem, "quantity" | "unitPrice" | "totalPrice">): number {
  return typeof item.unitPrice === "number" ? item.unitPrice : item.totalPrice / lineUnits(item);
}

/** Same item on the server: same name (case and outer spaces aside) and unit price. */
export function itemKey(item: ReceiptItem): string {
  return `${item.name.trim().toLowerCase()}|${unitPriceOf(item).toFixed(2)}`;
}

/** How much of a line's units this selection pays for: Σ 1 / holders. */
export function unitWeight(sel: Pick<ItemSelection, "quantity" | "unitSplits">): number {
  if (Array.isArray(sel.unitSplits) && sel.unitSplits.length > 0) {
    return sel.unitSplits.reduce((s, k) => s + 1 / Math.max(k, 1), 0);
  }
  return sel.quantity ?? 1;
}

export type ItemGroup =
  | { kind: "single"; item: ReceiptItem; lineIds: string[]; units: number; priceVariant: boolean }
  | { kind: "merged"; item: ReceiptItem; lineIds: string[]; units: number; priceVariant: boolean };

/** One row per item, in receipt order. priceVariant: the same name also comes at another price. */
export function groupItems(items: ReceiptItem[]): ItemGroup[] {
  const byKey = new Map<string, ReceiptItem[]>();
  const pricesByName = new Map<string, Set<string>>();
  for (const item of items) {
    const key = itemKey(item);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(item);
    const name = item.name.trim().toLowerCase();
    if (!pricesByName.has(name)) pricesByName.set(name, new Set());
    pricesByName.get(name)!.add(key);
  }
  const seen = new Set<string>();
  const out: ItemGroup[] = [];
  for (const item of items) {
    const key = itemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    const lines = byKey.get(key)!;
    const units = lines.reduce((s, l) => s + lineUnits(l), 0);
    const priceVariant = (pricesByName.get(item.name.trim().toLowerCase())?.size ?? 1) > 1;
    const lineIds = lines.map((l) => l.id);
    if (lines.length === 1) {
      out.push({ kind: "single", item, lineIds, units, priceVariant });
    } else {
      const totalPrice = Math.round(lines.reduce((s, l) => s + l.totalPrice, 0) * 100) / 100;
      out.push({ kind: "merged", item: { ...lines[0], quantity: units, totalPrice }, lineIds, units, priceVariant });
    }
  }
  return out;
}

export interface GroupHolder {
  userId: string;
  units: number;
  /** holds at least one unit together with someone else */
  shared: boolean;
}

export interface GroupState {
  units: number;
  freeUnits: number;
  myUnits: number;
  holders: GroupHolder[];
}

/** Who holds units of an item, from everyone's (derived) selections. */
export function groupState(
  lineIds: string[],
  units: number,
  people: { userId: string; selections: ItemSelection[] }[],
  myId: string | undefined
): GroupState {
  const ids = new Set(lineIds);
  let claimed = 0;
  let myUnits = 0;
  const holders: GroupHolder[] = [];
  for (const p of people) {
    let n = 0;
    let shared = false;
    for (const s of p.selections) {
      if (!ids.has(s.itemId)) continue;
      n += s.quantity ?? 1;
      claimed += Array.isArray(s.unitSplits) && s.unitSplits.length > 0
        ? s.unitSplits.reduce((a, k) => a + 1 / Math.max(k, 1), 0)
        : s.quantity ?? 1;
      if (s.unitSplits?.some((k) => k > 1)) shared = true;
    }
    if (n === 0) continue;
    if (p.userId === myId) myUnits = n;
    holders.push({ userId: p.userId, units: n, shared });
  }
  const freeUnits = Math.max(0, units - Math.round(claimed));
  return { units, freeUnits, myUnits, holders };
}

/** What this selection costs: each unit's price over the people holding it. */
export function selectionAmount(item: ReceiptItem, sel: ItemSelection): number {
  const addons = (item.addOns ?? []).reduce((s, a) => s + a.totalPrice, 0);
  return ((item.totalPrice + addons) / lineUnits(item)) * unitWeight(sel);
}

/**
 * Initials for each person, unique in the session: one letter; when two
 * people share it, two letters of the first name ("RI", "RU"); then the
 * first and last initials; then a number.
 */
export function sessionInitials(people: { userId: string; name: string }[]): Map<string, string> {
  const words = (name: string) => name.trim().split(/\s+/).filter(Boolean);
  const letters = (w: string) => Array.from(w);
  const steps: ((name: string) => string)[] = [
    (n) => (letters(words(n)[0] ?? "?")[0] ?? "?").toUpperCase(),
    (n) => letters(words(n)[0] ?? "?").slice(0, 2).join("").toUpperCase(),
    (n) => {
      const w = words(n);
      return ((letters(w[0] ?? "?")[0] ?? "?") + (w.length > 1 ? letters(w[w.length - 1])[0] : letters(w[0] ?? "?")[1] ?? "")).toUpperCase();
    },
  ];
  const out = new Map<string, string>();
  let pending = people.map((p) => p.userId);
  const nameOf = new Map(people.map((p) => [p.userId, p.name || "?"]));
  for (const step of steps) {
    const tags = new Map<string, string[]>();
    for (const id of pending) {
      const tag = step(nameOf.get(id)!);
      if (!tags.has(tag)) tags.set(tag, []);
      tags.get(tag)!.push(id);
    }
    const taken = new Set(out.values());
    const next: string[] = [];
    for (const [tag, ids] of tags) {
      if (ids.length === 1 && !taken.has(tag)) out.set(ids[0], tag);
      else next.push(...ids);
    }
    pending = next;
    if (pending.length === 0) break;
  }
  pending.forEach((id, i) => out.set(id, `${steps[0](nameOf.get(id)!)}${i + 1}`));
  return out;
}
