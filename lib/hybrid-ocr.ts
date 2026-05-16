// ─── Hybrid OCR: Google Vision text extraction → GPT-4o structured parsing ────
// Pipeline:
//   1. Google Vision DOCUMENT_TEXT_DETECTION  →  raw text
//   2. GPT-4o (text-only, cheaper)            →  structured JSON
//   Fallback: direct GPT-4o Vision (original path) if step 1 fails.

import OpenAI from "openai";
import { ParsedReceipt, ItemCategory, ReceiptItem, GlobalCost, Currency, MenuGroup } from "@/types";
import { extractTextWithGoogleVision } from "@/lib/google-vision-ocr";
import { analyzeReceiptImage } from "@/lib/openai"; // GPT-4o Vision fallback

// ─── OpenAI client ────────────────────────────────────────────────────────────

function getOpenAIClient(): OpenAI {
  const apiKey = process.env.EXPO_PUBLIC_OPENAI_API_KEY;
  if (!apiKey || apiKey === "your_openai_key_here") {
    throw new Error("MISSING_KEY");
  }
  return new OpenAI({ apiKey, dangerouslyAllowBrowser: true });
}

// ─── JSON extraction ──────────────────────────────────────────────────────────

function extractJSON(text: string): Record<string, unknown> {
  const stripped = text
    .replace(/^```(?:json)?\s*/im, "")
    .replace(/\s*```\s*$/im, "")
    .trim();
  try {
    return JSON.parse(stripped);
  } catch {
    const match = stripped.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error("No valid JSON found in model response");
  }
}

// ─── Types mirrored from openai.ts ────────────────────────────────────────────

interface OcrComponent {
  name: string;
  originalPrice?: number;
  unitPrice?: number;
  totalPrice?: number;
  quantity?: number;
}

interface OcrItem {
  name: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  category: string;
  type?: string;
  components?: OcrComponent[];
}

interface OcrResult {
  restaurant: string;
  date?: string;
  currency?: string;
  items: OcrItem[];
  itemsSubtotal?: number;
  receiptTotal?: number;
  item_count?: number;
  confidence?: "high" | "medium" | "low";
  warnings?: string[];
  validation?: {
    computedTotal?: number;
    receiptTotal?: number;
    difference?: number;
    status?: string;
  };
}

// ─── Format converter (shared logic, mirrors openai.ts convertToAppFormat) ────

const VALID_CATEGORIES = new Set<ItemCategory>([
  "starters", "mains", "drinks", "desserts", "others",
]);
const VALID_CURRENCIES = new Set(["EUR", "USD", "GBP", "CAD"]);

