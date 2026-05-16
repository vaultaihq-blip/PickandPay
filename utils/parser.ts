import { ParsedReceipt, ReceiptItem, ItemCategory } from "@/types";
import { extractReceiptHybrid } from "@/lib/hybrid-ocr";

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

export async function analyzeReceipt(
  imageUri: string
): Promise<{ receipt: ParsedReceipt; rawText: string }> {
  console.log("📸 [parser] Starting hybrid OCR pipeline:", imageUri);
  try {
    const { receipt, method, rawText } = await extractReceiptHybrid(imageUri);
    console.log(`✅ [parser] OCR complete via ${method}:`, receipt.restaurant);
    return { receipt, rawText: rawText ?? "" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "MISSING_KEY") throw err; // bubble up so scan.tsx can show the key alert
    console.warn("⚠️ [parser] OCR failed, falling back to blank template:", msg);
    return { receipt: createBlankReceipt(), rawText: "" };
  }
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
  const categories = raw.categories ?? {
    starters: [],
    mains: [],
    drinks: [],
    desserts: [],
    others: [],
  };

  return {
    restaurant: raw.restaurant ?? "Unknown Restaurant",
    date: raw.date,
    currency: raw.currency ?? "EUR",
    peopleCountDetected: raw.peopleCountDetected,
    categories: {
      starters: (categories.starters ?? []).map(normalizeReceiptItem),
      mains: (categories.mains ?? []).map(normalizeReceiptItem),
      drinks: (categories.drinks ?? []).map(normalizeReceiptItem),
      desserts: (categories.desserts ?? []).map(normalizeReceiptItem),
      others: (categories.others ?? []).map(normalizeReceiptItem),
    },
    globalCosts: (raw.globalCosts ?? []).map((gc) => ({
      id: gc.id ?? generateCostId(),
      name: gc.name ?? "Cost",
      amount: gc.amount ?? 0,
      type: gc.type ?? "other",
      splitByAll: true as const,
      editable: gc.editable ?? true,
      status: gc.status ?? "included",
    })),
    suggestedTips: raw.suggestedTips ?? [],
    tipMode: "equal" as const,
    selectedTip: 0,
    isSimpleMode: raw.isSimpleMode,
    validation: raw.validation ?? {
      receiptTotal: 0,
      computedTotal: 0,
      difference: 0,
      status: "ok",
    },
  };
}
