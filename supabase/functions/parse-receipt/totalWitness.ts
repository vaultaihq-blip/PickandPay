/**
 * FIX 31 — independent evidence for the printed grand total.
 *
 * FIX 29 tried "if the item sum already closes, nothing more can be
 * additive" and found the closure was circular: `GRAND_TOTAL` is only ever
 * assigned to a candidate whose own value already equals `itemSum +
 * charges` — the check re-derives the same fact it claims to prove. FIX 30
 * measured two sources of evidence that never touch `itemSum` at all:
 *
 *   A. a printed LABEL for the total, searched in the RAW OCR text
 *      directly — never in what the semantic pass reported (that path was
 *      abandoned in FIX 10 because the model returned `name: null` on 3 of
 *      5 receipts; the word is still in the OCR text on all of them).
 *   B. TYPOGRAPHIC emphasis — the total is usually the tallest text in the
 *      summary region, measured from the same rotation-corrected reading
 *      frame ownership.ts already uses (raw pixel height breaks outright on
 *      the rotated Portuguese fixtures).
 *
 * Measured against the eleven corpus fixtures (FIX 30's report): the label
 * resolves 10 of 11 correctly on its own (VRO is a pre-existing ledger
 * tokenization defect, not a failure of this idea — see the header note on
 * `findTotalLabelWitness` below). Typography alone is reliable in only 4-5
 * of 11 — payment-terminal boilerplate, signature/transaction codes, and
 * long item-description lines routinely render taller than the actual
 * total. Symmetric "disagreement blocks both" (as first specified) was
 * measured and rejected: it let typography's noise veto a clean, correct
 * label match on the Pai fixture (the exact receipt this whole line of
 * investigation is about) by preferring "Large Party (20.00%) $55.60"
 * (taller) over "Total $376.97". The label is empirically the more
 * reliable witness on this corpus, so it decides outright when available;
 * typography is consulted only when the label finds nothing. This is a
 * DEVIATION from the round's original symmetric design, made and reported
 * for this reason, not implemented silently.
 */

import type { OcrLine } from "./ocr.ts";
import { dominantAngle, toReadingFrame } from "./ocr.ts";
import type { LedgerEntry } from "./ledger.ts";

export interface TotalWitnessResult {
  amountId: string;
  value: number;
  /** Which witness actually decided — label wins outright when it has an
   *  answer (see this module's header for why). */
  source: "label" | "typography";
  /** Purely diagnostic — never consulted to decide anything. "disagree"
   *  means the label witness still won (typography never overrides it),
   *  but it is worth knowing how often the two would have clashed. */
  agreement: "agree" | "label_only" | "typography_only" | "disagree";
}

// ─── Witness A — printed label, in the raw OCR text ─────────────────────────
//
// Harvested from the eleven corpus fixtures' own printed text (FIX 30),
// never invented. EXCLUDE_PATTERNS are checked first and win: every one of
// them contains the substring "total" (or, for Net Amount/Umsatz, would
// otherwise collide with a total-shaped charge) while naming something that
// is provably NOT the grand total on a real receipt in this corpus.
//
// This list is AUXILIARY, never decisive on its own — see the module
// header. A receipt in an unanticipated language or format simply produces
// no label match here; TYPOGRAPHIC_WITNESS below still has a chance, and
// failing both, the caller's existing (pre-FIX-31) behavior is unchanged.
// Whoever extends this list: add the new real string you observed, with a
// comment naming the receipt it came from — never a guess at what other
// languages "probably" say.
const EXCLUDE_PATTERNS = [
  /sub[\s-]?total/i, // "Sub-total" / "Subtotal" (Buca di Beppo, Zoca, Pai) — also catches Italian "Subtotale"
  /total\s+tax/i, // "Total Tax" (Hollywood Cafe) — also catches "Total Tax Due"
  /total\s+incid/i, // "TOTAL INCIDENCIAS" (Quebra Mar, Ramires — VAT-rate table)
  /total\s+l[ií]quido/i, // "Total Liquido" (Sulbarreiro — net, not the amount paid)
  /total\s+iva\s+inclu/i, // "Total IVA Incluido X%" (Sulbarreiro — VAT breakdown)
  /total\s+items?\b/i, // "Total Items : 20" (VRO — item count, not currency)
  /net\s*(amount|umsatz)/i, // "Net Amount" (VRO), "Nettoumsatz" (Augustiner)
  // FIX 32 — added alongside the label variants below, in the same
  // proportion, per this module's own rule: no new label pattern without a
  // matching exclusion for the false positive it's most likely to invite.
  /total\s+amount\s+of\s+(tax|vat)/i, // "Total Amount of Tax" vs the new "Total Amount" label
  /zwischensumme/i, // German subtotal, vs the new "Summe" label
  /totale\s+iva/i, // Italian VAT breakdown, vs the new "Totale" label — same shape as "Total IVA Incluido"
];
const TOTAL_LABEL_PATTERNS = [
  /\btotal\b/i, // "Total", "TOTAL", "Total :", "Grand Total", "Total Due", "Total Amount", "Total a Pagar", "Valor Total", "Montante Total", "Total Factura", "Montant Total", "Total TTC", "Total à Payer", "Net Total", "Total Charge" — every ASCII variant containing the substring "total" is already covered by this one pattern; no separate entry needed per phrase.
  /\bamount\s+due\b/i,
  /\bbalance\s+due\b/i, // "Balance Due" (Buca di Beppo)
  /^bar\b/i, // "Bar 96,50" (Augustiner — this merchant's own printed total label)
  /\bamt\s+due\b/i,
  // FIX 32 — measured against all 33 saved corpus captures before adoption
  // (see the corpus report for the before/after table); none of these were
  // observed directly in this corpus, so each is a plausible variant, not a
  // confirmed one — exactly why this list stays auxiliary, never decisive,
  // and typography still covers whatever a future receipt's language this
  // list doesn't anticipate.
  /\bamount\s+payable\b/i,
  /\bpayment\s+due\b/i,
  /\bvalor\s+a\s+pagar\b/i, // Portuguese/Spanish "Valor a Pagar" — doesn't contain "total"
  /\bnet\s+[aà]\s+payer\b/i, // French "Net à Payer"
  /\bgesamtbetrag\b/i, // German
  /\bgesamtsumme\b/i, // German
  /\bzu\s+zahlen\b/i, // German "Zu Zahlen"
  /\bendbetrag\b/i, // German
  /\bsumme\b/i, // German "Summe" — excluded from "Zwischensumme" above
  /\btotale\b/i, // Italian "Totale" (word-boundary: does NOT match inside "Subtotale", already excluded above) — also covers "Importo Totale", "Totale da Pagare"
];

