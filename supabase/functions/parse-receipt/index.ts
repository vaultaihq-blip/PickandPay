import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.24.3";

const SUPABASE_URL             = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY        = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_API_KEY           = Deno.env.get("OPENAI_API_KEY") ?? "";
const OPENAI_FINETUNED_MODEL   = Deno.env.get("OPENAI_FINETUNED_MODEL") ?? "";
const ANTHROPIC_API_KEY        = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MINDEE_API_KEY           = Deno.env.get("MINDEE_API_KEY") ?? "";
const VERYFI_CLIENT_ID         = Deno.env.get("VERYFI_CLIENT_ID") ?? "";
const VERYFI_USERNAME          = Deno.env.get("VERYFI_USERNAME") ?? "";
const VERYFI_API_KEY           = Deno.env.get("VERYFI_API_KEY") ?? "";

const RATE_LIMIT_MAX = 20;
const TOLERANCE      = 0.75;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SYSTEM_PROMPT = `You are a receipt parser. Analyze the receipt and return ONLY valid JSON with this exact structure:
{
  "restaurant": "name",
  "date": "YYYY-MM-DD",
  "currency": "USD",
  "printed_total": 12.50,
  "categories": {
    "starters": [{"id":"item_1","name":"Item Name","quantity":1,"unitPrice":5.00,"totalPrice":5.00}],
    "mains": [],
    "drinks": [],
    "desserts": [],
    "others": []
  },
  "globalCosts": [{"label":"Tax","amount":1.10}]
}
RULES:
- printed_total = the FINAL TOTAL printed on the receipt (not subtotal)
- SUBTOTAL lines are NOT items - EXCLUDE them from categories
- Every item needs totalPrice as a number
- EUR/GBP: VAT included in prices. USD/CAD: sales tax goes in globalCosts

MODIFIER / ADD-ON GROUPING (do this BEFORE outputting items — never emit a modifier as its own item):
- Pattern A — parent line has NO price, the line right below it HAS the price (the price belongs to the parent):
  "Pad Gra Prow" (no price) + "PGP Chicken   $23.00" → ONE item {"name":"Pad Gra Prow (PGP Chicken)","totalPrice":23.00}
- Pattern B — parent line HAS a price, an add-on line below it ALSO has a price → SUM both into the parent:
  "Green Curry  $25.00" + "Add Shrimp  $6.00" → ONE item {"name":"Green Curry (Add Shrimp)","totalPrice":31.00}
- Pattern C — several priced add-on lines under one parent → SUM ALL of them into the parent's totalPrice.
- A short, numeric, or unfamiliar-looking label (e.g. a bare "10", "Extra", "Add-on") that carries a PRICE is still a real charge — NEVER drop it. If it sits directly under a named item, fold its price into that item's totalPrice; if you truly cannot match it to a parent, keep it as its own item. Example: "Thai Chicken Wings  $13.50" then "10  $10.50" → ONE item {"name":"Thai Chicken Wings (10)","totalPrice":24.00}.
- Only lines with NO price at all (size, spice level, prep notes like "Medium", "Mild", "No Onion") are pure free modifiers — ignore those.

MANDATORY SELF-CHECK BEFORE RETURNING:
1. Sum every item's totalPrice in your output.
2. Compare that sum (+ any globalCosts) against printed_total.
3. If they don't match, you missed a priced line (often a modifier/add-on line under an item) or mis-grouped one — re-scan the receipt top to bottom, find it, and fix it before responding.`;

// ── Types ─────────────────────────────────────────────────────────────────────

type BuiltResult = {
  categories: Record<string, Record<string, unknown>[]>;
  globalCosts: Record<string, unknown>[];
  printedTotal: number;
  itemsSum: number;
  valid: boolean;
};

type Best = { parsed: Record<string, unknown>; built: BuiltResult; source: string; passes: number };

// ── Core helpers ──────────────────────────────────────────────────────────────

