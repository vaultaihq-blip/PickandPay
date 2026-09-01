/**
 * Receipt parsing, reconciliation and correction pipeline.
 *
 * Pipeline order:
 *   raw model JSON
 *     -> normalizeRawReceipt   (structure + exact money, no trusted arithmetic)
 *     -> evaluateReceipt       (reconcile + diagnose)
 *     -> [user corrections]    (applyEdits / applyProposal -> re-analyzed)
 *     -> toParsedReceipt       (legacy shape for existing screens)
 */

export * from "./money";
export * from "./model";
export * from "./normalizer";
export * from "./reconciler";
export * from "./diagnostics";
export * from "./correction";
export * from "./adapter";
