// DEPRECATED: OCR now runs server-side via parse-receipt edge function.
// This file is kept for reference only and will be removed in a future cleanup.

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
  throw new Error("Client-side OCR disabled. Use edge function instead.");
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
  subtotal?: number;       // sum of items only (before service + tax)
  serviceCharge?: number;  // large party / service fee / mandatory gratuity
  taxAmount?: number;      // explicit tax line (NOT Portuguese IVA, which is embedded in prices)
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
const VALID_CURRENCIES = new Set(["EUR", "USD", "GBP", "CAD", "CNY"]);

const DRINK_WORDS = /\b(beer|lager|ale|ipa|stout|porter|cider|draft|draught|pint|cerveja|cerveza|biere|birra|wine|vinho|vino|vin|prosecco|champagne|sparkling|rose|ros[eé]|rioja|merlot|shiraz|cabernet|chardonnay|sauvignon|vodka|gin|rum|tequila|whiskey|whisky|bourbon|brandy|cognac|liqueur|spirits|baileys|aperol|campari|mojito|margarita|negroni|martini|sangria|cocktail|spritz|mimosa|cosmopolitan|bellini|bloody|burdock|mule|smirnoff|pimm|soda|cola|pepsi|sprite|fanta|lemonade|ginger ale|ginger beer|water|agua|água|eau|acqua|juice|sumo|smoothie|milkshake|iced tea|latte|cappuccino|espresso|americano|coffee|cafe|café|tea|coke|7up|dr pepper|redbull|red bull|organic lager|mill st|molson|heineken|carlsberg|corona|modelo|peroni|stella|becks|budweiser|guinness|coors|kronenbourg|san miguel|asahi|sapporo|kirin|leffe|hoegaarden|erdinger|paulaner|radler|shandy|desperados)\b/i;
const MAIN_WORDS = /\b(burger|hamburger|cheeseburger|chicken|frango|pollo|poulet|pork|beef|carne|steak|bitoque|lamb|duck|fish|peixe|poisson|salmon|salm[aã]o|tuna|cod|bacalhau|robalo|shrimp|prawn|camar[aã]o|gambas|crab|lobster|squid|lula|calamari|octopus|polvo|mussels|mexilh[aã]o|clams|oyster|pizza|pasta|spaghetti|penne|rigatoni|linguine|lasagna|ravioli|gnocchi|risotto|paella|ramen|noodle|curry|tikka|masala|biryani|tofu|bowl|wrap|burrito|tacos?|quesadilla|schnitzel|sausage|chorizo|salsicha|lingui[cç]a|hot dog|sandwich|sandes|panini|kebab|shawarma|gyro|falafel|sushi|sashimi|maki|tempura|teriyaki|fried rice|pad thai|seafood|mixed grill|platter|combo|special|main course|principal|prato|dish)\b/i;
const STARTER_WORDS = /\b(starter|starters?|appetizer|entrada|entree|antipasto|bruschetta|bread|p[aã]o|garlic bread|butter|manteiga|olive|azeitona|olives|cheese|queijo|charcuterie|pate|pat[eé]|prosciutto|carpaccio|tartare|ceviche|nachos|guacamole|soup|sopa|salad|salada|caesar|caprese|wings|calamari|gyoza|edamame)\b/i;
const DESSERT_WORDS = /\b(dessert|sobremesa|postre|cake|torta|tarte|tart|pie|pastry|pastel|churro|waffle|crepe|cr[eê]pe|pancake|brownie|cookie|biscuit|muffin|macaron|mousse|pudding|custard|flan|panna cotta|tiramisu|baklava|gelato|ice cream|sorbet|sundae|cheesecake|chocolate|fondant|lava|creme brulee|cr[eè]me br[uû]l[eé]e|affogato)\b/i;

function categorizeByKeyword(name: string): ItemCategory | null {
  if (DRINK_WORDS.test(name)) return "drinks";
  if (MAIN_WORDS.test(name)) return "mains";
  if (STARTER_WORDS.test(name)) return "starters";
  if (DESSERT_WORDS.test(name)) return "desserts";
  return null;
}

