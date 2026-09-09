/**
 * TEMPORARY diagnostic tool — local/manual use only. Never deployed (lives
 * under /scripts, not supabase/functions), never committed with real
 * receipt content, never logs anything a production request would log.
 *
 * Runs the exact same OCR-grounded pipeline as supabase/functions/
 * parse-receipt/index.ts against a single local image file, and dumps every
 * intermediate structure the production pipeline computes but never logs
 * (by design — production logs are counts/timings only, never receipt
 * content). This is how we prove, rather than infer, how a specific
 * receipt's totals were constructed.
 *
 * It imports the pipeline's actual pure modules unchanged (ocr.ts,
 * ledger.ts, schema.ts, validate.ts, prompts.ts, reconcile.ts) — the only
 * things duplicated here are index.ts's small inline helpers that aren't
 * exported (callOpenAI, timed, runTargetedVerification,
 * applyVerificationResults). Keep this file in sync with index.ts by hand;
 * it is not itself part of the pipeline.
 *
 * Usage:
 *   npx tsx scripts/debug-parse-receipt.ts "C:\path\to\receipt.jpg" [output.json]
 *
 * Keys are read from .env.local (gitignored) at startup — never passed on
 * the command line, never set as a shell env var by the caller, so a key
 * value is never present in any command text, shell history, or terminal
 * scrollback this script produces. OPENAI_API_KEY/GOOGLE_CLOUD_API_KEY are
 * accepted directly too (if already exported), falling back to this repo's
 * EXPO_PUBLIC_-prefixed client names. A key's VALUE is never printed —
 * anywhere a problem is reported, only the missing key's NAME is.
 *
 * Output is written to a local JSON file (default: alongside the image,
 * "<image>.debug.json") and NOT printed to the console in full (only a
 * summary), so a terminal scrollback capture doesn't casually leak receipt
 * content either. Delete the output file when you're done with it — it is
 * gitignored-equivalent by convention (not part of the repo's tracked
 * paths) but nothing here enforces that automatically.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { extname, join } from "node:path";

/** Loads .env.local into process.env, without overwriting anything already
 *  set there. Never logs a value — only ever consulted for its presence. */
function loadEnvLocal(): void {
  const envPath = join(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key && value && !(key in process.env)) process.env[key] = value;
  }
}
loadEnvLocal();

import { callGoogleVision, normalizeVisionResponse, type OcrResult } from "../supabase/functions/parse-receipt/ocr";
import { buildLedgerFromOcr, type LedgerEntry } from "../supabase/functions/parse-receipt/ledger";
import {
  buildStructureSchema,
  describeLedgerForPrompt,
  assignmentsFromBlocks,
  computeEligibleAmountIds,
  type StructureBlock,
  type Assignment,
} from "../supabase/functions/parse-receipt/schema";
import {
  validateAssignments,
  findSuspiciousEvidence,
  findOwnershipAmbiguous,
  findReconciliationSuspects,
  buildFinalPayload,
  OCR_CONFIDENCE_THRESHOLD,
  type SuspiciousEvidence,
  type AssignmentValidation,
} from "../supabase/functions/parse-receipt/validate";
import {
  STRUCTURE_AND_ASSIGNMENT_SYSTEM_PROMPT,
  TARGETED_VERIFICATION_SYSTEM_PROMPT,
} from "../supabase/functions/parse-receipt/prompts";
import { computeGeometricOwnership, type PriceBlockInput } from "../supabase/functions/parse-receipt/ownership";
import { filterToAuthoritativeColumn } from "../supabase/functions/parse-receipt/columns";
import { reconcile, toMajor } from "../supabase/functions/parse-receipt/reconcile";

const MODEL = "gpt-4o-2024-08-06";
const OCR_LANGUAGE_HINTS = ["pt", "en", "es", "fr", "zh"];

interface OpenAIMessageContent {
  type: string;
  [key: string]: unknown;
}
type ResponseFormat = { type: "json_object" } | { type: "json_schema"; json_schema: Record<string, unknown> };

async function callOpenAI(
  apiKey: string,
  systemPrompt: string,
  userContent: OpenAIMessageContent[],
  maxTokens: number,
  responseFormat: ResponseFormat = { type: "json_object" }
): Promise<string> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      max_tokens: maxTokens,
      temperature: 0,
      response_format: responseFormat,
    }),
  });
  if (!response.ok) throw new Error(`OpenAI ${response.status}: ${(await response.text()).slice(0, 500)}`);
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) throw new Error("EMPTY_MODEL_RESPONSE");
  return content;
}