function classifyLabelLine(text: string): "TOTAL_LABEL" | "EXCLUDED" | "NONE" {
  for (const p of EXCLUDE_PATTERNS) if (p.test(text)) return "EXCLUDED";
  for (const p of TOTAL_LABEL_PATTERNS) if (p.test(text)) return "TOTAL_LABEL";
  return "NONE";
}

/** True when, once every monetary-shaped token is stripped out, nothing but
 *  punctuation/currency-symbol noise remains — this is what an OCR-split
 *  "Total" / (blank) / "109.28" shape (Buca di Beppo, Zoca) looks like on
 *  its value line. A neighbour like "Desconto -20,00" or "Total Liquido:
 *  7.21" is NOT bare — it carries its own complete label, and must never be
 *  silently reassigned to a different total two lines away just because it
 *  is close (this is what broke the first version of this function against
 *  a plain three-line discount block, before the sameLine-first / bare-
 *  neighbour-only rule below). */
function isBareValueLine(text: string): boolean {
  const stripped = text.replace(/-?\(?\d{1,3}(?:[.,\s]\d{3})*(?:[.,]\d{1,2})?\)?/g, "").trim();
  return /^[^a-zA-Z]*$/.test(stripped);
}

const DECIMAL_SHAPED = /[.,]\d{2}$/;

/**
 * Searches the RAW OCR text (never a block's own reported name) for a
 * total-shaped label, then a decimal-shaped value on the same line or up to
 * 2 lines away. ≤2 is a measured bound (FIX 30: 10 of 11 fixtures have the
 * label on the value's own line or within 2) — deliberately not widened to
 * reach Mad God's 3-line gap; that receipt is resolved by the typographic
 * witness instead, and widening the window raises the risk of reaching into
 * an unrelated section on some other receipt.
 *
 * Returns "AMBIGUOUS" when independent label matches disagree on the VALUE
 * (never guessed away) — never when they merely differ in distance or
 * wording for the SAME value (Augustiner's "Total 96,50" and "Bar 96,50"
 * are two agreeing matches, not two candidates).
 */
