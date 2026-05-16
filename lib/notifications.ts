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
  const { data: userData } = await supabase
    .from("profiles")
    .select("push_token")
    .eq("id", to)
    .single();

  const token = (userData as Record<string, unknown> | null)?.push_token as string | undefined;
  if (!token) throw new Error("User has no push token registered.");

  const response = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ to: token, title, body, data }),
  });

  if (!response.ok) {
    const err = await response.text().catch(() => "");
    throw new Error(`Push send failed: ${err}`);
  }
}