interface VerificationReading {
  rawText: string | null;
  value: number | null;
  confident: boolean;
}

async function runTargetedVerification(
  apiKey: string,
  imageUrl: string,
  suspicious: SuspiciousEvidence[],
  ledger: LedgerEntry[],
  lines: string[]
): Promise<VerificationReading[]> {
  const ledgerById = new Map(ledger.map((e) => [e.amountId, e]));
  const locations = suspicious
    .map((s, i) => {
      const entry = s.amountId ? ledgerById.get(s.amountId) : undefined;
      const lineText = s.lineIndex !== undefined ? lines[s.lineIndex] : entry?.rawText ?? "";
      return `${i + 1}. near line ${s.lineIndex ?? "unknown"}: "${lineText}"`;
    })
    .join("\n");
  const content = await callOpenAI(
    apiKey,
    TARGETED_VERIFICATION_SYSTEM_PROMPT,
    [
      { type: "image_url", image_url: { url: imageUrl, detail: "high" } },
      { type: "text", text: `Locations to re-read:\n${locations}` },
    ],
    1000
  );
  try {
    const parsed = JSON.parse(content);
    const readings = Array.isArray(parsed?.readings) ? parsed.readings : [];
    return readings.map((r: Record<string, unknown>) => ({
      rawText: typeof r?.rawText === "string" ? r.rawText : null,
      value: typeof r?.value === "number" ? r.value : null,
      confident: r?.confident === true,
    }));
  } catch {
    return [];
  }
}

function applyVerificationResults(
  ledger: LedgerEntry[],
  assignments: Assignment[],
  suspicious: SuspiciousEvidence[],
  readings: VerificationReading[]
): { resolvedCount: number; unresolvedCount: number } {
  let resolvedCount = 0;
  let unresolvedCount = 0;
  suspicious.forEach((s, i) => {
    const reading = readings[i];
    const resolved = reading !== undefined && reading.confident && reading.value !== null;
    if (resolved) {
      resolvedCount += 1;
      if (s.amountId) {
        const entry = ledger.find((e) => e.amountId === s.amountId);
        if (entry) {
          entry.value = reading.value as number;
          if (reading.rawText !== null) entry.rawText = reading.rawText;
          entry.ocrConfidence = Math.max(entry.ocrConfidence, 0.95);
        }
      }
    } else {
      unresolvedCount += 1;
      const assignment = assignments.find((a) => a.blockId === s.blockId);
      if (assignment) assignment.amountId = null;
    }
  });
  return { resolvedCount, unresolvedCount };
}

// ─── Deterministic failure-pattern detectors (diagnostic only — not part of
// the production pipeline) ──────────────────────────────────────────────────

interface SuspectedPatterns {
  subtotalCountedAsItem: StructureBlock[];
  totalCountedAsItem: StructureBlock[];
  taxCountedAsItem: StructureBlock[];
  amountClaimedByMultipleBlocks: Array<{ amountId: string; blockIds: string[] }>;
  duplicateWordIdsInLedger: Array<{ wordId: string; amountIds: string[] }>;
  overlappingItemLineIndices: Array<{ lineIndex: number; blockIds: string[] }>;
  itemBlocksAfterFirstSummaryLine: StructureBlock[];
  itemsWithQuantityAboveOne: Array<{ blockId: string; quantity: number }>;
}