function buildFromParsed(parsed: Record<string, unknown>): BuiltResult {
  let idCounter = 0;
  const ensureIds = (items: Record<string, unknown>[]): Record<string, unknown>[] =>
    items.map(item => ({
      ...item,
      id: (item.id as string) || `item_${++idCounter}`,
      totalPrice: typeof item.totalPrice === "number" ? item.totalPrice : 0,
    }));

  const printedTotal =
    (typeof parsed.printed_total === "number" && parsed.printed_total > 0) ? parsed.printed_total :
    (typeof parsed.total === "number" && parsed.total > 0) ? parsed.total : 0;

  const cats = (parsed.categories ?? {}) as Record<string, Record<string, unknown>[]>;
  const flatItems = Array.isArray(parsed.items) ? (parsed.items as Record<string, unknown>[]) : [];
  const builtCats = {
    starters: ensureIds(cats.starters ?? []),
    mains:    ensureIds(cats.mains ?? []),
    drinks:   ensureIds(cats.drinks ?? []),
    desserts: ensureIds(cats.desserts ?? []),
    others:   ensureIds([
      ...flatItems.map(i => ({
        ...i,
        totalPrice: typeof i.totalPrice === "number" ? i.totalPrice :
                    typeof i.price === "number" ? (i.price as number) * (typeof i.quantity === "number" ? (i.quantity as number) : 1) : 0,
      })),
      ...(cats.others ?? []),
    ]),
  };

  const itemsSum = Object.values(builtCats).flat()
    .reduce((s, i) => s + (typeof i.totalPrice === "number" ? i.totalPrice : 0), 0);
  const costsSum = ((parsed.globalCosts ?? []) as Record<string, unknown>[])
    .reduce((s, c) => s + (typeof c.amount === "number" ? c.amount : 0), 0);
  const valid = Math.abs(itemsSum + costsSum - printedTotal) <= TOLERANCE;

  return { categories: builtCats, globalCosts: (parsed.globalCosts ?? []) as Record<string, unknown>[], printedTotal, itemsSum, valid };
}

function categorizeItem(name: string): "starters" | "mains" | "drinks" | "desserts" | "others" {
  const n = name.toLowerCase();
  if (/drink|coke|pepsi|water|wine|beer|coffee|tea|juice|soda|cocktail|martini|margarita|mojito|whisky|vodka|gin|rum|bottle|glass|cerveja|vinho|agua|sumo|café|chá/.test(n)) return "drinks";
  if (/dessert|cake|ice cream|sorbet|tiramisu|pie|cheesecake|sobremesa|bolo|gelado/.test(n)) return "desserts";
  if (/starter|appetizer|soup|salad|bruschetta|entrada|sopa|salada/.test(n)) return "starters";
  if (/steak|burger|pizza|pasta|chicken|fish|sushi|sandwich|wrap|taco|burrito|rice|noodle|prato|carne|peixe|frango/.test(n)) return "mains";
  return "others";
}

// ── Pass 1-5: API-based vision ────────────────────────────────────────────────

async function callOpenAIVision(imageUrl: string, model: string): Promise<Record<string, unknown> | null> {
  if (!OPENAI_API_KEY) return null;
  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: [
            { type: "image_url", image_url: { url: imageUrl, detail: "high" } },
            { type: "text", text: "Parse this receipt. Return JSON with the exact structure from the system prompt. printed_total must be the final total printed on the receipt." },
          ] },
        ],
        max_tokens: 4000,
        temperature: 0,
        response_format: { type: "json_object" },
      }),
    });
    if (!resp.ok) { console.error(`[${model}] HTTP ${resp.status}`); return null; }
    const data = await resp.json();
    return JSON.parse((data.choices?.[0]?.message as { content: string })?.content || "{}");
  } catch (e) {
    console.error(`[${model}] Error:`, e instanceof Error ? e.message : e);
    return null;
  }
}