function convertToAppFormat(ocr: OcrResult): ParsedReceipt {
  const categories: Record<ItemCategory, ReceiptItem[]> = {
    starters: [], mains: [], drinks: [], desserts: [], others: [],
  };

  const zeroPriceItems: ReceiptItem[] = [];

  (ocr.items ?? []).forEach((item, index) => {
    const cat: ItemCategory = VALID_CATEGORIES.has(item.category as ItemCategory)
      ? (item.category as ItemCategory)
      : "others";

    const components: ReceiptItem[] | undefined = item.components?.map((c, ci) => ({
      id: `item-${index + 1}-comp-${ci}`,
      name: c.name,
      quantity: c.quantity ?? 1,
      unitPrice: c.originalPrice ?? c.unitPrice ?? 0,
      totalPrice: c.totalPrice ?? 0,
      category: cat,
      type: "individual" as const,
    }));

    const itemType = item.type === "combo" ? "combo" : "individual";
    const formatted: ReceiptItem = {
      id: `item-${index + 1}`,
      name: item.name,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      totalPrice: item.totalPrice,
      category: cat,
      type: itemType as any,
      components: components?.length ? components : undefined,
    };

    if (item.totalPrice === 0 && item.unitPrice > 0) {
      zeroPriceItems.push(formatted);
    } else {
      categories[cat].push(formatted);
    }
  });

  // Merge qty:1 items with identical name + unitPrice (GPT duplicate-line detection)
  for (const cat of Object.keys(categories) as ItemCategory[]) {
    const merged: ReceiptItem[] = [];
    const keyToIndex = new Map<string, number>();

    for (const item of categories[cat]) {
      const isComplex = item.type === "combo" || (item.components && item.components.length > 0);
      if (isComplex || item.quantity !== 1) {
        merged.push(item);
        continue;
      }
      const key = `${item.name.trim().toLowerCase()}|${item.unitPrice}`;
      if (keyToIndex.has(key)) {
        const idx = keyToIndex.get(key)!;
        merged[idx] = {
          ...merged[idx],
          quantity: merged[idx].quantity + 1,
          totalPrice: Math.round((merged[idx].totalPrice + item.unitPrice) * 100) / 100,
        };
      } else {
        keyToIndex.set(key, merged.length);
        merged.push({ ...item });
      }
    }
    categories[cat] = merged;
  }

  const comboParents = Object.values(categories)
    .flat()
    .filter((i) => i.type === "combo" || /^mn\s/i.test(i.name) || /menu/i.test(i.name));

  const needsMenuConfirmation = zeroPriceItems.length > 0;
  const suggestedMenuGroups: MenuGroup[] = needsMenuConfirmation
    ? (comboParents.length > 0 ? comboParents : Object.values(categories).flat().slice(0, 1)).map(
        (menuItem) => ({ menuItem, components: zeroPriceItems })
      )
    : [];

  const currency = (VALID_CURRENCIES.has(ocr.currency ?? "") ? ocr.currency : "EUR") as Currency;
  const itemsTotal = (ocr.items ?? []).reduce((s, i) => s + i.totalPrice, 0);
  const receiptTotal = ocr.validation?.receiptTotal ?? ocr.receiptTotal ?? itemsTotal;
  const difference = receiptTotal - itemsTotal;

  return {
    restaurant: ocr.restaurant ?? "Unknown Restaurant",
    date: ocr.date,
    currency,
    categories,
    globalCosts: [] as GlobalCost[],
    suggestedTips: [
      { percentage: 10, amount: Math.round(itemsTotal * 0.1 * 100) / 100 },
      { percentage: 15, amount: Math.round(itemsTotal * 0.15 * 100) / 100 },
      { percentage: 20, amount: Math.round(itemsTotal * 0.2 * 100) / 100 },
    ],
    needsMenuConfirmation: needsMenuConfirmation || undefined,
    suggestedMenuGroups: suggestedMenuGroups.length ? suggestedMenuGroups : undefined,
    validation: {
      receiptTotal,
      computedTotal: itemsTotal,
      difference,
      status: Math.abs(difference) < 0.10 ? "ok" : "error",
    },
  };
}

// ─── Text-parsing prompt (Google Vision supplies the raw text) ─────────────────

function buildTextParserPrompt(rawText: string): string {
  return `You are an EXPERT receipt parser. You will receive raw OCR text extracted from a restaurant receipt and must convert it to a structured JSON format.

The raw text below was extracted by Google Cloud Vision from a receipt image. Parse it carefully.

═══════════════════════════════════════════════════════
RAW OCR TEXT:
${rawText}
═══════════════════════════════════════════════════════

⚡ MISSION: Extract EVERY SINGLE item with 100% accuracy. Missing or wrong items mean real people pay wrong amounts.

🔢 MATH VERIFICATION IS MANDATORY:
For EVERY item you extract:
1. Read Quantity (Qtd) — the integer in the Qtd column
2. Read Unit Price (Preço) — the per-item price
3. Read Total (Valor) — the line total
4. VERIFY: Quantity × Unit Price = Total (within 0.01€)
5. If they don't match → look at the text again and correct it

🍔 MENU & COMBO DETECTION:
- A main menu line has a total price (e.g. "Mn DoubleChees  3.48")
- Component items show a unit price but 0.00 total (INCLUDED in the menu price)
- "1P" marker = 1 Porção = included in menu
- Group zero-total items as components[] of their parent menu item
- Set menu item type: "combo"

⚠️ STRICT EXTRACTION RULES:
RULE 1 — Each physical line on the receipt = ONE JSON entry (qty:1 duplicate lines stay separate).
RULE 2 — If the Qtd column shows > 1, use that value directly.
RULE 3 — Same name + different prices → separate entries, always.
RULE 4 — Preserve EXACT item names character-by-character. Do NOT translate, normalize, or correct typos.
RULE 5 — If a value is ambiguous, set confidence: "low" and add a warning.

🧾 PORTUGUESE TAX SYSTEM (IVA):
Item prices in the Valor column ALREADY INCLUDE IVA. Do NOT add IVA as extra charges.
Sum of all item Valor amounts = receiptTotal.

🧮 POST-EXTRACTION QUALITY CHECKS:
1. COUNT: Did I extract the same number of lines as in the text?
2. NAMES: Are all names EXACTLY as printed?
3. MATH: Does each item's quantity × unitPrice = totalPrice (within 0.01€)?
4. TOTAL: Does sum of all item totalPrice values = receiptTotal (within 0.01€)?
5. CONFIDENCE: Can I clearly read every item? Set "confidence": "low" if anything is unclear.

If checks 3 or 4 fail → you made an error → re-read the text and fix it BEFORE returning.

Return this exact JSON structure (no markdown, no explanation):
{
  "restaurant": "name from top of receipt",
  "date": "YYYY-MM-DD",
  "currency": "EUR",
  "confidence": "high",
  "warnings": [],
  "items": [
    {
      "name": "Cerveja Heineken",
      "quantity": 1,
      "unitPrice": 2.75,
      "totalPrice": 2.75,
      "category": "drinks"
    }
  ],
  "itemsSubtotal": 61.40,
  "receiptTotal": 61.40,
  "item_count": 4,
  "validation": {
    "computedTotal": 61.40,
    "receiptTotal": 61.40,
    "difference": 0,
    "status": "ok"
  }
}

Categories:
- starters: pão, azeitonas, manteiga, queijo, paté, entrada
- mains: bitoque, plumas, carne, peixe, arroz, massa, frango, hamburguer
- drinks: refrigerante, água, cerveja, vinho, sumo, bebida
- desserts: mousse, doce, pudim, gelado, tarte, sobremesa
- others: café, taxa, serviço

FINAL RULE: Verify all 4 quality checks. If any fails → fix it. NEVER return data you are not confident about.`;
}