function detectSuspectedPatterns(blocks: StructureBlock[], ledger: LedgerEntry[]): SuspectedPatterns {
  const itemBlocks = blocks.filter((b) => b.kind === "item");
  const summaryBlocks = blocks.filter((b) => b.kind === "summary");

  const nameMatches = (b: StructureBlock, re: RegExp) => re.test((b.name ?? "").toLowerCase());
  const subtotalCountedAsItem = itemBlocks.filter((b) => nameMatches(b, /subtotal/));
  const totalCountedAsItem = itemBlocks.filter((b) => nameMatches(b, /\btotal\b/));
  const taxCountedAsItem = itemBlocks.filter((b) => nameMatches(b, /tax|vat|gst|hst|service|tip|gratuity/));

  const byAmountId = new Map<string, string[]>();
  for (const b of blocks) {
    if (b.amountId === null) continue;
    const list = byAmountId.get(b.amountId) ?? [];
    list.push(b.blockId);
    byAmountId.set(b.amountId, list);
  }
  const amountClaimedByMultipleBlocks = [...byAmountId.entries()]
    .filter(([, blockIds]) => blockIds.length > 1)
    .map(([amountId, blockIds]) => ({ amountId, blockIds }));

  const byWordId = new Map<string, string[]>();
  for (const e of ledger) {
    const list = byWordId.get(e.wordId) ?? [];
    list.push(e.amountId);
    byWordId.set(e.wordId, list);
  }
  const duplicateWordIdsInLedger = [...byWordId.entries()]
    .filter(([, amountIds]) => amountIds.length > 1)
    .map(([wordId, amountIds]) => ({ wordId, amountIds }));

  const lineToBlocks = new Map<number, string[]>();
  for (const b of itemBlocks) {
    for (const li of b.lineIndices) {
      const list = lineToBlocks.get(li) ?? [];
      list.push(b.blockId);
      lineToBlocks.set(li, list);
    }
  }
  const overlappingItemLineIndices = [...lineToBlocks.entries()]
    .filter(([, blockIds]) => blockIds.length > 1)
    .map(([lineIndex, blockIds]) => ({ lineIndex, blockIds }));

  const firstSummaryLine = summaryBlocks.length
    ? Math.min(...summaryBlocks.flatMap((b) => b.lineIndices))
    : Infinity;
  const itemBlocksAfterFirstSummaryLine = itemBlocks.filter(
    (b) => b.lineIndices.length > 0 && Math.min(...b.lineIndices) > firstSummaryLine
  );

  const itemsWithQuantityAboveOne = itemBlocks
    .filter((b) => (b.quantity ?? 1) > 1)
    .map((b) => ({ blockId: b.blockId, quantity: b.quantity ?? 1 }));

  return {
    subtotalCountedAsItem,
    totalCountedAsItem,
    taxCountedAsItem,
    amountClaimedByMultipleBlocks,
    duplicateWordIdsInLedger,
    overlappingItemLineIndices,
    itemBlocksAfterFirstSummaryLine,
    itemsWithQuantityAboveOne,
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  // --expected=<total> is pulled out of argv wherever it appears; the
  // remaining args stay positional (imagePath, then outputPath). Without
  // it, a debug run doesn't know what the right answer was, and confirming
  // "did this fix work" turns into a conversation every round instead of a
  // read of the file itself.
  const rawArgs = process.argv.slice(2);
  const expectedArg = rawArgs.find((a) => a.startsWith("--expected="));
  const positional = rawArgs.filter((a) => !a.startsWith("--expected="));
  const expectedTotal = expectedArg ? Number(expectedArg.slice("--expected=".length)) : null;
  if (expectedArg && (expectedTotal === null || !Number.isFinite(expectedTotal))) {
    console.error(`Invalid --expected value: "${expectedArg}"`);
    process.exit(1);
  }

  const imagePath = positional[0];
  if (!imagePath) {
    console.error("Usage: npx tsx scripts/debug-parse-receipt.ts <image path> [output.json] [--expected=<printed total>]");
    process.exit(1);
  }
  const outputPath = positional[1] ?? `${imagePath}.debug.json`;

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? process.env.EXPO_PUBLIC_OPENAI_API_KEY ?? "";
  const GOOGLE_CLOUD_API_KEY = process.env.GOOGLE_CLOUD_API_KEY ?? process.env.EXPO_PUBLIC_GOOGLE_CLOUD_API_KEY ?? "";
  const missing = [
    OPENAI_API_KEY ? null : "OPENAI_API_KEY (or EXPO_PUBLIC_OPENAI_API_KEY)",
    GOOGLE_CLOUD_API_KEY ? null : "GOOGLE_CLOUD_API_KEY (or EXPO_PUBLIC_GOOGLE_CLOUD_API_KEY)",
  ].filter((m): m is string => m !== null);
  if (missing.length > 0) {
    // Names only, never values, and never anything from .env.local's content.
    console.error(`Missing from environment / .env.local: ${missing.join(", ")}`);
    process.exit(1);
  }

  const fileBuffer = readFileSync(imagePath);
  const base64Content = fileBuffer.toString("base64");
  const ext = extname(imagePath).toLowerCase();
  const mime = ext === ".png" ? "image/png" : "image/jpeg";
  const imageUrl = `data:${mime};base64,${base64Content}`;

  console.log("Calling Google Vision...");
  const ocrRaw = await callGoogleVision(GOOGLE_CLOUD_API_KEY, base64Content, OCR_LANGUAGE_HINTS);
  const ocr: OcrResult = normalizeVisionResponse(ocrRaw);
  const lines = ocr.lines.map((l) => l.text);
  console.log(`OCR: ${ocr.lines.length} lines, ${ocr.words.length} words`);

  const ledger = buildLedgerFromOcr(ocr.lines);
  console.log(`Ledger: ${ledger.length} monetary tokens`);

  // FIX 11 (Group 1) — computed before the semantic pass, kept in sync with
  // index.ts's own restructuring: GPT itself must never be able to PROPOSE
  // an out-of-column value (Ramires proved that filtering only the matcher's
  // pool wasn't enough — FIX 8.1's ambiguous-fallback would still accept
  // GPT's own proposal of a value the matcher had correctly refused).
  const matchingLedger = filterToAuthoritativeColumn(ledger, ocr.lines, new Set());

  console.log("Calling GPT (structure + assignment)...");
  const numberedLines = ocr.lines.map((l) => `${l.lineIndex}: ${l.text}`).join("\n");
  // Reverted attempt at using the full ledger here — see index.ts's comment
  // at the matching line: it measurably regressed Quebra Mar and Toronto
  // both when tested live against all six fixtures. Kept in sync with
  // index.ts's matchingLedger call.
  const ledgerDescription = describeLedgerForPrompt(matchingLedger);
  const structureContent = await callOpenAI(
    OPENAI_API_KEY,
    STRUCTURE_AND_ASSIGNMENT_SYSTEM_PROMPT,
    [{ type: "text", text: `OCR lines (index: text):\n\n${numberedLines}\n\nMonetary amounts detected by OCR:\n\n${ledgerDescription}` }],
    // Kept in sync with index.ts's own call (FIX 11) — a large real receipt
    // (Mad God, 65 blocks) truncated mid-JSON against the old 3000 cap.
    6000,
    { type: "json_schema", json_schema: buildStructureSchema(matchingLedger, ocr.lines.length) }
  );
  const parsedStructure = JSON.parse(structureContent);
  const merchant: string | null = typeof parsedStructure?.merchant === "string" ? parsedStructure.merchant : null;
  const date: string | null = typeof parsedStructure?.date === "string" ? parsedStructure.date : null;
  const currency: string =
    typeof parsedStructure?.currency === "string" && parsedStructure.currency.trim().length > 0
      ? parsedStructure.currency.trim().toUpperCase()
      : "EUR";
  const blocks: StructureBlock[] = Array.isArray(parsedStructure?.blocks) ? parsedStructure.blocks : [];
  console.log(`Structure: ${blocks.length} blocks (merchant=${merchant}, currency=${currency})`);

  for (const block of blocks) {
    block.lineIndices = block.lineIndices.filter((i) => i >= 0 && i < ocr.lines.length);
  }

  // Kept in sync with index.ts: every block participates in ownership, not
  // just item/modifier/summary — a "quantity"/"unclassified" block still
  // territorially claims its own lines (see ownership.ts), and dropping
  // that filter here (this script previously only passed item/modifier/
  // summary blocks) let a neighbour's search reach into a quantity block's
  // lines that production always fences off. parentBlockId was also missing
  // from this mapping, needed for the same-family territorial exemption.
  const ownershipInputs: PriceBlockInput[] = blocks.map((b) => ({
    blockId: b.blockId,
    kind: b.kind,
    lineIndices: b.lineIndices,
    name: b.name,
    parentBlockId: b.parentBlockId,
    proposedAmountId: b.amountId,
  }));
  const ownershipResults = computeGeometricOwnership(ownershipInputs, matchingLedger, ocr.lines);
  const ownershipByBlock = new Map(ownershipResults.map((r) => [r.blockId, r]));
  for (const block of blocks) {
    const owned = ownershipByBlock.get(block.blockId);
    if (owned) block.amountId = owned.amountId;
  }
  console.log(`Geometric ownership: ${ownershipResults.filter((r) => r.confident).length}/${ownershipResults.length} confident, ${ownershipResults.filter((r) => r.anchorCorrected).length} anchor-corrected`);

  let assignments = assignmentsFromBlocks(blocks);
  let validations: AssignmentValidation[] = validateAssignments(blocks, assignments, ledger);
  validations = validations.map((v) => {
    const owned = ownershipByBlock.get(v.blockId);
    if (owned?.confident && v.amountId === owned.amountId) return { ...v, ownershipValid: true };
    return v;
  });
  const suspiciousByBlock = new Map<string, SuspiciousEvidence>();
  for (const s of [...findSuspiciousEvidence(blocks, validations), ...findOwnershipAmbiguous(ownershipResults)]) {
    if (s.blockId) suspiciousByBlock.set(s.blockId, s);
  }
  const suspicious = [...suspiciousByBlock.values()];
  console.log(`Suspicious (round 1): ${suspicious.length}`);

  let verificationRound1: { readings: VerificationReading[] } | null = null;
  if (suspicious.length > 0) {
    const readings = await runTargetedVerification(OPENAI_API_KEY, imageUrl, suspicious, ledger, lines);
    verificationRound1 = { readings };
    applyVerificationResults(ledger, assignments, suspicious, readings);
    validations = validateAssignments(blocks, assignments, ledger);
  }

  let assembled = buildFinalPayload(merchant, currency, lines, blocks, validations, ledger);
  let reconciliation = reconcile(assembled.payload);
  console.log(`Reconciliation (round 1): reconciles=${reconciliation.reconciles}, calculatedSubtotal=${toMajor(reconciliation.calculatedSubtotalMinor, currency)}, printedSubtotal=${reconciliation.printedSubtotalMinor === null ? null : toMajor(reconciliation.printedSubtotalMinor, currency)}`);

  let reconciliationRetried = false;
  let verificationRound2: { readings: VerificationReading[]; suspects: SuspiciousEvidence[] } | null = null;
  if (!reconciliation.reconciles && reconciliation.printedSubtotalMinor !== null) {
    const alreadyChecked = new Set(suspicious.map((s) => s.amountId).filter((id): id is string => id !== undefined));
    const reconSuspects = findReconciliationSuspects(blocks, validations, alreadyChecked);
    if (reconSuspects.length > 0) {
      reconciliationRetried = true;
      const readings = await runTargetedVerification(OPENAI_API_KEY, imageUrl, reconSuspects, ledger, lines);
      verificationRound2 = { readings, suspects: reconSuspects };
      applyVerificationResults(ledger, assignments, reconSuspects, readings);
      validations = validateAssignments(blocks, assignments, ledger);
      assembled = buildFinalPayload(merchant, currency, lines, blocks, validations, ledger);
      reconciliation = reconcile(assembled.payload);
      console.log(`Reconciliation (round 2): reconciles=${reconciliation.reconciles}, calculatedSubtotal=${toMajor(reconciliation.calculatedSubtotalMinor, currency)}`);
    }
  }

  const { payload, orphanCount } = assembled;
  payload.date = date;

  const patterns = detectSuspectedPatterns(blocks, ledger);

  // Deterministic arithmetic expression, item by item, exactly as reconcile() computes it.
  const items = Array.isArray(payload.items) ? payload.items : [];
  const arithmeticLines: string[] = [];
  let runningSum = 0;
  items.forEach((item, i) => {
    const quantity = typeof item.quantity === "number" && item.quantity >= 1 ? Math.round(item.quantity) : 1;
    const unit = typeof item.unitPrice === "number" ? item.unitPrice : null;
    const lineTotal = typeof item.baseLineTotal === "number" ? item.baseLineTotal : null;
    const base = unit !== null ? unit * quantity : lineTotal !== null ? lineTotal : 0;
    const modifiersSum = (item.modifiers ?? [])
      .filter((m) => m.kind !== "free")
      .reduce((s, m) => s + (typeof m.price === "number" ? m.price : 0), 0);
    const discount = typeof item.discount === "number" ? Math.abs(item.discount) : 0;
    const effective = Math.round((base + modifiersSum - discount) * 100) / 100;
    runningSum = Math.round((runningSum + effective) * 100) / 100;
    arithmeticLines.push(
      `item[${i}] "${item.name}" = ${unit !== null ? `unit(${unit}) * qty(${quantity})` : `lineTotal(${lineTotal})`}` +
        (modifiersSum ? ` + modifiers(${modifiersSum})` : "") +
        (discount ? ` - discount(${discount})` : "") +
        ` = ${effective}   [running sum = ${runningSum}]`
    );
  });

  const report = {
    imagePath,
    merchant,
    date,
    currency,

    // 1. OCR reconstructed lines, in order.
    ocrLines: ocr.lines.map((l) => ({ lineIndex: l.lineIndex, text: l.text })),

    // 2. Every monetary ledger token.
    ledger: ledger.map((e) => ({
      amountId: e.amountId,
      wordId: e.wordId,
      lineIndex: e.lineIndex,
      rawText: e.rawText,
      value: e.value,
      ocrConfidence: e.ocrConfidence,
      boundingBox: e.boundingBox,
    })),

    // 3. Printed summary candidates found.
    summaryBlocks: blocks
      .filter((b) => b.kind === "summary")
      .map((b) => ({
        blockId: b.blockId,
        name: b.name,
        lineIndices: b.lineIndices,
        amountId: b.amountId,
        value: b.amountId ? ledger.find((e) => e.amountId === b.amountId)?.value ?? null : null,
      })),

    // 4. Every semantic block produced by GPT.
    blocks: blocks.map((b) => ({
      blockId: b.blockId,
      kind: b.kind.toUpperCase(),
      lineIndices: b.lineIndices,
      parentBlockId: b.parentBlockId,
      name: b.name,
      amountId: b.amountId,
      quantity: b.quantity,
      priceKind: b.priceKind,
      eligibleAmountIds: computeEligibleAmountIds(b, ledger),
      ownershipValid: validations.find((v) => v.blockId === b.blockId)?.ownershipValid ?? null,
      geometricOwnership: ownershipByBlock.get(b.blockId) ?? null,
    })),

    // 5. Every final item entering the payload.
    finalItems: items.map((item, i) => ({
      itemInstanceId: item.id,
      name: item.name,
      sourceLineIndex: item.sourceEvidence?.lineIndex ?? null,
      priceTokenValue: item.unitPrice,
      quantity: item.quantity,
      modifiers: (item.modifiers ?? []).map((m) => ({ id: m.id, name: m.name, price: m.price, kind: m.kind })),
      effectiveTotal: Number(arithmeticLines[i]?.match(/= ([\d.]+)\s+\[running/)?.[1] ?? "0"),
    })),

    // 6. Deterministic arithmetic expression.
    arithmetic: arithmeticLines,
    calculatedSubtotal: toMajor(reconciliation.calculatedSubtotalMinor, currency),
    printedSubtotal: reconciliation.printedSubtotalMinor === null ? null : toMajor(reconciliation.printedSubtotalMinor, currency),
    printedTotal: reconciliation.printedTotalMinor === null ? null : toMajor(reconciliation.printedTotalMinor, currency),
    subtotalDelta: reconciliation.subtotalDeltaMinor === null ? null : toMajor(reconciliation.subtotalDeltaMinor, currency),
    reconciles: reconciliation.reconciles,
    // The known-correct printed total for this receipt, passed in by hand via
    // --expected — never inferred. null when the caller didn't provide one.
    expectedTotal,
    expectedDelta:
      expectedTotal === null
        ? null
        : Math.round((toMajor(reconciliation.calculatedSubtotalMinor, currency) - expectedTotal) * 100) / 100,
    orphanCount,
    unresolvedLines: payload.unresolvedLines,
    charges: payload.charges,

    // Suspected failure patterns, checked deterministically.
    suspectedPatterns: patterns,

    // Verification rounds, for completeness.
    verificationRound1,
    verificationRound2,
    reconciliationRetried,
  };

  writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf-8");
  console.log(`\nFull report written to: ${outputPath}`);
  console.log(`\nSUMMARY: calculatedSubtotal=${report.calculatedSubtotal}, printedSubtotal=${report.printedSubtotal}, printedTotal=${report.printedTotal}, reconciles=${report.reconciles}, expectedTotal=${report.expectedTotal}, expectedDelta=${report.expectedDelta}`);
}

main().catch((err) => {
  console.error("Debug run failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
