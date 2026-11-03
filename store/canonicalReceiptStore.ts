import { explainedOrphanIds } from "@/lib/receipt/orphans";
import { create } from "zustand";
import {
  type CanonicalReceipt,
  type CorrectionProposal,
  type ReceiptEdit,
  applyEdits,
  applyProposal,
} from "@/lib/receipt";

/**
 * Holds the canonical receipt for the review / correction flow.
 *
 * Kept separate from `receiptStore` so the reconciliation model is never
 * mutated by legacy screens: those keep working against the projected
 * `ParsedReceipt`, while correction happens here against the exact model.
 *
 * Every mutation re-runs reconciliation and diagnosis, so `receipt.validation`
 * is always current and the UI can react immediately after each edit.
 */
interface CanonicalReceiptState {
  receipt: CanonicalReceipt | null;
  /** Issue ids the user chose to ignore; hidden without being deleted. */
  dismissedIssueIds: string[];

  setReceipt: (receipt: CanonicalReceipt | null) => void;
  applyReceiptEdits: (edits: readonly ReceiptEdit[]) => void;
  acceptProposal: (proposal: CorrectionProposal) => void;
  dismissIssue: (issueId: string) => void;
  clear: () => void;
}

export const useCanonicalReceiptStore = create<CanonicalReceiptState>((set, get) => ({
  receipt: null,
  dismissedIssueIds: [],

  setReceipt: (receipt) => set({ receipt, dismissedIssueIds: [] }),

  applyReceiptEdits: (edits) => {
    const current = get().receipt;
    if (current === null) return;
    // Issue ids are regenerated on each analysis, so previously dismissed ids
    // no longer apply once the receipt changes.
    set({ receipt: applyEdits(current, edits), dismissedIssueIds: [] });
  },

  acceptProposal: (proposal) => {
    const current = get().receipt;
    if (current === null) return;
    set({ receipt: applyProposal(current, proposal), dismissedIssueIds: [] });
  },

  dismissIssue: (issueId) =>
    set((state) => ({
      dismissedIssueIds: state.dismissedIssueIds.includes(issueId)
        ? state.dismissedIssueIds
        : [...state.dismissedIssueIds, issueId],
    })),

  clear: () => set({ receipt: null, dismissedIssueIds: [] }),
}));

/** Issues the user has not dismissed, highest ranked first. */
export function visibleIssues(state: CanonicalReceiptState) {
  const receipt = state.receipt;
  if (receipt === null) return [];
  // AV-1: an orphan-price issue about an explained value (no decimals, VAT
  // breakdown — lib/receipt/orphans.ts) is not shown.
  const explained = explainedOrphanIds(receipt);
  const explainedTexts = new Set(
    receipt.unresolvedMonetaryLines.filter((l) => explained.has(l.id) && l.text !== undefined).map((l) => l.text as string)
  );
  return receipt.validation.issues.filter(
    (issue) =>
      !state.dismissedIssueIds.includes(issue.id) &&
      !(issue.type === "orphan_price" && issue.sourceLine !== undefined && explainedTexts.has(issue.sourceLine))
  );
}