function convertToAppFormat(ocr: OcrResult): ParsedReceipt {
  const categories: Record<ItemCategory, ReceiptItem[]> = {
    starters: [], mains: [], drinks: [], desserts: [], others: [],
  };

  const zeroPriceItems: ReceiptItem[] = [];

  (ocr.items ?? []).forEach((item, index) => {
    let cat: ItemCategory = VALID_CATEGORIES.has(item.category as ItemCategory)
      ? (item.category as ItemCategory)
      : "others";
    if (cat === "others") {
      const override = categorizeByKeyword(item.name);
      if (override) cat = override;
    }

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

  // Merge same item + same unitPrice, including qty 2 + qty 1 receipt lines.
  for (const cat of Object.keys(categories) as ItemCategory[]) {
    const merged: ReceiptItem[] = [];
    const keyToIndex = new Map<string, number>();

    for (const item of categories[cat]) {
      const isComplex = item.type === "combo" || (item.components && item.components.length > 0);
      if (isComplex) {
        merged.push(item);
        continue;
      }
      const key = `${item.name.trim().toLowerCase()}|${item.unitPrice}`;
      if (keyToIndex.has(key)) {
        const idx = keyToIndex.get(key)!;
        merged[idx] = {
          ...merged[idx],
          quantity: merged[idx].quantity + item.quantity,
          totalPrice: Math.round((merged[idx].totalPrice + item.totalPrice) * 100) / 100,
          type: merged[idx].quantity + item.quantity > 1 ? "quantity" : merged[idx].type,
        };
      } else {
        keyToIndex.set(key, merged.length);
        merged.push({ ...item, type: item.quantity > 1 ? "quantity" : item.type });
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

  const globalCosts: GlobalCost[] = [];
  if ((ocr.taxAmount ?? 0) > 0.005) {
    globalCosts.push({ id: "ocr-tax", name: "Tax", amount: Math.round((ocr.taxAmount!) * 100) / 100, type: "tax", splitByAll: true, editable: true });
  }
  if ((ocr.serviceCharge ?? 0) > 0.005) {
    globalCosts.push({ id: "ocr-service", name: "Service Charge", amount: Math.round((ocr.serviceCharge!) * 100) / 100, type: "service_charge", splitByAll: true, editable: true });
  }

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

// ─── Deduplication (cross-checked against raw Vision text) ───────────────────

function deduplicateOcrItems(items: OcrItem[], rawText: string): OcrItem[] {
  const seen = new Map<string, number>(); // key → times already kept

  return items.filter((item) => {
    // Strip grouped add-on suffix like "(Add Shrimp)" to match against raw OCR text
    const baseName = item.name.replace(/\s*\(.*\)$/, '').trim();
    const key = `${item.name.trim().toLowerCase()}|${item.unitPrice}|${item.totalPrice}`;
    const keptSoFar = seen.get(key) ?? 0;

    if (keptSoFar === 0) {
      seen.set(key, 1);
      return true;
    }

    // Already kept once — check how many times the name actually appears in the raw text
    const escaped = baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const textCount = (rawText.match(new RegExp(escaped, 'gi')) ?? []).length;

    if (keptSoFar < textCount) {
      seen.set(key, keptSoFar + 1);
      return true; // Raw text confirms multiple occurrences → keep
    }

    if (__DEV__) console.log(`[OCR] Dedup: removed "${item.name}" ($${item.totalPrice}) — text shows ${textCount}× but already kept ${keptSoFar}`);
    return false;
  });
}

// ─── Priced orphan recovery ────────────────────────────────────────────────────
// Runs after GPT extraction. If items sum < subtotal, scans raw Vision text for
// priced lines that GPT missed and attaches them to the nearest preceding item.

function recoverPricedOrphans(ocr: OcrResult, rawText: string): OcrResult {
  const items = [...(ocr.items ?? [])];
  const subtotal = ocr.subtotal ?? ocr.itemsSubtotal;
  if (!subtotal || subtotal <= 0) return ocr;

  const itemsSum = Math.round(items.reduce((s, i) => s + i.totalPrice, 0) * 100) / 100;
  const diff = Math.round((subtotal - itemsSum) * 100) / 100;

  if (Math.abs(diff) <= 0.50) return ocr;

  if (__DEV__) console.log(`[OCR] Orphan recovery: items=$${itemsSum.toFixed(2)}, subtotal=$${subtotal.toFixed(2)}, diff=$${diff.toFixed(2)}`);
  if (__DEV__) console.log(`[OCR] Searching for unmatched priced lines...`);

  // Split raw text before the subtotal/totals section
  const totalsIdx = rawText.search(/\b(subtotal|sub total|sub-total)\b/i);
  const itemsSection = totalsIdx > 0 ? rawText.slice(0, totalsIdx) : rawText;
  const lines = itemsSection.split(/[\r\n]+/).map(l => l.trim()).filter(l => l.length > 0);

  // Collect every line that ends with a price
  const rawPricedLines: Array<{ lineIdx: number; label: string; price: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/\$?\s*([\d]+\.[\d]{2})\s*$/);
    if (m) {
      const price = parseFloat(m[1]);
      const label = lines[i]
        .replace(/\$?\s*[\d]+\.[\d]{2}\s*$/, '') // strip trailing price
        .replace(/^\d+\s+/, '')                   // strip leading qty digit
        .trim();
      if (price > 0) rawPricedLines.push({ lineIdx: i, label, price });
    }
  }

  // Mark prices already accounted for in extracted items
  const usedPrices = new Map<number, number>();
  for (const item of items) {
    const p = Math.round(item.totalPrice * 100) / 100;
    usedPrices.set(p, (usedPrices.get(p) ?? 0) + 1);
  }

  const orphans = rawPricedLines.filter(line => {
    const p = Math.round(line.price * 100) / 100;
    const remaining = usedPrices.get(p) ?? 0;
    if (remaining > 0) {
      usedPrices.set(p, remaining - 1);
      return false;
    }
    return true;
  });

  if (orphans.length === 0) {
    if (__DEV__) console.log(`[OCR] No unmatched priced lines found`);
    return ocr;
  }

  if (__DEV__) console.log(`[OCR] Found unmatched priced line(s):`, orphans.map(o => `"${o.label}" $${o.price}`).join(', '));

  // Find the single orphan whose price equals the running diff (exact recovery)
  const exactOrphan = orphans.find(
    o => Math.abs(Math.round(o.price * 100) / 100 - Math.abs(diff)) < 0.02
  );

  if (!exactOrphan) {
    if (__DEV__) console.log(`[OCR] No orphan matches diff $${diff.toFixed(2)} — skipping auto-recovery`);
    return ocr;
  }

  // Search backward from the orphan's position in the raw text for the nearest
  // item whose base name appears on that line, then attach the orphan to it.
  let attachIdx = -1;
  outer:
  for (let i = exactOrphan.lineIdx - 1; i >= 0; i--) {
    const rawLine = lines[i].toLowerCase();
    for (let j = items.length - 1; j >= 0; j--) {
      const baseName = items[j].name.replace(/\s*\(.*\)$/, '').toLowerCase().trim();
      if (baseName.length > 2 && rawLine.includes(baseName)) {
        attachIdx = j;
        break outer;
      }
    }
  }

  if (attachIdx >= 0) {
    const parent = items[attachIdx];
    if (__DEV__) console.log(`[OCR] Attached priced orphan to previous item: ${parent.name}`);
    items[attachIdx] = {
      ...parent,
      name: `${parent.name} (${exactOrphan.label.trim()})`,
      unitPrice: Math.round((parent.unitPrice + exactOrphan.price) * 100) / 100,
      totalPrice: Math.round((parent.totalPrice + exactOrphan.price) * 100) / 100,
    };
  } else {
    items.push({
      name: exactOrphan.label || 'Unknown Item',
      quantity: 1,
      unitPrice: exactOrphan.price,
      totalPrice: exactOrphan.price,
      category: 'others',
    });
  }

  const newSum = Math.round(items.reduce((s, i) => s + i.totalPrice, 0) * 100) / 100;
  if (__DEV__) console.log(`[OCR] New items sum: $${newSum.toFixed(2)}`);

  return { ...ocr, items };
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

═══════════════════════════════════════════════════════
💲 CURRENCY DETECTION — SET CORRECTLY BASED ON LOCATION/SYMBOLS:
- Symbols: C$, CAD, "Canadian" → "CAD"
- Symbols: $, USD, US locations (New York, Los Angeles, etc.) → "USD"
- Symbols: £, GBP, UK locations → "GBP"
- Symbols: €, EUR, European locations → "EUR"
- Symbols: ¥, 元, RMB, CNY, Chinese locations (Beijing, Shanghai, etc.) → "CNY"
- Location clues: Toronto, Ontario, Vancouver, BC, Canada → "CAD"
- If both $ symbol and Canadian city are visible → "CAD", NOT "USD"
- When uncertain between USD and CAD, check for Canadian city names or "CN" country code
- When uncertain between ¥ and JPY: Chinese text or city names → "CNY"

═══════════════════════════════════════════════════════
🔌 ADD-ON / VARIANT GROUPING — COMBINE WITH PARENT ITEM:
Many North American receipts show items where the price is on a variant/add-on line, NOT on the main item line.
NEVER output modifiers or add-ons as separate items[] entries — always combine them into the parent.

PATTERN A — Main item has NO price on its line, variant line HAS the price:
  "1  Pad Gra Prow"           (no price)
  "   PGP Chicken   23.00"    (has price)
  → ONE item: { name: "Pad Gra Prow (PGP Chicken)", quantity: 1, unitPrice: 23.00, totalPrice: 23.00 }

PATTERN B — Main item HAS a price, add-on line also HAS a price → SUM them into one item:
  "1  Green Curry    25.00"
  "   Add Shrimp     6.00"
  → ONE item: { name: "Green Curry (Add Shrimp)", quantity: 1, unitPrice: 31.00, totalPrice: 31.00 }

PATTERN C — Multiple priced add-ons on the same parent → SUM all into one item:
  "1  Pad Thai       18.00"
  "   PT Shrimp      2.00"
  "   Extra Sauce    1.00"
  → ONE item: { name: "Pad Thai (PT Shrimp, Extra Sauce)", quantity: 1, unitPrice: 21.00, totalPrice: 21.00 }

IGNORE lines with NO price (free modifiers / preparation notes):
  "  Medium"  "  Jasmine"  "  KS Spice"  "  Do Not Make Spicy"  "  Mild"  → IGNORE

CRITICAL: combined item's unitPrice = sum of all prices in the group. Always verify: quantity × unitPrice = totalPrice.

⚠️ PRICED ORPHAN LINES — NEVER IGNORE A LINE WITH A PRICE:
Any line before Subtotal/Tax/Total that carries a price MUST appear in your output.
Do NOT discard it because the label is short, numeric, single-word, or unfamiliar.

RULE: If it appears directly below a named item → combine it using Pattern A or B above.
RULE: If you cannot identify the parent → add it as a separate item in items[].

EXAMPLE — numeric label that MUST be combined:
  "1  Thai Chicken Wings    13.50"
  "   10                   10.50"   ← short/numeric, but HAS A PRICE → must not be ignored
  → { name: "Thai Chicken Wings (10)", quantity: 1, unitPrice: 24.00, totalPrice: 24.00 }

MORE EXAMPLES that must be kept:
  "10          10.50"  "Extra      1.50"  "Add-on     3.00"  "No Name    5.00"  → ALL must appear in items[]

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

🧾 TAX & SERVICE CHARGES:
PORTUGUESE RECEIPTS: IVA is embedded in item prices — set taxAmount: 0, serviceCharge: 0. subtotal = receiptTotal.
US/INTERNATIONAL: "Sales Tax"/"Tax" line → taxAmount. "Service Charge"/"Large Party"/"Gratuity" → serviceCharge.
subtotal = items only. receiptTotal = subtotal + serviceCharge + taxAmount.
IMPORTANT: Service charges and tax MUST NOT appear in items[]. They go in serviceCharge/taxAmount only.

🧮 POST-EXTRACTION QUALITY CHECKS:
1. COUNT: Did I extract the same number of lines as in the text?
2. NAMES: Are all names EXACTLY as printed?
3. MATH: Does each item's quantity × unitPrice = totalPrice (within 0.01€)?
4. TOTAL: Does sum of all items = subtotal? Does subtotal + serviceCharge + taxAmount = receiptTotal?
5. CONFIDENCE: Can I clearly read every item? Set "confidence": "low" if anything is unclear.

If checks 3 or 4 fail → you made an error → re-read the text and fix it BEFORE returning.

🔍 MANDATORY SUBTOTAL SELF-CHECK — DO THIS LAST:
  computed_sum = sum of every item's totalPrice in your items[]
  printed_subtotal = the "Subtotal" line in the raw text (before tax/service charges)

If |computed_sum − printed_subtotal| > 0.50:
  → You missed a priced line OR extracted the same line twice
  → Re-read the raw text top-to-bottom and find the discrepancy
  → Remove any item that appears more than once in your output
  → Only return when computed_sum ≈ printed_subtotal (within 0.10)

Return this exact JSON structure (no markdown, no explanation):
{
  "restaurant": "name from top of receipt",
  "date": "YYYY-MM-DD",
  "currency": "CAD",
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
  "subtotal": 61.40,
  "serviceCharge": 0,
  "taxAmount": 0,
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
  if (__DEV__) console.log("🤖 [hybrid-ocr] Sending Google Vision text to GPT-4o for parsing...");

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

  if (__DEV__) console.log("📄 [hybrid-ocr] GPT-4o response (first 400):", content.substring(0, 400));

  const ocr = extractJSON(content) as unknown as OcrResult;

  const itemsSum = (ocr.items ?? []).reduce((s, i) => s + i.totalPrice, 0);
  const receiptTotalLogged = ocr.validation?.receiptTotal ?? ocr.receiptTotal ?? itemsSum;
  if (__DEV__) {
    console.log("=== HYBRID VALIDATION ===");
    console.log("Items extracted:", (ocr.items ?? []).length, "| GPT item_count claim:", ocr.item_count ?? "(not provided)");
    console.log("Items sum:", itemsSum.toFixed(2), "| Receipt total:", receiptTotalLogged);
    console.log("Difference:", (receiptTotalLogged - itemsSum).toFixed(4));
    console.log("Receipt total:", receiptTotalLogged);
    console.log("Confidence:", ocr.confidence ?? "(not provided)");
    if (ocr.warnings?.length) console.log("GPT warnings:", ocr.warnings);
    console.log("=========================");
  }

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

    if (__DEV__) console.log("✅ [hybrid-ocr] Hybrid pipeline succeeded");
    return { receipt, method: "hybrid", rawText, visionConfidence: confidence };
  } catch (visionErr) {
    const msg = visionErr instanceof Error ? visionErr.message : String(visionErr);

    // Missing keys → bubble up immediately so the caller can show a clear alert
    if (msg === "MISSING_KEY" || msg === "MISSING_GOOGLE_KEY") throw visionErr;

    // Google Vision unavailable for other reasons → fall back to GPT-4o Vision
    console.warn(`⚠️ [hybrid-ocr] Google Vision failed (${msg}), falling back to GPT-4o Vision`);

    const receipt = await analyzeReceiptImage(imageUri);
    return { receipt, method: "gpt-vision" };
  }
}
