import { supabase } from "@/lib/supabase";

export async function sendPushNotification({
  to,
  title,
  body,
  data,
}: {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}): Promise<void> {
  const { data: rows } = await supabase
    .from("user_push_tokens")
    .select("token")
    .eq("user_id", to);

  const tokens = (rows as Array<{ token: string }> | null)?.map((r) => r.token) ?? [];
  if (tokens.length === 0) throw new Error("User has no push token registered.");

  const response = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(tokens.map((token) => ({ to: token, title, body, data }))),
  });

  if (!response.ok) {
    const err = await response.text().catch(() => "");
    throw new Error(`Push send failed: ${err}`);
  }
}
