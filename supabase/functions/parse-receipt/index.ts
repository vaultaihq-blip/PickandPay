import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";

const SYSTEM_PROMPT = `You are a receipt parser for a bill-splitting app. Analyze the receipt image and return a JSON object following this exact structure. Detect the language of the receipt and keep all item names in their ORIGINAL language. Categorize items as: starters (bread, olives, butter, cheese, pate), mains (meat, fish, burgers, pasta, rice dishes, menus/combos), drinks (water, soda, beer, wine, coffee drinks), desserts (cakes, puddings, ice cream, sweet items), others (coffee, taxes, fees). For global costs extract: tax, HST, service charge, delivery fees, bag fees, plastic fees. For modifiers with no price (SEM/SIN/NO/WITHOUT/Mild/etc) add them as notes to the previous item, never as separate items. For combos/menus group components under the main item. Return ONLY valid JSON, no markdown.

The JSON must match this structure:
{
  "restaurant": "string",
  "date": "ISO date string or null",
  "currency": "EUR|USD|CAD|GBP",
  "peopleCountDetected": number or null,
  "categories": {
    "starters": [ReceiptItem],
    "mains": [ReceiptItem],
    "drinks": [ReceiptItem],
    "desserts": [ReceiptItem],
    "others": [ReceiptItem]
  },
  "globalCosts": [GlobalCost],
  "suggestedTips": [{"percentage": number, "amount": number}],
  "tipStatus": "pending|accepted|removed|modified|null",
  "selectedTip": number or null,
  "validation": {
    "receiptTotal": number,
    "computedTotal": number,
    "difference": number,
    "status": "ok|warning|error"
  }
}

ReceiptItem: {
  "id": "unique string",
  "name": "string (keep original language)",
  "category": "starters|mains|drinks|desserts|others",
  "quantity": number,
  "unitPrice": number,
  "totalPrice": number,
  "type": "individual|quantity|shareable|combo|group",
  "notes": ["string"] or null,
  "components": [ReceiptItem] or null,
  "addOns": [ReceiptItem] or null,
  "confidence": 0-1,
  "warnings": ["string"] or null
}

GlobalCost: {
  "id": "unique string",
  "name": "string",
  "amount": number,
  "type": "tax|service_charge|mandatory_service|delivery|bag|plastic|other",
  "splitByAll": true,
  "editable": boolean,
  "status": "included|suggested|mandatory|manual"
}`;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const { image } = await req.json() as { image: string };

    if (!image) {
      return new Response(
        JSON.stringify({ error: "Missing image field" }),
        { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }

    if (!OPENAI_API_KEY) {
      return new Response(
        JSON.stringify({ error: "OpenAI API key not configured" }),
        { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }

    // Ensure the image is in the correct data URL format
    const imageUrl = image.startsWith("data:")
      ? image
      : `data:image/jpeg;base64,${image}`;

    const openAIResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: SYSTEM_PROMPT,
          },
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: {
                  url: imageUrl,
                  detail: "high",
                },
              },
              {
                type: "text",
                text: "Parse this receipt and return the JSON structure as described. Keep all item names in their original language.",
              },
            ],
          },
        ],
        max_tokens: 4000,
        temperature: 0.1,
        response_format: { type: "json_object" },
      }),
    });

    if (!openAIResponse.ok) {
      const errText = await openAIResponse.text();
      throw new Error(`OpenAI API error: ${openAIResponse.status} — ${errText}`);
    }

    const openAIData = await openAIResponse.json();
    const content = openAIData.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error("No content returned from OpenAI");
    }

    // Parse and validate the JSON
    const parsed = JSON.parse(content);

    // Ensure required fields exist
    if (!parsed.restaurant || !parsed.categories) {
      throw new Error("Invalid receipt structure returned");
    }

    // Ensure IDs are unique
    let idCounter = 0;
    const ensureIds = (items: Record<string, unknown>[]) => {
      return items.map((item) => ({
        ...item,
        id: (item.id as string) || `item_${++idCounter}`,
        components: item.components
          ? ensureIds(item.components as Record<string, unknown>[])
          : undefined,
        addOns: item.addOns
          ? ensureIds(item.addOns as Record<string, unknown>[])
          : undefined,
      }));
    };

    const result = {
      ...parsed,
      categories: {
        starters: ensureIds(parsed.categories?.starters ?? []),
        mains: ensureIds(parsed.categories?.mains ?? []),
        drinks: ensureIds(parsed.categories?.drinks ?? []),
        desserts: ensureIds(parsed.categories?.desserts ?? []),
        others: ensureIds(parsed.categories?.others ?? []),
      },
      globalCosts: (parsed.globalCosts ?? []).map((gc: Record<string, unknown>) => ({
        ...gc,
        id: (gc.id as string) || `gc_${++idCounter}`,
        splitByAll: true,
      })),
    };

    return new Response(JSON.stringify(result), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[parse-receipt]", message);
    return new Response(
      JSON.stringify({ error: message }),
      {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      }
    );
  }
});
