import OpenAI from "openai";
import { ParsedReceipt, ReceiptItem, ItemCategory, GlobalCost, Currency, MenuGroup } from "@/types";

// ─── Client ────────────────────────────────────────────────────────────────────

function getClient(): OpenAI {
  const apiKey = process.env.EXPO_PUBLIC_OPENAI_API_KEY;
  if (!apiKey || apiKey === "your_openai_key_here") {
    throw new Error("MISSING_KEY");
  }
  return new OpenAI({ apiKey, dangerouslyAllowBrowser: true });
}

// ─── Base64 Conversion (RN-compatible, no expo-file-system) ───────────────────

async function imageToBase64(uri: string): Promise<string> {
  const response = await fetch(uri);
  const blob = await response.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1]);
    };
    reader.onerror = () => reject(new Error("Failed to convert image to base64"));
    reader.readAsDataURL(blob);
  });
}

// ─── JSON Extraction ──────────────────────────────────────────────────────────

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

// ─── Format Converter ────────────────────────────────────────────────────────

const VALID_CATEGORIES = new Set<ItemCategory>([
  "starters", "mains", "drinks", "desserts", "others",
]);

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

function convertToAppFormat(ocr: OcrResult): ParsedReceipt {
  const categories: Record<ItemCategory, ReceiptItem[]> = {
    starters: [],
    mains: [],
    drinks: [],
    desserts: [],
    others: [],
  };

  const zeroPriceItems: ReceiptItem[] = [];

  (ocr.items ?? []).forEach((item, index) => {
    const cat: ItemCategory = VALID_CATEGORIES.has(item.category as ItemCategory)
      ? (item.category as ItemCategory)
      : "others";

    // Build component list from GPT-provided components
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

    // Items GPT didn't group (totalPrice === 0) — collect for potential grouping
    if (item.totalPrice === 0 && item.unitPrice > 0) {
      zeroPriceItems.push(formatted);
    } else {
      categories[cat].push(formatted);
    }
  });

  // Merge qty:1 items with same name + same unit price (GPT sometimes outputs duplicate lines).
  // Items with qty > 1 are left as-is: they represent a single receipt line with that qty
  // and merging them with a separate qty:1 entry would double-count.
  for (const cat of Object.keys(categories) as ItemCategory[]) {
    const merged: ReceiptItem[] = [];
    const keyToIndex = new Map<string, number>(); // only qty:1 entries register here

    for (const item of categories[cat]) {
      const isComplex = item.type === "combo" || (item.components && item.components.length > 0);
      if (isComplex || item.quantity !== 1) {
        // qty > 1 or complex: keep as-is, never merge
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

  // Detect ungrouped zero-price items (GPT missed the grouping)
  const comboParents = Object.values(categories)
    .flat()
    .filter((i) => i.type === "combo" || /^mn\s/i.test(i.name) || /menu/i.test(i.name));

  const needsMenuConfirmation = zeroPriceItems.length > 0;
  const suggestedMenuGroups: MenuGroup[] = needsMenuConfirmation
    ? (comboParents.length > 0 ? comboParents : Object.values(categories).flat().slice(0, 1)).map(
        (menuItem) => ({ menuItem, components: zeroPriceItems })
      )
    : [];

  // IVA is already embedded in Portuguese receipt item prices — not a separate charge
  const globalCosts: GlobalCost[] = [];

  // Use detected currency, fall back to EUR
  const VALID_CURRENCIES = new Set(["EUR", "USD", "GBP", "CAD"]);
  const currency = (VALID_CURRENCIES.has(ocr.currency ?? "") ? ocr.currency : "EUR") as Currency;

  // itemsTotal = sum of Valor column = the actual total charged (tax-inclusive)
  const itemsTotal = (ocr.items ?? []).reduce((s, i) => s + i.totalPrice, 0);
  const receiptTotal = ocr.validation?.receiptTotal ?? ocr.receiptTotal ?? itemsTotal;
  const difference = receiptTotal - itemsTotal;

  return {
    restaurant: ocr.restaurant ?? "Unknown Restaurant",
    date: ocr.date,
    currency,
    categories,
    globalCosts,
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

// ─── Single-Pass OCR ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  "You are a receipt OCR expert. You extract data with perfect accuracy by ALWAYS verifying the math.\n\nCRITICAL: Focus ONLY on the receipt in the image. Ignore any background, table surface, hands, people, or other objects. If the image contains multiple objects, locate the receipt area and analyze only that. The receipt may be angled or partially lit — still extract all text from it.";

const USER_PROMPT = `You are an EXPERT receipt OCR system. Accuracy is CRITICAL — the output will be used to split a restaurant bill between multiple people.

⚡ MISSION: Extract EVERY SINGLE item from this receipt with 100% accuracy. Missing or wrong items mean real people pay the wrong amount.

🔢 PRE-EXTRACTION CHECKLIST — do this BEFORE extracting:
1. Scan the entire receipt from top to bottom
2. Count the total number of item lines in the receipt
3. You MUST extract that exact number of items

═══════════════════════════════════════════════════════
🍔 MENU & COMBO DETECTION:
Portuguese receipts often show menu/combo items where:
- A main menu line has a total price (e.g. "Mn DoubleChees €3.48")
- Component items show a unit price but €0.00 total (they are INCLUDED in the menu price)
- "1P" marker = 1 Porção = included in menu
- "NATURA" or "Extra" add-ons are PAID separately

RULES for menus:
- If an item has unitPrice > 0 but totalPrice = 0 → it is a component of a menu above it
- Group those zero-total items as components[] of their parent menu item
- Set the menu item type: "combo"
- Set component items inside components[] as: { name, originalPrice (= their unitPrice), quantity: 1, unitPrice: 0, totalPrice: 0 }
- ONLY items with totalPrice > 0 appear in the main items[] array
- Free add-ons ("Extra X") with their own non-zero totalPrice stay as separate items

═══════════════════════════════════════════════════════
🔢 MATH VERIFICATION IS MANDATORY:
For EVERY item you extract:
1. Read Quantity (Qtd) — the integer in the Qtd column
2. Read Unit Price (Preço) — the per-item price
3. Read Total (Valor) — the line total
4. VERIFY: Quantity × Unit Price = Total
5. If they don't match, YOU MADE AN OCR ERROR — look at the image again and correct it

═══════════════════════════════════════════════════════
📋 RECEIPT FORMAT (Portuguese):
Artigo      Qtd  Preço  Valor  IVA
ITEM_NAME    Q    P.PP   V.VV   13%

Common OCR mistakes to avoid:
- Reading "4" as "1" (look carefully — 4 has a crossbar, 1 does not)
- Reading "1" as "2"
- Missing decimal comma (2,50 not 250)
- Confusing Valor (total column) with Preço (unit price column)

═══════════════════════════════════════════════════════
🚨 COMMON OCR MISTAKES — AVOID THESE:
❌ Skipping items that look similar to others
❌ Merging multiple receipt lines into one (unless Qtd column already shows > 1)
❌ Inventing or inferring items not clearly visible
❌ Normalising, translating, or "correcting" item names
❌ Misreading quantities: 1↔7, 3↔8, 0↔6
❌ Misreading decimal separator: "2,75" is 2.75, NOT 275
❌ Confusing the Valor column (total) with the Preço column (unit price)

═══════════════════════════════════════════════════════
⚠️ STRICT EXTRACTION — READ ONLY WHAT YOU SEE:
Your ONLY job is raw, accurate extraction. Do NOT merge, group, infer, or normalize.

RULE 1 — Each physical line on the receipt = ONE JSON entry:
  If the same item appears on 3 separate receipt lines → 3 separate JSON entries.
  "Cerveja Heineken  1  2,75  2,75"  →  entry { quantity: 1, unitPrice: 2.75, totalPrice: 2.75 }
  "Cerveja Heineken  1  2,75  2,75"  →  entry { quantity: 1, unitPrice: 2.75, totalPrice: 2.75 }
  "Cerveja Heineken  1  2,75  2,75"  →  entry { quantity: 1, unitPrice: 2.75, totalPrice: 2.75 }
  The app handles merging — your job is accuracy only.

RULE 2 — If the Qtd column already shows > 1, use that value directly:
  "Coca Cola Pressa  3  2,80  8,40"  →  { quantity: 3, unitPrice: 2.80, totalPrice: 8.40 }

RULE 3 — Same name + different prices → separate entries, always:
  "Acompanhamento  1  1,50  1,50"  →  { quantity: 1, unitPrice: 1.50, totalPrice: 1.50 }
  "Acompanhamento  1  2,50  2,50"  →  { quantity: 1, unitPrice: 2.50, totalPrice: 2.50 }

RULE 4 — Preserve EXACT item names character-by-character:
  "Coca Cola Pressa" → keep as "Coca Cola Pressa" (NOT "Coca-Cola" or "Coke")
  "Zip copo Tinto (" → keep as "Zip copo Tinto (" (NOT "Red Wine")
  "Smoky Pulled Por" → keep as "Smoky Pulled Por" (truncation is fine — do not complete)
  Do NOT translate, normalize, correct apparent typos, or change capitalization.

RULE 5 — If you cannot read a value clearly, set confidence: "low" and add a warning.

ALWAYS verify: quantity × unitPrice = totalPrice for EVERY item before outputting.

═══════════════════════════════════════════════════════
🧾 PORTUGUESE TAX SYSTEM (IVA) — CRITICAL:
Item prices in the Valor column ALREADY INCLUDE IVA (VAT). The IVA breakdown at the bottom is INFORMATIONAL ONLY — it is NOT a separate charge.
- Sum of all item Valor amounts = receiptTotal
- Do NOT add IVA as extra charges
- Do NOT include taxes in the output at all

═══════════════════════════════════════════════════════
🧮 POST-EXTRACTION QUALITY CHECKS — do ALL before returning:
1. COUNT: Did I extract the same number of lines as on the receipt?
2. NAMES: Are all names EXACTLY as printed (no translation, no normalisation)?
3. MATH: Does each item's quantity × unitPrice = totalPrice (within 0.01€)?
4. TOTAL: Does sum of all item totalPrice values = receiptTotal (within 0.01€)?
5. CONFIDENCE: Can I clearly read every item? If anything is unclear, set "confidence": "low"

If checks 3 or 4 fail → you made an error → look at the image again and fix it BEFORE returning.

═══════════════════════════════════════════════════════
Return this exact JSON structure (no markdown, no explanation):
{
  "restaurant": "name from top of receipt",
  "date": "YYYY-MM-DD",
  "currency": "EUR",
  "confidence": "high",
  "warnings": [],
  "items": [
    {
      "name": "Mn DoubleChees",
      "quantity": 1,
      "unitPrice": 3.48,
      "totalPrice": 3.48,
      "category": "mains",
      "type": "combo",
      "components": [
        { "name": "Double Chees", "originalPrice": 5.20 },
        { "name": "Batata Peque", "originalPrice": 0.56 }
      ]
    },
    {
      "name": "Cerveja Heineken",
      "quantity": 1,
      "unitPrice": 2.75,
      "totalPrice": 2.75,
      "category": "drinks"
    },
    {
      "name": "Cerveja Heineken",
      "quantity": 1,
      "unitPrice": 2.75,
      "totalPrice": 2.75,
      "category": "drinks"
    },
    {
      "name": "Coca Cola Pressa",
      "quantity": 3,
      "unitPrice": 2.80,
      "totalPrice": 8.40,
      "category": "drinks"
    }
  ],
  "itemsSubtotal": 61.40,
  "receiptTotal": 61.40,
  "item_count": 4,
  "confidence": "high",
  "warnings": [],
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

FINAL RULE: Before returning, verify all 4 quality checks above.
If any check fails → you made an error → look at the image again and fix it.
NEVER return data you are not confident about. Set confidence "low" and list warnings instead.`;

export async function analyzeReceiptImage(imageUri: string): Promise<ParsedReceipt> {
  console.log("📸 [openai] Analyzing receipt with GPT-4o Vision");

  const client = getClient();
  const base64 = await imageToBase64(imageUri);
  console.log("📊 Image converted to base64:", base64.length, "chars");

  const response = await client.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 4000,
    temperature: 0,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: USER_PROMPT },
          {
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${base64}`, detail: "high" },
          },
        ],
      },
    ],
  });

  const content = response.choices[0]?.message?.content ?? "";
  if (!content) throw new Error("Empty response from OpenAI");

  console.log("📄 GPT-4o response (first 500):", content.substring(0, 500));

  const ocr = extractJSON(content) as unknown as OcrResult;

  // Debug validation log
  const itemsSum = (ocr.items ?? []).reduce((s, i) => s + i.totalPrice, 0);
  const receiptTotalLogged = ocr.validation?.receiptTotal ?? ocr.receiptTotal ?? itemsSum;
  console.log("=== VALIDATION ===");
  console.log("Items extracted:", (ocr.items ?? []).length, "| GPT item_count claim:", ocr.item_count ?? "(not provided)");
  console.log("Items sum (computed):", itemsSum.toFixed(2));
  console.log("GPT itemsSubtotal:", ocr.itemsSubtotal ?? "(not provided)");
  console.log("Receipt total:", receiptTotalLogged);
  console.log("Difference:", (receiptTotalLogged - itemsSum).toFixed(4));
  console.log("Confidence:", ocr.confidence ?? "(not provided)");
  if (ocr.warnings?.length) console.log("GPT warnings:", ocr.warnings);
  console.log("Status:", ocr.validation?.status ?? "(not provided)");
  console.log(
    "Items:",
    (ocr.items ?? []).map((i) => `${i.name} × ${i.quantity} @ ${i.unitPrice} = ${i.totalPrice}`)
  );
  console.log("==================");

  return convertToAppFormat(ocr);
}

// Keep exported for any external consumers
export { USER_PROMPT as RECEIPT_PARSER_SYSTEM_PROMPT };
