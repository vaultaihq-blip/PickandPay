import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL             = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY        = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const HIBP_API_KEY             = Deno.env.get("HIBP_API_KEY") ?? "";

// Sign-up credits are granted once per account by grant_signup_credits, which
// also defines the amount. handle_new_user already calls it when the account is
// created; this call is the redundant, idempotent path and records the HIBP
// result in the audit row (the database can't call HIBP itself).

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ── Email reputation via Have I Been Pwned ─────────────────────────────────────
// Returns:
//   isEstablished = true  → email appears in known breach data (real, old account)
//   isEstablished = false → email has never been seen in breaches (brand-new / disposable)
//   hibpStatus            → HTTP status returned by HIBP (for audit)

async function checkEmailReputation(
  email: string
): Promise<{ inBreaches: boolean; isEstablished: boolean; hibpStatus: number }> {
  if (!HIBP_API_KEY) {
    // No API key configured → can't check; default to established (don't punish users)
    console.log("[HIBP] No API key configured, defaulting to established");
    return { inBreaches: false, isEstablished: true, hibpStatus: 0 };
  }

  try {
    const resp = await fetch(
      `https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(email)}?truncateResponse=true`,
      {
        headers: {
          "User-Agent": "PickAndPay/1.0",
          "hibp-api-key": HIBP_API_KEY,
        },
      }
    );

    if (resp.status === 200) {
      return { inBreaches: true, isEstablished: true, hibpStatus: 200 };
    }
    if (resp.status === 404) {
      return { inBreaches: false, isEstablished: false, hibpStatus: 404 };
    }
    if (resp.status === 429) {
      // Rate-limited — wait 2s and retry once
      await new Promise(r => setTimeout(r, 2000));
      return checkEmailReputation(email);
    }

    // Any other error (401 bad key, 5xx, etc.) → safe default
    console.error("[HIBP] Unexpected status:", resp.status);
    return { inBreaches: false, isEstablished: true, hibpStatus: resp.status };
  } catch (err) {
    console.error("[HIBP] Fetch error:", err instanceof Error ? err.message : err);
    return { inBreaches: false, isEstablished: true, hibpStatus: 0 };
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: CORS_HEADERS });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return new Response("Unauthorized", { status: 401, headers: CORS_HEADERS });

  const token = authHeader.replace("Bearer ", "");
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // Verify caller identity
  const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: { user }, error: authError } = await anonClient.auth.getUser(token);
  if (authError || !user) {
    return new Response("Unauthorized", { status: 401, headers: CORS_HEADERS });
  }

  const userId = user.id;
  const email  = user.email ?? "";

  console.log(`[initialize-user-credits] Processing user ${userId} (${email})`);

  try {
    // ── 1. Check email reputation (audit only) ────────────────────────────────
    const reputation = await checkEmailReputation(email);
    console.log(
      `[initialize-user-credits] HIBP status=${reputation.hibpStatus} ` +
      `established=${reputation.isEstablished}`
    );

    // ── 2. Grant sign-up credits + write the audit row, once per account ──────
    const { data: result, error: rpcError } = await admin.rpc("grant_signup_credits", {
      p_user_id:        userId,
      p_email:          email,
      p_in_breaches:    reputation.inBreaches,
      p_is_established: reputation.isEstablished,
      p_hibp_status:    reputation.hibpStatus,
    });

    if (rpcError) {
      console.error("[initialize-user-credits] RPC error:", rpcError);
      return new Response(
        JSON.stringify({ error: "Failed to set credits" }),
        { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }

    const { status, credits_granted: creditsGranted, balance } = result as {
      status: "granted" | "already_granted";
      credits_granted: number;
      balance: number;
    };
    console.log(
      `[initialize-user-credits] ${status === "granted" ? `granted ${creditsGranted}` : "already granted at sign-up, nothing added"}, balance=${balance}`
    );

    return new Response(
      JSON.stringify({
        // What this account received at sign-up, whichever call granted it.
        freeCredits:    creditsGranted,
        alreadyGranted: status !== "granted",
        balance,
        isEstablished: reputation.isEstablished,
      }),
      { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("[initialize-user-credits]", msg);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }
});
