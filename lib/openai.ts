// DEPRECATED: OCR now runs server-side via parse-receipt edge function.
// This file is kept for reference only and will be removed in a future cleanup.

import OpenAI from "openai";
import { ParsedReceipt, ReceiptItem, ItemCategory, GlobalCost, Currency, MenuGroup } from "@/types";

// ─── Client ────────────────────────────────────────────────────────────────────

function getClient(): OpenAI {
  throw new Error("Client-side OCR disabled. Use edge function instead.");
}

// ─── Base64 Conversion (RN-compatible, no expo-file-system) ───────────────────

async function imageToBase64(uri: string): Promise<string> {
  if (uri.startsWith("data:")) {
    return uri.split(",")[1] ?? "";
  }
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

// Client-side hard override: these words ALWAYS mean "drinks" regardless of GPT output
const DRINK_WORDS = /\b(beer|lager|ale|ipa|stout|porter|cider|draft|draught|pint|cerveja|cerveza|biere|birra|wine|vinho|vino|vin|prosecco|champagne|sparkling|ros[eé]|rioja|merlot|shiraz|cabernet|chardonnay|sauvignon|spirits?|vodka|gin|rum|tequila|whiskey|whisky|bourbon|brandy|cognac|liqueur|baileys|aperol|campari|mojito|margarita|marg|daiquiri|cosmo|cosmopolitan|negroni|martini|mule|sangria|cocktail|spritz|mimosa|bloody|bellini|pimms?|smirnoff|absolut|gordons|hendricks?|jagermeister|tia maria|kahlua|drambuie|amaretto|cointreau|sambuca|limoncello|schnapps|soda|cola|pepsi|sprite|fanta|lemonade|ginger ale|ginger beer|water|agua|água|eau|acqua|juice|sumo|smoothie|milkshake|frappe|iced tea|latte|cappuccino|espresso|macchiato|americano|mocha|flat white|hot choc|coffee|caf[eé]|galão|abatanado|cimbalino|imperial|caneca|fino|tea|ch[aá]|infus|tisane|coke|7up|dr pepper|redbull|red bull|energy drink|kombucha|kefir|burdock|organic lager|mill st|molson|heineken|carlsberg|corona|modelo|peroni|stella|becks|budweiser|guinness|fosters|coors|kronenbourg|san miguel|asahi|sapporo|kirin|tsingtao|chang|singha|tiger|leffe|hoegaarden|erdinger|paulaner|weiss|weizen|hefeweizen|radler|shandy|desperados|refrigerante|bebida)\b/i;
const MAIN_WORDS = /\b(burger|hamburger|cheeseburger|chicken|frango|pollo|poulet|poulet|pork|porc|puerco|beef|boeuf|carne|res|steak|bistec|bitoque|plumas|lamb|cordero|agneau|duck|canard|pato|fish|peixe|poisson|pez|salmon|salmao|salmone|saumon|tuna|thon|atun|cod|bacalhau|morue|sole|sea bass|robalo|seabream|dorade|shrimp|prawn|camarao|crevette|gambas|crab|caranguejo|crabe|lobster|lagosta|homard|squid|lula|calamari|octopus|polvo|mussels|mexilhao|moules|clams|amijoa|palourde|oyster|ostra|huître|pizza|pasta|spaghetti|fettuccine|penne|rigatoni|linguine|tagliatelle|lasagna|lasagne|ravioli|gnocchi|risotto|paella|ramen|noodle|tagliatelle|fettuccine|pad thai|curry|tikka|masala|korma|biryani|dal|dhal|paneer|tofu|bowl|wrap|burrito|tacos?|fajita|quesadilla|enchilada|nachos grande|schnitzel|wiener|bratwurst|wurst|sausage|chorizo|salsicha|linguica|hot dog|sandwich|sandes|bocadillo|sub|panini|club|blt|kebab|shawarma|gyro|falafel|hummus|pita|naan|chapati|roti|dosa|idli|samosa|spring roll|dumpling|dim sum|siu mai|gyoza|bao|bulgogi|bibimbap|katsu|tempura|teriyaki|sushi|sashimi|maki|nigiri|roll|wonton|fried rice|chow mein|lo mein|general tso|kung pao|sweet sour|orange chicken|pho|laksa|rendang|satay|nasi|mie|ayam|daging|ikan|seafood|mixed grill|platter|combo|special|main course|entree|principal|prato|dish)\b/i;
const STARTER_WORDS = /\b(starter|starters?|appetizer|entrada|entree|antipasto|antipasti|bruschetta|crostini|breadsticks|bread|pao|baguette|focaccia|garlic bread|butter|manteiga|beurre|olive|azeitona|olives|cheese|queijo|fromage|formaggio|charcuterie|pate|pâté|terrine|rillette|prosciutto|iberico|serrano|carpaccio|tartare|ceviche|tostada|nachos|guacamole|salsa|soup|soupe|sopa|zuppa|bisque|chowder|gazpacho|minestrone|consomme|vichyssoise|cream of|puree|potage|borsch|salad|salade|salada|caesar|nicoise|caprese|greek|waldorf|coleslaw|slaw|wings|buffalo|calamari|squid ring|fritto|misto|tempura|gyoza|edamame|miso|tom yum|pad see)\b/i;
const DESSERT_WORDS = /\b(dessert|sobremesa|dessert|dolce|postre|cake|gateau|torta|tarte|tart|pie|pastry|pastel|eclair|profiterole|beignet|donut|doughnut|churro|waffle|gaufre|crepe|cr[eê]pe|pancake|blini|brownie|cookie|biscuit|muffin|cupcake|macaron|macaroon|meringue|pavlova|mousse|pudding|budino|custard|creme|crème|flan|pannacotta|panna cotta|tiramisu|baklava|lokum|halva|cannoli|gelato|ice cream|sorbet|sherbet|frozen|sundae|parfait|banana split|cheesecake|cheesecake|lemon tart|fruit tart|apple pie|chocolate|fondant|lava|sticky toffee|bread pudding|rice pudding|creme brulee|cr[eè]me br[uû]l[eé]e|creme caramel|affogato|zabaglione|semifreddo)\b/i;

function categorizeByKeyword(name: string): ItemCategory | null {
  if (DRINK_WORDS.test(name)) return "drinks";
  if (MAIN_WORDS.test(name)) return "mains";
  if (STARTER_WORDS.test(name)) return "starters";
  if (DESSERT_WORDS.test(name)) return "desserts";
  return null;
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
    let cat: ItemCategory = VALID_CATEGORIES.has(item.category as ItemCategory)
      ? (item.category as ItemCategory)
      : "others";
    // DRINK_WORDS is a hard override — any beverage keyword always wins
    if (DRINK_WORDS.test(item.name)) {
      cat = "drinks";
    } else if (cat === "others") {
      // Softer override: only re-classify when GPT returned "others" incorrectly
      const override = categorizeByKeyword(item.name);
      if (override) cat = override;
    }

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

  // Merge same item + same unit price, even when one receipt line has qty > 1.
  // Example: "Mill St Organic Lager LG" qty 2 plus qty 1 becomes qty 3.
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

  // Add explicitly-extracted taxes and service charges as shared global costs.
  // Portuguese IVA is embedded in prices → GPT returns taxAmount:0 for PT receipts.
  // Canadian HST, US sales tax, service charges are extracted and distributed equally.
  const globalCosts: GlobalCost[] = [];
  if ((ocr.taxAmount ?? 0) > 0.005) {
    globalCosts.push({
      id: "ocr-tax",
      name: "Tax",
      amount: Math.round((ocr.taxAmount!) * 100) / 100,
      type: "tax",
      splitByAll: true,
      editable: true,
    });
  }
  if ((ocr.serviceCharge ?? 0) > 0.005) {
    globalCosts.push({
      id: "ocr-service",
      name: "Service Charge",
      amount: Math.round((ocr.serviceCharge!) * 100) / 100,
      type: "service_charge",
      splitByAll: true,
      editable: true,
    });
  }

  // Use detected currency, fall back to EUR
  const VALID_CURRENCIES = new Set(["EUR", "USD", "GBP", "CAD"]);
  const currency = (VALID_CURRENCIES.has(ocr.currency ?? "") ? ocr.currency : "EUR") as Currency;

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
💲 CURRENCY DETECTION — SET CORRECTLY BASED ON LOCATION/SYMBOLS:
- Symbols: C$, CAD, "Canadian" → "CAD"
- Symbols: $, USD, US locations (New York, Los Angeles, etc.) → "USD"
- Symbols: £, GBP, UK locations → "GBP"
- Symbols: €, EUR, European locations → "EUR"
- Location clues: Toronto, Ontario, Vancouver, BC, Canada → "CAD"
- If both $ symbol and Canadian city are visible → "CAD", NOT "USD"
- When uncertain between USD and CAD, check for Canadian city names or "CN" country code

═══════════════════════════════════════════════════════
🔌 ADD-ON / VARIANT GROUPING — COMBINE WITH PARENT ITEM:
Many North American receipts show items where the price is on a variant/add-on line, NOT on the main item line.
NEVER output modifiers or add-ons as separate items[] entries — always combine them into the parent.

PATTERN A — Main item has NO price on its line, variant line HAS the price:
  "1  Pad Gra Prow"           (no price)
  "   PGP Chicken   $23.00"   (has price)
  → ONE item: { name: "Pad Gra Prow (PGP Chicken)", quantity: 1, unitPrice: 23.00, totalPrice: 23.00 }

PATTERN B — Main item HAS a price, add-on line also HAS a price → SUM them into one item:
  "1  Green Curry    $25.00"
  "   Add Shrimp     $6.00"
  → ONE item: { name: "Green Curry (Add Shrimp)", quantity: 1, unitPrice: 31.00, totalPrice: 31.00 }

PATTERN C — Multiple priced add-ons on the same parent → SUM all into one item:
  "1  Pad Thai       $18.00"
  "   PT Shrimp      $2.00"
  "   Extra Sauce    $1.00"
  → ONE item: { name: "Pad Thai (PT Shrimp, Extra Sauce)", quantity: 1, unitPrice: 21.00, totalPrice: 21.00 }

IGNORE lines with NO price (free modifiers / preparation notes):
  "  Medium"  "  Jasmine"  "  KS Spice"  "  Do Not Make Spicy"  "  Mild"  → IGNORE

CRITICAL: combined item's unitPrice = sum of all prices in the group. Always verify: quantity × unitPrice = totalPrice.

═══════════════════════════════════════════════════════
⚠️ PRICED ORPHAN LINES — NEVER IGNORE A LINE WITH A PRICE:
Any line before Subtotal/Tax/Total that carries a price MUST appear in your output.
Do NOT discard it because the label is short, numeric, single-word, or unfamiliar.

RULE: If it appears directly below a named item → combine it using Pattern A or B above.
RULE: If you cannot identify the parent → add it as a separate item in items[].

EXAMPLE — numeric label that MUST be combined:
  "1  Thai Chicken Wings    $13.50"
  "   10                   $10.50"   ← short/numeric, but HAS A PRICE → must not be ignored
  → { name: "Thai Chicken Wings (10)", quantity: 1, unitPrice: 24.00, totalPrice: 24.00 }

MORE EXAMPLES that must be kept:
  "10   $10.50"  "Extra   $1.50"  "Add-on   $3.00"  "No Name   $5.00"  → ALL must appear in items[]

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
🧾 TAX & SERVICE CHARGES — CRITICAL:
Different receipts handle these differently:

PORTUGUESE RECEIPTS (IVA system):
- Item prices ALREADY INCLUDE IVA — the IVA breakdown table at the bottom is informational only
- Set taxAmount: 0 and serviceCharge: 0 for Portuguese receipts
- subtotal = receiptTotal = sum of all item Valor amounts

US / UK / INTERNATIONAL RECEIPTS:
- Explicit "Sales Tax", "Tax" line → extract as taxAmount
- "Service Charge", "Large Party Fee", "Mandatory Gratuity", "Service Fee" → extract as serviceCharge
- subtotal = sum of item prices only (before service + tax)
- receiptTotal = subtotal + serviceCharge + taxAmount

IMPORTANT: Service charges, tax, and gratuity lines MUST NOT appear in items[]. They go in serviceCharge or taxAmount only.

═══════════════════════════════════════════════════════
🧮 POST-EXTRACTION QUALITY CHECKS — do ALL before returning:
1. COUNT: Did I extract the same number of lines as on the receipt?
2. NAMES: Are all names EXACTLY as printed (no translation, no normalisation)?
3. MATH: Does each item's quantity × unitPrice = totalPrice (within 0.01€)?
4. TOTAL: Does sum of all item totalPrice values = subtotal? Does subtotal + serviceCharge + taxAmount = receiptTotal?
5. CONFIDENCE: Can I clearly read every item? If anything is unclear, set "confidence": "low"

If checks 3 or 4 fail → you made an error → look at the image again and fix it BEFORE returning.

═══════════════════════════════════════════════════════
🔍 MANDATORY SUBTOTAL SELF-CHECK — DO THIS LAST:
  computed_sum = sum of every item's totalPrice in your items[]
  printed_subtotal = the "Subtotal" line on the receipt (before tax/service charges)

If |computed_sum − printed_subtotal| > 0.50:
  → You missed a priced line OR extracted the same line twice
  → Scan top-to-bottom again and find the discrepancy
  → Remove any item that appears more than once in your output
  → Only return when computed_sum ≈ printed_subtotal (within 0.10)

═══════════════════════════════════════════════════════
🏷️ CATEGORY RULES — MANDATORY FOR EVERY ITEM:
You MUST assign each item one of exactly these 5 categories (lowercase, no other values):
  "starters" | "mains" | "drinks" | "desserts" | "others"

DRINKS (use "drinks" for ALL of these):
  - ANY beer, lager, ale, IPA, stout, draft, pint — e.g. "Mill St Organic Lager LG", "Burdock Duck", "Heineken", "Cerveja", "Corona"
  - ANY wine, prosecco, champagne, cider, spirits
  - ANY cocktail, vodka, gin, rum, whiskey, tequila, Smirnoff, Moscow Mule, mojito, martini
  - ANY soda, cola, juice, water, smoothie, milkshake, lemonade, sparkling water
  - Tea, coffee, espresso, latte, cappuccino

MAINS (use "mains" for ALL of these):
  - Burgers, tacos, pizza, pasta, chicken, steak, fish, seafood
  - Sandwiches, wraps, burritos, quesadillas
  - Rice dishes, curries, bowls, platters
  - ANY main course, entree, principal dish

STARTERS (use "starters" for):
  - Appetizers, soups, salads, bread, olives, bruschetta
  - Wings, calamari, nachos, dips

DESSERTS (use "desserts" for):
  - Cakes, ice cream, mousse, pudding, cheesecake, brownie, tart

OTHERS (use "others" ONLY for):
  - Service charges, taxes, gratuity, cover charges
  - Items that are clearly none of the above

RULE: When in doubt between "others" and a food/drink category → CHOOSE the food/drink category.
NEVER use "others" for any alcoholic or non-alcoholic beverage.
NEVER use "others" for any food item.

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
  "subtotal": 61.40,
  "serviceCharge": 0,
  "taxAmount": 0,
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
- starters: pão, azeitonas, manteiga, queijo, paté, entrada, bread, olives, butter, cheese, soup, appetizer, bruschetta, nachos, wings, calamari, spring roll
- mains: bitoque, plumas, carne, peixe, arroz, massa, frango, hamburguer, burger, taco, tacos, pizza, pasta, chicken, steak, fish, sandwich, wrap, burrito, quesadilla, risotto, salmon, beef, pork, lamb, duck, schnitzel, noodles, curry, bowl
- drinks: refrigerante, água, cerveja, vinho, sumo, bebida, café, coffee, espresso, latte, cappuccino, americano, macchiato, flat white, tea, hot chocolate, beer, lager, ale, ipa, stout, porter, wine, cocktail, spirit, vodka, whiskey, whisky, rum, gin, tequila, smirnoff, baileys, prosecco, champagne, cider, mule, mojito, margarita, cosmopolitan, espresso martini, soda, juice, water, sparkling, cola, lemonade, smoothie, milkshake
- desserts: mousse, doce, pudim, gelado, tarte, sobremesa, cake, ice cream, cheesecake, brownie, tiramisu, profiteroles, churros, waffle, crepe, sundae, sorbet, panna cotta, creme brulee
- others: taxa, serviço, service charge, cover charge, tax, gratuity, tip, fee — ONLY surcharges, NEVER food or beverages

FINAL RULE: Before returning, verify all 4 quality checks above.
If any check fails → you made an error → look at the image again and fix it.
NEVER return data you are not confident about. Set confidence "low" and list warnings instead.`;

const STABLE_USER_PROMPT = `You are an expert receipt OCR system. Your output is used to split a restaurant bill between people — accuracy and correct categorization are critical.

STEP 1 — EXTRACT every paid item line from this receipt:
- Preserve item names EXACTLY as printed (no translation, no normalization)
- Each physical line = one item (unless the receipt's own Qty column shows > 1)
- quantity × unitPrice MUST equal totalPrice — verify before outputting
- Do NOT include tax lines, service charges, or subtotals as items[] entries (they go in taxAmount/serviceCharge)
- Portuguese IVA is already embedded in item prices (do not add as separate cost)

STEP 2 — CATEGORIZE each item using EXACTLY one of these 5 categories:

"drinks" — ANY beverage whatsoever:
  beer, lager, ale, IPA, stout, pint, draft, draught, cerveja, bière
  wine, vinho, prosecco, champagne, cider, espumante
  spirits: vodka, gin, rum, whiskey, tequila, baileys, aperol, smirnoff
  cocktails: mojito, margarita, negroni, cosmopolitan, spritz, mule, moscow mule
  brewery names as beer: Burdock, Mill Street, Molson, Heineken, Corona, Stella, Guinness, etc.
  soft drinks: cola, soda, juice, lemonade, water, água, sparkling, pepsi, sprite
  hot drinks: coffee, café, espresso, latte, cappuccino, americano, tea, chá, hot chocolate
  smoothies, milkshakes, kombucha — ANYTHING drinkable

"starters" — appetizers and first courses:
  bread, pão, olives, azeitonas, butter, manteiga, soup, sopa
  salad, salada, bruschetta, nachos, wings, calamari, garlic bread
  pâté, queijo, cheese board, spring rolls, dumplings, appetizer, entrada

"mains" — main dishes:
  burger, hamburguer, chicken, frango, pollo, steak, beef, carne, fish, peixe, salmon
  pasta, pizza, risotto, curry, bowl, sandwich, wrap, burrito, taco, tacos
  bitoque, plumas, bacalhau, arroz, massa, schnitzel, noodles, quesadilla, enchilada

"desserts" — sweet endings:
  cake, cheesecake, ice cream, gelado, mousse, brownie, tart, tarte
  tiramisu, profiteroles, churros, waffle, crepe, pudding, creme brulee

"others" — ONLY surcharges/fees (NOT food or drinks):
  service charge, taxa de serviço, cover charge, couvert
  Do NOT use "others" for any food or beverage item.

STEP 2.5 — DETECT CURRENCY and TAXES:

Currency — detect from symbols, city, and tax labels on the receipt:
  "CAD": C$, HST, GST, PST, or Canadian city (Toronto, Vancouver, Montreal, Calgary, Ottawa, etc.)
  "USD": $ with US city (New York, LA, Chicago, Miami, Houston, etc.) or no location clue
  "GBP": £ or UK city (London, Manchester, Edinburgh, etc.)
  "EUR": € or European country (France, Spain, Portugal, Italy, Germany, etc.)
  RULE: If receipt shows $ AND HST/GST → "CAD", not "USD"
  RULE: If only $ with no location → "USD"

Taxes (taxAmount) — ONLY extract explicitly shown tax lines:
  Canadian HST / GST / PST shown as a separate line → taxAmount = that amount
  US Sales Tax shown as a separate line → taxAmount = that amount
  Portuguese IVA (always embedded in item prices) → taxAmount: 0
  European VAT already included in menu prices → taxAmount: 0

Service charges (serviceCharge) — mandatory fees added by the restaurant:
  "Service Charge", "Auto Gratuity", "Large Party Fee", "Mandatory Gratuity" → serviceCharge = that amount
  Optional customer tip → do NOT include (not a service charge)

STEP 3 — OUTPUT this exact JSON (no markdown, no extra text):
{
  "restaurant": "exact name from top of receipt",
  "date": "YYYY-MM-DD",
  "currency": "CAD",
  "confidence": "high",
  "warnings": [],
  "items": [
    {
      "name": "Mill St Organic Lager LG",
      "quantity": 2,
      "unitPrice": 12.75,
      "totalPrice": 25.50,
      "category": "drinks"
    },
    {
      "name": "Pollo Tacos",
      "quantity": 1,
      "unitPrice": 20.75,
      "totalPrice": 20.75,
      "category": "mains"
    }
  ],
  "taxAmount": 22.20,
  "serviceCharge": 0,
  "itemsSubtotal": 170.75,
  "receiptTotal": 192.95,
  "item_count": 9,
  "validation": {
    "computedTotal": 170.75,
    "receiptTotal": 192.95,
    "difference": 22.20,
    "status": "ok"
  }
}

IMPORTANT: Replace ALL values above with the ACTUAL values from the receipt. The example shows a Canadian receipt — for a Portuguese receipt, currency would be "EUR" and taxAmount would be 0.`;

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
          { type: "text", text: STABLE_USER_PROMPT },
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
  const subtotalLogged = ocr.subtotal ?? ocr.itemsSubtotal ?? itemsSum;
  const receiptTotalLogged = ocr.validation?.receiptTotal ?? ocr.receiptTotal ?? subtotalLogged;
  console.log("=== VALIDATION ===");
  console.log("Items extracted:", (ocr.items ?? []).length, "| GPT item_count claim:", ocr.item_count ?? "(not provided)");
  console.log("Items sum (computed):", itemsSum.toFixed(2), "| Subtotal:", subtotalLogged.toFixed(2));
  if (Math.abs(itemsSum - subtotalLogged) > 0.50) {
    console.warn(`[OCR] ⚠️ Mismatch: items=$${itemsSum.toFixed(2)} vs subtotal=$${subtotalLogged.toFixed(2)} — diff=$${(subtotalLogged - itemsSum).toFixed(2)}`);
  }
  console.log("Service charge:", (ocr.serviceCharge ?? 0).toFixed(2), "| Tax:", (ocr.taxAmount ?? 0).toFixed(2));
  console.log("Receipt total:", receiptTotalLogged, "| Items vs subtotal diff:", (itemsSum - subtotalLogged).toFixed(4));
  console.log("Confidence:", ocr.confidence ?? "(not provided)");
  if (ocr.warnings?.length) console.log("GPT warnings:", ocr.warnings);
  console.log("Status:", ocr.validation?.status ?? "(not provided)");
  console.log("==================");

  return convertToAppFormat(ocr);
}

// Keep exported for any external consumers
export { USER_PROMPT as RECEIPT_PARSER_SYSTEM_PROMPT };
