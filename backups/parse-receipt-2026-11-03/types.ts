/**
 * Shapes shared across the pipeline modules. Pure TypeScript.
 *
 * RawPayload/RawItem/etc. are the PUBLIC envelope shape returned to the
 * client — unchanged from the previous pipeline, since utils/parser.ts on
 * the client already knows how to consume exactly this shape. Everything
 * upstream of buildFinalPayload() (ledger, blocks, assignments, agreement
 * states) is internal server plumbing that never crosses this boundary.
 */

export interface RawModifier {
  id?: string;
  name?: string;
  price?: unknown;
  kind?: string;
}

export interface RawItem {
  id?: string;
  name?: string;
  quantity?: unknown;
  unitPrice?: unknown;
  baseLineTotal?: unknown;
  discount?: unknown;
  modifiers?: RawModifier[];
  sourceEvidence?: { lineIndex?: number; lineText?: string };
}

export interface RawCharge {
  id?: string;
  name?: string;
  amount?: unknown;
  kind?: string;
}

export interface RawUnresolvedLine {
  id?: unknown;
  amount?: unknown;
  text?: unknown;
  lineIndex?: unknown;
  nearestItemLineIndex?: unknown;
}

export interface RawPayload {
  currency?: unknown;
  merchant?: unknown;
  items?: RawItem[];
  charges?: RawCharge[];
  unresolvedLines?: RawUnresolvedLine[];
  printedSubtotal?: unknown;
  printedServiceCharge?: unknown;
  printedTax?: unknown;
  printedTip?: unknown;
  printedDiscount?: unknown;
  printedTotal?: unknown;
  [key: string]: unknown;
}