// ─── Step 2: Parse raw text with GPT-4o ───────────────────────────────────────

async function parseTextWithGPT(rawText: string): Promise<ParsedReceipt> {
  const client = getOpenAIClient();
  console.log("🤖 [hybrid-ocr] Sending Google Vision text to GPT-4o for parsing...");

  const response = await client.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 4000,
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "You are a receipt OCR expert. Parse receipt text into structured JSON with perfect accuracy. ALWAYS verify math before returning.",
      },
      {
        role: "user",
        content: buildTextParserPrompt(rawText),
      },
    ],
  });

  const content = response.choices[0]?.message?.content ?? "";
  if (!content) throw new Error("Empty response from GPT-4o");

  console.log("📄 [hybrid-ocr] GPT-4o response (first 400):", content.substring(0, 400));

  const ocr = extractJSON(content) as unknown as OcrResult;

  const itemsSum = (ocr.items ?? []).reduce((s, i) => s + i.totalPrice, 0);
  const receiptTotalLogged = ocr.validation?.receiptTotal ?? ocr.receiptTotal ?? itemsSum;
  console.log("=== HYBRID VALIDATION ===");
  console.log("Items extracted:", (ocr.items ?? []).length, "| GPT item_count claim:", ocr.item_count ?? "(not provided)");
  console.log("Items sum:", itemsSum.toFixed(2), "| Receipt total:", receiptTotalLogged);
  console.log("Difference:", (receiptTotalLogged - itemsSum).toFixed(4));
  console.log("Confidence:", ocr.confidence ?? "(not provided)");
  if (ocr.warnings?.length) console.log("GPT warnings:", ocr.warnings);
  console.log("=========================");

  return convertToAppFormat(ocr);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface HybridOcrResult {
  receipt: ParsedReceipt;
  method: "hybrid" | "gpt-vision";
  rawText?: string;
  visionConfidence?: number;
}

export async function extractReceiptHybrid(
  imageUri: string
): Promise<HybridOcrResult> {
  // Step 1: Try Google Vision for text extraction
  try {
    const { rawText, confidence } = await extractTextWithGoogleVision(imageUri);

    // Step 2: Parse with GPT-4o text model
    const receipt = await parseTextWithGPT(rawText);

    console.log("✅ [hybrid-ocr] Hybrid pipeline succeeded");
    return { receipt, method: "hybrid", rawText, visionConfidence: confidence };
  } catch (visionErr) {
    const msg = visionErr instanceof Error ? visionErr.message : String(visionErr);

    // MISSING_KEY for OpenAI should always bubble up
    if (msg === "MISSING_KEY") throw visionErr;

    // Google Vision unavailable → fall back to GPT-4o Vision
    console.warn(`⚠️ [hybrid-ocr] Google Vision failed (${msg}), falling back to GPT-4o Vision`);

    const receipt = await analyzeReceiptImage(imageUri);
    return { receipt, method: "gpt-vision" };
  }
}
