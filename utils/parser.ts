import { ParsedReceipt, ReceiptItem, ItemCategory, TaxMode } from "@/types";
import {
  type RawReceiptPayload,
  evaluateReceipt,
  moneyToMajorNumber,
  normalizeRawReceipt,
} from "@/lib/receipt";
import { toParsedReceipt } from "@/lib/receipt/adapter";
import { useCanonicalReceiptStore } from "@/store/canonicalReceiptStore";

// ─── Receipt Parser Utilities ──────────────────────────────────────────────────
// These helpers are used to normalize data coming from the GPT-4o Edge Function

let _itemSeq = 1000;
export function generateItemId(): string {
  return `item_${Date.now()}_${++_itemSeq}`;
}

export function generateCostId(): string {
  return `gc_${Date.now()}_${++_itemSeq}`;
}

// ─── Category Detection ────────────────────────────────────────────────────────

const CATEGORY_KEYWORDS: Record<ItemCategory, string[]> = {
  starters: ["bread", "pão", "azeitonas", "olive", "butter", "manteiga", "cheese", "queijo", "pate", "paté", "bruschetta", "starter", "appetizer"],
  mains: ["burger", "chicken", "frango", "fish", "peixe", "pasta", "rice", "arroz", "steak", "salad", "salada", "menu", "combo", "main", "entrée"],
  drinks: ["water", "água", "beer", "cerveja", "wine", "vinho", "soda", "cola", "juice", "sumo", "coffee", "café", "tea", "drink"],
  desserts: ["cake", "ice cream", "gelado", "pudim", "dessert", "sweet", "chocolate", "tarte", "tiramisu", "cheesecake"],
  others: ["café", "coffee", "espresso", "tax", "fee", "service", "charge"],
};

export function detectCategory(name: string): ItemCategory {
  const lower = name.toLowerCase();
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      return category as ItemCategory;
    }
  }
  return "others";
}

// ─── Blank Receipt Template ────────────────────────────────────────────────────

export function createBlankReceipt(): ParsedReceipt {
  // A blank receipt is a new identity too — a canonical receipt/issues left
  // over from an earlier scan (e.g. the user cancelled and entered manually
  // instead) must not survive into it.
  useCanonicalReceiptStore.getState().clear();

  return {
    restaurant: "New Receipt",
    date: new Date().toISOString().split("T")[0],
    currency: "EUR",
    categories: {
      starters: [],
      mains: [],
      drinks: [],
      desserts: [],
      others: [],
    },
    globalCosts: [],
    suggestedTips: [],
    validation: {
      receiptTotal: 0,
      computedTotal: 0,
      difference: 0,
      status: "ok",
    },
  };
}

// ─── Receipt Analyzer ────────────────────────────────────────────────────────

interface ParseReceiptResponse {
  schemaVersion?: number;
  receipt?: RawReceiptPayload;
}

export async function analyzeReceipt(
  imageUri: string
): Promise<{ receipt: ParsedReceipt; rawText: string }> {
  // A new scan means a new receipt identity — any canonical receipt/issues
  // left over from a previous scan must not survive into this one, even if
  // this particular call ends up on the legacy (non-v2) branch below and
  // never repopulates the store itself.
  useCanonicalReceiptStore.getState().clear();

  console.log("📸 [parser] Starting edge function OCR:", imageUri.substring(0, 40));
  // Dynamic import: lib/supabase.ts pulls in React Native / Expo modules at
  // load time, which would make this file (and its pure normalizeReceipt
  // bridge below) unloadable from a plain Node test environment.
  const { parseReceiptImage } = await import("@/lib/supabase");
  const { data, error, code } = await parseReceiptImage(imageUri);
  if (error) {
    throw Object.assign(
      new Error(`OCR edge function failed: ${(error as { message?: string }).message ?? "Unknown error"}`),
      { code }
    );
  }
  if (!data) {
    throw new Error("OCR edge function returned no data");
  }

  const response = data as ParseReceiptResponse;

  let receipt: ParsedReceipt;
  if (response.schemaVersion === 2 && response.receipt !== undefined) {
    // Structural v2 envelope: run it through the canonical pipeline (exact
    // money, reconciliation, diagnostics), then bridge to the legacy shape so
    // normalizeReceipt's tax-mode reconciliation below still applies.
    const canonical = evaluateReceipt(normalizeRawReceipt(response.receipt));
    const legacy = toParsedReceipt(canonical);

    useCanonicalReceiptStore.getState().setReceipt(canonical);

    receipt = normalizeReceipt({
      ...legacy,
      printed_total:
        canonical.printedTotal !== undefined
          ? moneyToMajorNumber(canonical.printedTotal)
          : undefined,
    });
  } else {
    // Legacy category-based payload — kept so an older deployed function
    // keeps working while the new one rolls out.
    receipt = normalizeReceipt(data as Partial<ParsedReceipt>);
  }

  console.log("✅ [parser] OCR complete:", receipt.restaurant);
  return { receipt, rawText: "" };
}

// ─── Tax Mode Detection ────────────────────────────────────────────────────────

function detectTaxMode(currency: string, raw: Partial<ParsedReceipt>): TaxMode {
  if (raw.tax_mode === "inclusive") return "inclusive";
  if (raw.tax_mode === "exclusive") return "exclusive";
  if (currency === "EUR" || currency === "GBP") return "inclusive";
  if (currency === "USD" || currency === "CAD") return "exclusive";
  return "inclusive"; // default: safer for EUR primary market
}

// ─── Receipt Normalizer ────────────────────────────────────────────────────────

