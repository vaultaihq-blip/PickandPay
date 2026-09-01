import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // ── Extract and verify JWT ─────────────────────────────────────────────────
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Unauthorized" }, 401);

  const token = authHeader.replace("Bearer ", "");

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token);
  if (userError || !user) return json({ error: "Unauthorized" }, 401);

  const userId = user.id;
  console.log(`[delete-account] Starting deletion for user ${userId}`);

  // ── a. Delete session_participants ─────────────────────────────────────────
  const { error: participantsError } = await supabaseAdmin
    .from("session_participants")
    .delete()
    .eq("user_id", userId);

  if (participantsError) {
    console.error("[delete-account] Failed to delete session_participants:", participantsError);
    return json({ error: "Failed to delete session data" }, 500);
  }

  // ── b. Close active sessions hosted by user; delete inactive ones ──────────
  const { error: closeError } = await supabaseAdmin
    .from("sessions")
    .update({ status: "closed" })
    .eq("host_id", userId)
    .eq("status", "active");

  if (closeError) {
    console.error("[delete-account] Failed to close active sessions:", closeError);
    return json({ error: "Failed to update active sessions" }, 500);
  }

  const { error: deleteSessionsError } = await supabaseAdmin
    .from("sessions")
    .delete()
    .eq("host_id", userId)
    .neq("status", "active");

  if (deleteSessionsError) {
    console.error("[delete-account] Failed to delete sessions:", deleteSessionsError);
    return json({ error: "Failed to delete sessions" }, 500);
  }

  // ── c. Delete push tokens ──────────────────────────────────────────────────
  // Ignore errors — table may not exist in all environments
  await supabaseAdmin.from("user_push_tokens").delete().eq("user_id", userId);

  // ── d. Delete avatar from storage ─────────────────────────────────────────
  // Ignore errors — avatar may not exist
  await supabaseAdmin.storage.from("avatars").remove([userId]);

  // ── e. Delete profile row ──────────────────────────────────────────────────
  const { error: profileError } = await supabaseAdmin
    .from("profiles")
    .delete()
    .eq("id", userId);

  if (profileError) {
    console.error("[delete-account] Failed to delete profile:", profileError);
    return json({ error: "Failed to delete profile" }, 500);
  }

  // ── f. Delete auth user ────────────────────────────────────────────────────
  const { error: authDeleteError } = await supabaseAdmin.auth.admin.deleteUser(userId);

  if (authDeleteError) {
    console.error("[delete-account] Failed to delete auth user:", authDeleteError);
    return json({ error: "Failed to delete auth user" }, 500);
  }

  console.log(`[delete-account] Successfully deleted user ${userId}`);
  return json({ success: true });
});