async function retryWithHints(
  imageUrl: string,
  model: string,
  prev: { itemsSum: number; printedTotal: number; itemNames: string[] },
): Promise<Record<string, unknown> | null> {
  if (!OPENAI_API_KEY || prev.printedTotal <= 0) return null;
  const diff = prev.itemsSum - prev.printedTotal;
  if (Math.abs(diff) <= TOLERANCE) return null;

  const hint = diff > 0
    ? `OVER by $${diff.toFixed(2)}: check for subtotal lines counted as items, modifiers as separate items, or discounted items at full price. Previous items: ${prev.itemNames.join(", ")}`
    : `UNDER by $${Math.abs(diff).toFixed(2)}: you likely missed a priced modifier/add-on line sitting directly under an item (e.g. a bare number or short label like "10" or "Extra" that still carries a price) and failed to fold it into that item's totalPrice — re-check every item's neighboring lines for an unaccounted price first. Also check for service charges, gratuity, auto-grat, cover charges, couvert, or items in small font at top/bottom. Previous items: ${prev.itemNames.join(", ")}`;

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: [
            { type: "image_url", image_url: { url: imageUrl, detail: "high" } },
            { type: "text", text: `Re-parse this receipt. Previous parse was ${hint}\n\nFix the issue. items + globalCosts MUST equal printed_total exactly.` },
          ] },
        ],
        max_tokens: 4000,
        temperature: 0.1,
        response_format: { type: "json_object" },
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return JSON.parse((data.choices?.[0]?.message as { content: string })?.content || "{}");
  } catch { return null; }
}

async function callClaudeVision(imageBase64: string, model: string): Promise<Record<string, unknown> | null> {
  if (!ANTHROPIC_API_KEY) return null;
  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const base64Data = imageBase64.startsWith("data:") ? imageBase64.split(",")[1] : imageBase64;
    const msg = await client.messages.create({
      model,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64Data } },
          { type: "text", text: "Parse this receipt. Return JSON with the exact structure from the system prompt. printed_total must be the final total printed on the receipt." },
        ],
      }],
    });
    const text = (msg.content[0] as { type: string; text: string }).text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    return JSON.parse(jsonMatch?.[0] ?? text);
  } catch (e) {
    console.error(`[Claude ${model}] Error:`, e instanceof Error ? e.message : e);
    return null;
  }
}

// ── Pass 6: Veryfi ────────────────────────────────────────────────────────────

interface VeryfiLineItem { description?: string; quantity?: number; unit_price?: number; price?: number; total?: number; type?: string; }
interface VeryfiResponse { vendor?: { name?: string }; date?: string; currency_code?: string; total?: number; tax?: number; line_items?: VeryfiLineItem[]; }

async function parseWithVeryfi(base64: string): Promise<Record<string, unknown> | null> {
  if (!VERYFI_CLIENT_ID || !VERYFI_USERNAME || !VERYFI_API_KEY) return null;
  try {
    const resp = await fetch("https://api.veryfi.com/api/v8/partner/documents/", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "CLIENT-ID": VERYFI_CLIENT_ID,
        "AUTHORIZATION": `apikey ${VERYFI_USERNAME}:${VERYFI_API_KEY}`,
      },
      body: JSON.stringify({ file_data: base64, file_name: "receipt.jpg" }),
    });
    if (!resp.ok) { console.error("[Veryfi] HTTP", resp.status); return null; }
    const data = await resp.json() as VeryfiResponse;

    const items = (data.line_items ?? [])
      .filter(li => li.type !== "tax" && li.type !== "tip")
      .map((li, idx) => ({
        id: `veryfi_${idx + 1}`,
        name: li.description ?? "Item",
        quantity: li.quantity ?? 1,
        unitPrice: li.unit_price ?? li.price ?? li.total ?? 0,
        totalPrice: li.total ?? li.price ?? ((li.unit_price ?? 0) * (li.quantity ?? 1)),
      }));
    const categories: Record<string, Record<string, unknown>[]> = { starters: [], mains: [], drinks: [], desserts: [], others: [] };
    for (const item of items) categories[categorizeItem(item.name)].push(item);
    const globalCosts: Record<string, unknown>[] = [];
    if (data.tax && data.tax > 0) globalCosts.push({ label: "Tax", amount: data.tax });

    return { restaurant: data.vendor?.name ?? "Unknown", date: data.date ?? "", currency: data.currency_code ?? "USD", printed_total: data.total ?? 0, categories, globalCosts };
  } catch (e) {
    console.error("[Veryfi] Error:", e instanceof Error ? e.message : e);
    return null;
  }
}

// ── Pass 7: Mindee ────────────────────────────────────────────────────────────

