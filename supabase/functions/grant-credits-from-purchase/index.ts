import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-revenuecat-secret, x-webhook-secret",
};

const PRODUCT_CREDITS: Record<string, number> = {
  bills_15: 15,
  bills_50: 50,
};

const ELIGIBLE_EVENTS = new Set(["INITIAL_PURCHASE", "NON_SUBSCRIPTION_PURCHASE"]);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // Verify webhook secret — RevenueCat can send it in any of these headers
  const webhookSecret = Deno.env.get("REVENUECAT_WEBHOOK_SECRET");
  const providedSecret =
    req.headers.get("x-revenuecat-secret") ??
    req.headers.get("x-webhook-secret") ??
    req.headers.get("Authorization");

  if (!providedSecret || providedSecret !== webhookSecret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response("Bad Request: invalid JSON", { status: 400, headers: CORS_HEADERS });
  }

  const event = body.event as Record<string, unknown> | undefined;
  if (!event) {
    return new Response("Bad Request: missing event", { status: 400, headers: CORS_HEADERS });
  }

  const eventType = event.type as string | undefined;
  const eventId = event.id as string | undefined;
  const productId = event.product_id as string | undefined;
  const appUserId = event.app_user_id as string | undefined;

  // Only process purchase events
  if (!eventType || !ELIGIBLE_EVENTS.has(eventType)) {
    return new Response(JSON.stringify({ received: true, processed: false, reason: "event_type_ignored" }), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  if (!eventId || !productId || !appUserId) {
    return new Response("Bad Request: missing event fields", { status: 400, headers: CORS_HEADERS });
  }

  const creditsToAdd = PRODUCT_CREDITS[productId];
  if (!creditsToAdd) {
    return new Response(
      JSON.stringify({ received: true, processed: false, reason: "unknown_product", product_id: productId }),
      { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // Idempotency guard — insert the event ID first.
  // If it already exists (code 23505), this delivery is a duplicate; return 200 silently.
  const { error: insertError } = await admin.from("credit_transactions").insert({
    revenuecat_event_id: eventId,
    user_id: appUserId,
    amount: creditsToAdd,
    product_id: productId,
  });

  if (insertError) {
    if (insertError.code === "23505") {
      // Duplicate delivery — idempotent, return success
      return new Response(
        JSON.stringify({ received: true, processed: false, reason: "duplicate_event" }),
        { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }
    console.error("[grant-credits] Failed to insert credit_transaction:", insertError);
    return new Response("Internal Server Error", { status: 500, headers: CORS_HEADERS });
  }

  // Grant credits via SECURITY DEFINER function (bypasses protect_sensitive_profile_fields trigger)
  const { data: newBalance, error: rpcError } = await admin.rpc("admin_grant_credits", {
    p_user_id: appUserId,
    p_amount: creditsToAdd,
  });

  if (rpcError) {
    console.error("[grant-credits] admin_grant_credits failed:", rpcError);
    // The transaction row is already inserted — on retry the idempotency guard will fire.
    // This means credits will NOT be double-granted even if the caller retries on 500.
    return new Response("Internal Server Error", { status: 500, headers: CORS_HEADERS });
  }

  console.log(`[grant-credits] Granted ${creditsToAdd} credits to ${appUserId}. New balance: ${newBalance}`);

  return new Response(
    JSON.stringify({ received: true, processed: true, credits_added: creditsToAdd, new_balance: newBalance }),
    { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
  );
});