export function normalizeReceiptItem(raw: Partial<ReceiptItem>): ReceiptItem {
  const quantity = raw.quantity ?? 1;
  const unitPrice = raw.unitPrice ?? 0;
  return {
    id: raw.id ?? generateItemId(),
    name: raw.name ?? "Unknown Item",
    category: raw.category ?? detectCategory(raw.name ?? ""),
    quantity,
    unitPrice,
    totalPrice: raw.totalPrice ?? unitPrice * quantity,
    type: raw.type ?? "individual",
    notes: raw.notes,
    components: raw.components,
    addOns: raw.addOns,
    participants: raw.participants,
    confidence: raw.confidence,
    warnings: raw.warnings,
  };
}

export function normalizeReceipt(raw: Partial<ParsedReceipt>): ParsedReceipt {
  const currency = raw.currency ?? "EUR";
  const taxMode = detectTaxMode(currency, raw);

  const categories = raw.categories ?? {
    starters: [], mains: [], drinks: [], desserts: [], others: [],
  };

  const normalizedCategories = {
    starters: (categories.starters ?? []).map(normalizeReceiptItem),
    mains:    (categories.mains    ?? []).map(normalizeReceiptItem),
    drinks:   (categories.drinks   ?? []).map(normalizeReceiptItem),
    desserts: (categories.desserts ?? []).map(normalizeReceiptItem),
    others:   (categories.others   ?? []).map(normalizeReceiptItem),
  };

  const itemsSum = Math.round(
    Object.values(normalizedCategories).flat().reduce((s, i) => s + i.totalPrice, 0) * 100
  ) / 100;

  const printedTotal: number | undefined = raw.printed_total ??
    (raw.validation?.receiptTotal && raw.validation.receiptTotal > 0
      ? raw.validation.receiptTotal
      : undefined);

  // ── Mathematical reconciliation ────────────────────────────────────────────────
  // Determine whether tax global costs are real (exclusive) or display-only metadata
  // (inclusive). We do this by checking which scenario makes the numbers add up.
  //
  // Tolerance of 0.50€ absorbs rounding errors and minor GPT price misreads.
  //
  // Scenario A: itemsSum + nonTaxCosts ≈ printed_total
  //   → tax lines are VAT metadata; adding them would overcharge. Strip them.
  // Scenario B: itemsSum + nonTaxCosts + taxCosts ≈ printed_total
  //   → all costs are genuine (e.g. US sales tax added on top). Keep all.
  // Fallback: no printed_total available → use currency heuristic.
  const TOLERANCE = 0.50;

  const rawGlobalCosts = raw.globalCosts ?? [];
  const taxCosts    = rawGlobalCosts.filter((gc) => gc.type === "tax");
  const nonTaxCosts = rawGlobalCosts.filter((gc) => gc.type !== "tax");
  const taxSum    = Math.round(taxCosts.reduce((s, gc) => s + (gc.amount ?? 0), 0) * 100) / 100;
  const nonTaxSum = Math.round(nonTaxCosts.reduce((s, gc) => s + (gc.amount ?? 0), 0) * 100) / 100;

  let finalGlobalCosts: typeof rawGlobalCosts;
  if (printedTotal !== undefined) {
    const diffWithoutTax = Math.abs(itemsSum + nonTaxSum - printedTotal);
    const diffWithAll    = Math.abs(itemsSum + nonTaxSum + taxSum - printedTotal);

    if (diffWithoutTax <= TOLERANCE) {
      finalGlobalCosts = nonTaxCosts; // tax lines are metadata, not costs
    } else if (diffWithAll <= TOLERANCE) {
      finalGlobalCosts = rawGlobalCosts; // all costs are genuine (US/CA exclusive tax)
    } else {
      // Can't reconcile — fall back to heuristic
      finalGlobalCosts = taxMode === "inclusive" ? nonTaxCosts : rawGlobalCosts;
    }
  } else {
    finalGlobalCosts = taxMode === "inclusive" ? nonTaxCosts : rawGlobalCosts;
  }

  const normalizedGlobalCosts = finalGlobalCosts.map((gc) => ({
    id: gc.id ?? generateCostId(),
    name: gc.name ?? "Cost",
    amount: gc.amount ?? 0,
    type: gc.type ?? "other",
    splitByAll: true as const,
    editable: gc.editable ?? true,
    status: gc.status ?? "included",
  }));

  const effectiveTotal = printedTotal ?? itemsSum;

  // Status must compare the printed total against items + the costs that were
  // actually kept (finalGlobalCosts), not against itemsSum alone — otherwise
  // any receipt with real tax/service (the normal case for USD/CAD) always
  // shows a gap equal to those charges and never reports "ok".
  const globalCostsSum =
    Math.round(finalGlobalCosts.reduce((s, gc) => s + (gc.amount ?? 0), 0) * 100) / 100;
  const reconciledTotal = Math.round((itemsSum + globalCostsSum) * 100) / 100;
  const validationStatus: "ok" | "warning" | "error" =
    Math.abs(effectiveTotal - reconciledTotal) > TOLERANCE ? "warning" : "ok";

  return {
    restaurant: raw.restaurant ?? "Unknown Restaurant",
    date: raw.date,
    currency,
    tax_mode: taxMode,
    printed_total: printedTotal,
    peopleCountDetected: raw.peopleCountDetected,
    categories: normalizedCategories,
    globalCosts: normalizedGlobalCosts,
    suggestedTips: raw.suggestedTips ?? [],
    tipMode: "equal" as const,
    selectedTip: 0,
    isSimpleMode: raw.isSimpleMode,
    ocr_passes: raw.ocr_passes,
    validation: {
      receiptTotal: effectiveTotal,
      computedTotal: itemsSum,
      difference: Math.round((effectiveTotal - itemsSum) * 100) / 100,
      status: validationStatus,
    },
  };
}