interface MindeeLineItem { description?: string; quantity?: number; unit_price?: number; total_amount?: number; }
interface MindeeResponse {
  document?: { inference?: { prediction?: {
    supplier_name?: { value?: string };
    date?: { value?: string };
    locale?: { currency?: string };
    total_amount?: { value?: number };
    total_tax?: { value?: number };
    line_items?: MindeeLineItem[];
  }; }; };
}

async function parseWithMindee(base64: string): Promise<Record<string, unknown> | null> {
  if (!MINDEE_API_KEY) return null;
  try {
    const formData = new FormData();
    const binary = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    formData.append("document", new Blob([binary], { type: "image/jpeg" }), "receipt.jpg");
    const resp = await fetch("https://api.mindee.net/v1/products/mindee/expense_receipts/v5/predict", {
      method: "POST",
      headers: { "Authorization": `Token ${MINDEE_API_KEY}` },
      body: formData,
    });
    if (!resp.ok) { console.error("[Mindee] HTTP", resp.status); return null; }
    const data = await resp.json() as MindeeResponse;
    const pred = data.document?.inference?.prediction;
    if (!pred) return null;

    const items = (pred.line_items ?? []).map((li, idx) => ({
      id: `mindee_${idx + 1}`,
      name: li.description ?? "Item",
      quantity: li.quantity ?? 1,
      unitPrice: li.unit_price ?? li.total_amount ?? 0,
      totalPrice: li.total_amount ?? ((li.unit_price ?? 0) * (li.quantity ?? 1)),
    }));
    const categories: Record<string, Record<string, unknown>[]> = { starters: [], mains: [], drinks: [], desserts: [], others: [] };
    for (const item of items) categories[categorizeItem(item.name)].push(item);
    const globalCosts: Record<string, unknown>[] = [];
    if (pred.total_tax?.value && pred.total_tax.value > 0) globalCosts.push({ label: "Tax", amount: pred.total_tax.value });

    return { restaurant: pred.supplier_name?.value ?? "Unknown", date: pred.date?.value ?? "", currency: pred.locale?.currency ?? "USD", printed_total: pred.total_amount?.value ?? 0, categories, globalCosts };
  } catch (e) {
    console.error("[Mindee] Error:", e instanceof Error ? e.message : e);
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return new Response("Unauthorized", { status: 401, headers: CORS_HEADERS });

  const token = authHeader.replace("Bearer ", "");
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  let userId: string;
  const isServiceRole = (() => {
    try { return JSON.parse(atob(token.split(".")[1])).role === "service_role"; }
    catch { return false; }
  })();

  if (isServiceRole) {
    userId = "batch-test-internal";
  } else {
    const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data: { user }, error } = await anonClient.auth.getUser(token);
    if (error || !user) return new Response("Unauthorized", { status: 401, headers: CORS_HEADERS });
    userId = user.id;
    const { count } = await admin.from("ocr_requests").select("id", { count: "exact", head: true })
      .eq("user_id", userId).gte("created_at", new Date(Date.now() - 3600000).toISOString());
    if ((count ?? 0) >= RATE_LIMIT_MAX) {
      return new Response(JSON.stringify({ error: "Rate limit exceeded" }), { status: 429, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }
    await admin.from("ocr_requests").insert({ user_id: userId });
  }

  let imageBase64: string;
  try {
    const body = await req.json() as { imageBase64?: string };
    imageBase64 = body.imageBase64 ?? "";
  } catch {
    return new Response("Bad Request", { status: 400, headers: CORS_HEADERS });
  }
  if (!imageBase64) {
    return new Response(JSON.stringify({ error: "Missing imageBase64" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }

  try {
    const imageUrl = imageBase64.startsWith("data:") ? imageBase64 : `data:image/jpeg;base64,${imageBase64}`;
    let best: Best | null = null;

    const tryUpdate = (parsed: Record<string, unknown> | null, source: string, passes: number): boolean => {
      if (!parsed) return false;
      const built = buildFromParsed(parsed);
      // Skip results where all items have zero price but a total exists — indicates a parse failure
      if (built.itemsSum === 0 && built.printedTotal > 1) {
        console.log(`[Pipeline] ${source}: ⚠️  skipped (items parsed but all prices are 0)`);
        return false;
      }
      const diff = Math.abs(built.itemsSum - built.printedTotal);
      console.log(`[Pipeline] ${source}: ${built.valid ? "✅ VALID" : `❌ diff=${diff.toFixed(2)}`}`);
      if (!best || built.valid || diff < Math.abs(best.built.itemsSum - best.built.printedTotal)) {
        best = { parsed, built, source, passes };
      }
      return built.valid;
    };

    // Pass 1 — Fine-tuned model (optional, €0 marginal after training cost)
    if (OPENAI_FINETUNED_MODEL && OPENAI_API_KEY) {
      console.log(`[Pipeline] Pass 1: Fine-tuned (${OPENAI_FINETUNED_MODEL})...`);
      if (tryUpdate(await callOpenAIVision(imageUrl, OPENAI_FINETUNED_MODEL), "finetuned", 1)) {
        return buildResponse(best!);
      }
    }

    // Pass 2 — GPT-4o-mini vision (~€0.0002, 15× cheaper than GPT-4o)
    if (!best?.built.valid && OPENAI_API_KEY) {
      console.log("[Pipeline] Pass 2: GPT-4o-mini...");
      if (tryUpdate(await callOpenAIVision(imageUrl, "gpt-4o-mini"), "gpt4o_mini", 2)) {
        return buildResponse(best!);
      }
    }

    // Pass 3 — GPT-4o vision (~€0.004, high accuracy)
    if (!best?.built.valid && OPENAI_API_KEY) {
      console.log("[Pipeline] Pass 3: GPT-4o...");
      if (tryUpdate(await callOpenAIVision(imageUrl, "gpt-4o"), "gpt4o", 3)) {
        return buildResponse(best!);
      }
    }

    // Pass 4 — GPT-4o retry with directional hints
    if (!best?.built.valid && OPENAI_API_KEY && best) {
      const allItems = Object.values(best.built.categories).flat();
      const itemNames = allItems.map(i => (i as { name?: string }).name ?? "").filter(Boolean).slice(0, 15);
      console.log("[Pipeline] Pass 4: GPT-4o retry with hints...");
      if (tryUpdate(
        await retryWithHints(imageUrl, "gpt-4o", { itemsSum: best.built.itemsSum, printedTotal: best.built.printedTotal, itemNames }),
        "gpt4o_retry",
        4,
      )) {
        return buildResponse(best!);
      }
    }

    // Pass 5 — Claude Haiku 4.5 vision (~€0.0007, different vendor as fallback)
    if (!best?.built.valid && ANTHROPIC_API_KEY) {
      console.log("[Pipeline] Pass 5: Claude Haiku...");
      if (tryUpdate(await callClaudeVision(imageBase64, "claude-haiku-4-5-20251001"), "claude_haiku", 5)) {
        return buildResponse(best!);
      }
    }

    // Pass 6 — Veryfi (specialized receipt OCR)
    if (!best?.built.valid && VERYFI_CLIENT_ID && VERYFI_API_KEY) {
      console.log("[Pipeline] Pass 6: Veryfi...");
      if (tryUpdate(await parseWithVeryfi(imageBase64), "veryfi", 6)) {
        return buildResponse(best!);
      }
    }

    // Pass 7 — Mindee (specialized receipt OCR, last resort)
    if (!best?.built.valid && MINDEE_API_KEY) {
      console.log("[Pipeline] Pass 7: Mindee...");
      tryUpdate(await parseWithMindee(imageBase64), "mindee", 7);
    }

    if (!best) {
      return new Response(
        JSON.stringify({ error: "All 7 methods failed", source: "none" }),
        { status: 422, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    return buildResponse(best);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("[parse-receipt]", msg);
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }
});

function buildResponse(b: Best): Response {
  const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  console.log(`[Pipeline] ✅ Final result via ${b.source} (passes=${b.passes})`);
  return new Response(
    JSON.stringify({
      ...b.parsed,
      printed_total: b.built.printedTotal,
      categories:    b.built.categories,
      globalCosts:   b.built.globalCosts,
      ocr_passes:    b.passes,
      source:        b.source,
      validation: {
        receiptTotal:  b.built.printedTotal,
        computedTotal: b.built.itemsSum,
        difference:    Math.abs(b.built.itemsSum - b.built.printedTotal),
        status:        b.built.valid ? "ok" : "mismatch",
      },
    }),
    { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
  );
}