export function findTotalLabelWitness(
  lines: OcrLine[],
  ledger: LedgerEntry[],
  summaryRegionStart: number
): { amountId: string; value: number } | "AMBIGUOUS" | null {
  const summaryLines = lines.filter((l) => l.lineIndex >= summaryRegionStart);
  const lineByIndex = new Map(summaryLines.map((l) => [l.lineIndex, l]));
  const labelLines = summaryLines
    .map((l) => ({ lineIndex: l.lineIndex, text: l.text, cls: classifyLabelLine(l.text) }))
    .filter((l) => l.cls === "TOTAL_LABEL");
  const decimalEntries = ledger.filter((e) => DECIMAL_SHAPED.test(e.rawText.replace(/[()]/g, "")));

  const matches: Array<{ amountId: string; value: number; distance: number }> = [];
  for (const label of labelLines) {
    // A genuine grand-total label line carries exactly ONE monetary token —
    // a tax-rate-table row ("Total 23.00 101,00 e", Mad God's per-rate
    // breakdown) carries two and must never same-line-match; a same-line
    // match with more than one number is a different shape, not "the
    // closest of several", so it is skipped rather than guessed.
    const sameLineAll = decimalEntries.filter((e) => e.lineIndex === label.lineIndex);
    if (sameLineAll.length === 1) {
      matches.push({ amountId: sameLineAll[0].amountId, value: sameLineAll[0].value, distance: 0 });
      continue;
    }
    if (sameLineAll.length > 1) continue;

    for (const dist of [1, 2]) {
      const candidates = [label.lineIndex - dist, label.lineIndex + dist]
        .map((li) => decimalEntries.find((e) => e.lineIndex === li))
        .filter((e): e is LedgerEntry => e !== undefined)
        // A grand total is never negative — a sign check, not a magnitude
        // one. Without this, Zoca's "-12.00" (one line after "TOTAL",
        // itself a genuine comp/discount, not the total) is grabbed just
        // for being the nearest bare line, before the real 152.00 two
        // lines away is ever considered.
        .filter((e) => e.value >= 0)
        .filter((e) => {
          const l = lineByIndex.get(e.lineIndex);
          return l ? isBareValueLine(l.text) : false;
        });
      if (candidates.length > 0) {
        matches.push({ amountId: candidates[0].amountId, value: candidates[0].value, distance: dist });
        break;
      }
    }
  }

  if (matches.length === 0) return null;
  const distinctValues = new Set(matches.map((m) => Math.round(m.value * 100)));
  if (distinctValues.size > 1) return "AMBIGUOUS";
  matches.sort((a, b) => a.distance - b.distance);
  return { amountId: matches[0].amountId, value: matches[0].value };
}

// ─── Witness B — typographic emphasis ───────────────────────────────────────

function wordHeightInReadingFrame(box: LedgerEntry["boundingBox"], angle: number): number {
  const ys = box.vertices.map((v) => toReadingFrame(v.x, v.y, angle).normalY);
  return Math.max(...ys) - Math.min(...ys);
}

/**
 * The tallest line in the summary region, rotation-corrected (raw pixel
 * height breaks outright on the rotated Portuguese fixtures — words from
 * different visual columns land at the same pixel Y and get compared as if
 * they were the same row). Only the SINGLE tallest line decides; the
 * second-tallest is consulted only when the tallest carries no monetary
 * value at all (pure noise), never as a second vote that can contradict the
 * first — FIX 30 measured that "top-2, either counts" produces false
 * ambiguity (Mad God: the real total IS the tallest line, but a same-block
 * tax-table value is a close second; requiring both to agree would discard
 * a clean, correct answer for no reason).
 */
export function findTotalTypographicWitness(
  lines: OcrLine[],
  ledger: LedgerEntry[],
  summaryRegionStart: number
): { amountId: string; value: number } | null {
  const allWords = lines.flatMap((l) => l.words.map((wo) => wo.word));
  const angle = dominantAngle(allWords);
  const decimalEntries = ledger.filter((e) => DECIMAL_SHAPED.test(e.rawText.replace(/[()]/g, "")));

  const regionLines = lines.filter((l) => l.lineIndex >= summaryRegionStart);
  // Emphasis is a RELATIVE claim — with nothing to compare against, "the
  // tallest line" is a vacuous, unsupported statement, not evidence.
  if (regionLines.length < 2) return null;

  const heights = regionLines
    .map((l) => {
      const wordHeights = l.words.map((wo) => wordHeightInReadingFrame(wo.word.boundingBox, angle));
      return { lineIndex: l.lineIndex, height: wordHeights.length > 0 ? Math.max(...wordHeights) : 0 };
    })
    .sort((a, b) => b.height - a.height)
    .slice(0, 2);

  for (const h of heights) {
    const entry = decimalEntries.find((e) => e.lineIndex === h.lineIndex);
    if (entry) return { amountId: entry.amountId, value: entry.value };
  }
  return null;
}

// ─── Combined verdict ────────────────────────────────────────────────────────

/**
 * Label decides outright when it has an unambiguous answer (measured more
 * reliable — see this module's header). Typography is consulted only when
 * the label finds nothing at all; it is recorded as agreeing confirmation
 * when both happen to concur, but it never overrides a label verdict, and a
 * label/typography DISAGREEMENT never blocks the label's own answer — it is
 * simply not reported as agreement. `source` is exposed so the caller can
 * log which witness actually decided.
 */
export function resolveTotalWitness(
  lines: OcrLine[],
  ledger: LedgerEntry[],
  summaryRegionStart: number
): TotalWitnessResult | null {
  const label = findTotalLabelWitness(lines, ledger, summaryRegionStart);
  const typo = findTotalTypographicWitness(lines, ledger, summaryRegionStart);
  const labelVal = label && label !== "AMBIGUOUS" ? label : null;

  const agree = labelVal !== null && typo !== null && Math.round(labelVal.value * 100) === Math.round(typo.value * 100);
  const agreement: TotalWitnessResult["agreement"] =
    labelVal !== null && typo !== null ? (agree ? "agree" : "disagree") : labelVal !== null ? "label_only" : "typography_only";

  if (labelVal !== null) {
    return { amountId: labelVal.amountId, value: labelVal.value, source: "label", agreement };
  }
  if (typo) {
    return { amountId: typo.amountId, value: typo.value, source: "typography", agreement };
  }
  return null;
}
