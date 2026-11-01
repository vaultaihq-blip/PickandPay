import { Session, SessionParticipant, SplitResult } from "@/types";
import { toCents, fromCents } from "./validator";

// ─── Main Split Calculator ─────────────────────────────────────────────────────

export function calculateSplit(session: Session): Map<string, SplitResult> {
  const results = new Map<string, SplitResult>();
  // Accumulate all money in integer cents to avoid floating-point drift
  const totalCentsMap = new Map<string, number>();
  const globalCentsCentsMap = new Map<string, number>();
  const tipCentsMap = new Map<string, number>();

  const { receipt, participants } = session;
  if (!receipt) return results;
  const totalParticipants = participants.length;

  for (const participant of participants) {
    results.set(participant.userId, {
      userId: participant.userId,
      amount: 0,
      itemBreakdown: [],
      globalCostsShare: 0,
      tipShare: 0,
    });
    totalCentsMap.set(participant.userId, 0);
    globalCentsCentsMap.set(participant.userId, 0);
    tipCentsMap.set(participant.userId, 0);
  }

  const allItems = [
    ...receipt.categories.starters,
    ...receipt.categories.mains,
    ...receipt.categories.drinks,
    ...receipt.categories.desserts,
    ...receipt.categories.others,
  ];

  // ── 1. Items — iterate per item so remainders distribute exactly ───────────
  for (const item of allItems) {
    const addonCents = (item.addOns ?? []).reduce(
      (s, a) => s + toCents(a.totalPrice),
      0
    );
    const itemTotalCents = toCents(item.totalPrice) + addonCents;
    const itemTotalFloat = fromCents(itemTotalCents);

    if (item.type === "shareable") {
      // Shareable: each selector uses their explicit sharedWith list
      for (const participant of participants) {
        const sel = participant.selections.find((s) => s.itemId === item.id);
        if (!sel) continue;
        const count = Math.max(sel.sharedWith?.length ?? 1, 1);
        const amt = Math.round(itemTotalCents / count);
        results.get(participant.userId)!.itemBreakdown.push({
          itemId: item.id,
          itemName: item.name,
          amount: fromCents(amt),
          itemTotal: itemTotalFloat,
          splitCount: count,
        });
        totalCentsMap.set(
          participant.userId,
          (totalCentsMap.get(participant.userId) ?? 0) + amt
        );
      }
    } else {
      const selectors = participants.filter((p) =>
        p.selections.some((s) => s.itemId === item.id)
      );
      if (selectors.length === 0) continue;

      if (item.type === "quantity" || item.quantity > 1) {
        // Proportional split: each person pays based on how many units they selected.
        // Multiple people may select the same units (sharing); cost distributes by weight.
        const totalSelected = selectors.reduce((sum, p) => {
          const sel = p.selections.find((s) => s.itemId === item.id)!;
          return sum + (sel.quantity ?? 1);
        }, 0);

        // Largest-remainder method: floor each share, then award remaining cents
        // to those with the largest fractional parts.
        const exactShares = selectors.map((p) => {
          const sel = p.selections.find((s) => s.itemId === item.id)!;
          return ((sel.quantity ?? 1) / totalSelected) * itemTotalCents;
        });
        const floors = exactShares.map(Math.floor);
        let rem = itemTotalCents - floors.reduce((a, b) => a + b, 0);
        const order = exactShares
          .map((e, i) => [i, e - floors[i]] as [number, number])
          .sort((a, b) => b[1] - a[1]);
        for (const [idx] of order) {
          if (rem <= 0) break;
          floors[idx] += 1;
          rem -= 1;
        }

        // R2-2 (01-11-2026): splitCount used to be the units picked, so one
        // person with both Wisky Sours read "÷2 of 2200". Each person's own
        // units are kept instead ("2 × 1.100,00"); "÷N" (people) only when
        // more units were picked than the item has, i.e. really shared.
        const itemUnits = Math.max(item.quantity ?? 1, 1);
        const shared = totalSelected > itemUnits;
        const unitPrice = fromCents(Math.round(itemTotalCents / itemUnits));
        selectors.forEach((participant, idx) => {
          const amt = floors[idx];
          const sel = participant.selections.find((s) => s.itemId === item.id)!;
          results.get(participant.userId)!.itemBreakdown.push({
            itemId: item.id,
            itemName: item.name,
            amount: fromCents(amt),
            itemTotal: itemTotalFloat,
            splitCount: shared ? selectors.length : 1,
            ...(shared ? {} : { units: sel.quantity ?? 1, unitPrice }),
          });
          totalCentsMap.set(
            participant.userId,
            (totalCentsMap.get(participant.userId) ?? 0) + amt
          );
        });
      } else {
        // Single-unit item: split equally among all who selected it
        const count = selectors.length;
        const perCents = Math.floor(itemTotalCents / count);
        const remainder = itemTotalCents - perCents * count;

        selectors.forEach((participant, idx) => {
          const amt = perCents + (idx < remainder ? 1 : 0);
          results.get(participant.userId)!.itemBreakdown.push({
            itemId: item.id,
            itemName: item.name,
            amount: fromCents(amt),
            itemTotal: itemTotalFloat,
            splitCount: count,
          });
          totalCentsMap.set(
            participant.userId,
            (totalCentsMap.get(participant.userId) ?? 0) + amt
          );
        });
      }
    }
  }

  // ── 2. Global costs — equal split, exact remainder distribution ────────────
  //      R2: a charge (or discount) with no line of its own is split in
  //      proportion to what each person picked instead, by the same
  //      largest-remainder method, so the parts still add up to the cent.
  if (totalParticipants > 0) {
    const itemCents = new Map(totalCentsMap);
    const pickedCents = participants.reduce((s, p) => s + (itemCents.get(p.userId) ?? 0), 0);
    for (const cost of receipt.globalCosts) {
      const costCents = toCents(cost.amount);
      let shares: number[];
      if (cost.split === "proportional" && pickedCents > 0) {
        const sign = costCents < 0 ? -1 : 1;
        const abs = Math.abs(costCents);
        const exact = participants.map((p) => (abs * (itemCents.get(p.userId) ?? 0)) / pickedCents);
        const floors = exact.map(Math.floor);
        let rem = abs - floors.reduce((a, b) => a + b, 0);
        const order = exact
          .map((e, i) => [i, e - floors[i]] as [number, number])
          .sort((a, b) => b[1] - a[1]);
        for (const [idx] of order) {
          if (rem <= 0) break;
          floors[idx] += 1;
          rem -= 1;
        }
        shares = floors.map((f) => sign * f);
      } else {
        const perCents = Math.floor(costCents / totalParticipants);
        const remainder = costCents - perCents * totalParticipants;
        shares = participants.map((_, i) => perCents + (i < remainder ? 1 : 0));
      }

      participants.forEach((p, i) => {
        const share = shares[i];
        globalCentsCentsMap.set(
          p.userId,
          (globalCentsCentsMap.get(p.userId) ?? 0) + share
        );
        totalCentsMap.set(
          p.userId,
          (totalCentsMap.get(p.userId) ?? 0) + share
        );
        if (share !== 0) {
          const r = results.get(p.userId)!;
          (r.costBreakdown ??= []).push({ costId: cost.id, name: cost.name, amount: fromCents(share) });
        }
      });
    }

    // ── 3. Tip — percentage-of-consumption OR equal split OR per-person ────
    if (receipt.tipMode === "individual") {
      // Each participant has their own tipContribution
      participants.forEach((p) => {
        const contribution = p.tipContribution ?? 0;
        if (contribution > 0) {
          const share = toCents(contribution);
          tipCentsMap.set(p.userId, (tipCentsMap.get(p.userId) ?? 0) + share);
          totalCentsMap.set(p.userId, (totalCentsMap.get(p.userId) ?? 0) + share);
        }
      });
    } else if (receipt.tipPercentage && receipt.tipPercentage > 0) {
      // Equal mode with percentage: each person pays tipPercentage% of their own items
      participants.forEach((p) => {
        const itemsCents = totalCentsMap.get(p.userId) ?? 0;
        // Subtract global costs (already added) to get pure item cents
        const globalCentsSoFar = globalCentsCentsMap.get(p.userId) ?? 0;
        const pureItemCents = itemsCents - globalCentsSoFar;
        const share = Math.round(pureItemCents * (receipt.tipPercentage! / 100));
        if (share > 0) {
          tipCentsMap.set(p.userId, (tipCentsMap.get(p.userId) ?? 0) + share);
          totalCentsMap.set(p.userId, (totalCentsMap.get(p.userId) ?? 0) + share);
        }
      });
    } else if (receipt.selectedTip && receipt.selectedTip > 0) {
      // Fallback: divide total tip equally (e.g. custom amount tip with no percentage)
      const tipCents = toCents(receipt.selectedTip);
      const perCents = Math.floor(tipCents / totalParticipants);
      const remainder = tipCents - perCents * totalParticipants;

      participants.forEach((p, i) => {
        const share = perCents + (i < remainder ? 1 : 0);
        tipCentsMap.set(
          p.userId,
          (tipCentsMap.get(p.userId) ?? 0) + share
        );
        totalCentsMap.set(
          p.userId,
          (totalCentsMap.get(p.userId) ?? 0) + share
        );
      });
    }
  }

  // ── 4. Rounding adjustment stored on the session (B.2): the chosen person
  //      pays the leftover cents, so the shares add up to the bill exactly
  //      and every device that has the same session data shows the same split.
  const adjustment = session.centAdjustment;
  if (adjustment && totalCentsMap.has(adjustment.assignedTo)) {
    totalCentsMap.set(
      adjustment.assignedTo,
      (totalCentsMap.get(adjustment.assignedTo) ?? 0) + toCents(adjustment.amount)
    );
  }

  // ── 5. Convert cent accumulators to display amounts ────────────────────────
  for (const [userId, result] of results) {
    result.amount = fromCents(totalCentsMap.get(userId) ?? 0);
    result.globalCostsShare = fromCents(globalCentsCentsMap.get(userId) ?? 0);
    result.tipShare = fromCents(tipCentsMap.get(userId) ?? 0);
  }

  return results;
}

