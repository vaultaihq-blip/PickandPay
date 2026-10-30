import { Redirect, useLocalSearchParams } from "expo-router";

// A direct /session/<id> address (the web site, where no deep-link listener
// runs) goes to the R7 entry screen, which asks the server (join_preview)
// what to show. On native the same links are rewritten earlier, in
// app/+native-intent.tsx. "join" is its own static route and never lands here.
export default function SessionLinkRedirect() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const sessionId = typeof id === "string" && /^[a-zA-Z0-9-]+$/.test(id) ? id : "";
  return <Redirect href={sessionId ? `/session/join?sessionId=${sessionId}` : "/session/join"} />;
}