// ─── Cent Adjustment ──────────────────────────────────────────────────────────

export interface CentAdjustmentSuggestion {
  totalComputed: number;
  totalReceipt: number;
  difference: number;
  suggestedAssignee: string;
  method: "creator" | "highest";
}

export function computeCentAdjustment(
  splitResults: Map<string, SplitResult>,
  receiptTotal: number,
  creatorId: string
): CentAdjustmentSuggestion {
  let totalComputed = 0;
  let highestUserId = creatorId;
  let highestAmount = 0;

  for (const [userId, result] of splitResults) {
    totalComputed += result.amount;
    if (result.amount > highestAmount) {
      highestAmount = result.amount;
      highestUserId = userId;
    }
  }

  totalComputed = Math.round(totalComputed * 100) / 100;
  const difference = Math.round((receiptTotal - totalComputed) * 100) / 100;

  return {
    totalComputed,
    totalReceipt: receiptTotal,
    difference,
    suggestedAssignee: highestUserId,
    method: "highest",
  };
}

// ─── Simple Split (equal division) ────────────────────────────────────────────

export function calculateEqualSplit(
  total: number,
  participantCount: number
): number[] {
  if (participantCount === 0) return [];
  const perPersonCents = Math.floor(toCents(total) / participantCount);
  const remainder = toCents(total) - perPersonCents * participantCount;
  return Array.from({ length: participantCount }, (_, i) =>
    fromCents(perPersonCents + (i < remainder ? 1 : 0))
  );
}
