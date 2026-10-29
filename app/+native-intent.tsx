// Links from outside the app — the session QR read by the phone's camera, a
// shared pickandpay://session/<id> or https://…/session/<id> — open the R7
// entry screen, which asks the server (join_preview) what to show. There is
// no session/[id] screen any more.
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    const match = path.match(/(?:^|\/)session\/([a-zA-Z0-9-]+)(?=[/?#]|$)/);
    if (match && match[1] !== "join") {
      console.log(`[deeplink] session link → entry screen (${match[1]})`);
      return `/session/join?sessionId=${match[1]}`;
    }
  } catch {
    // Unreadable link: let the router handle it as it is.
  }
  return path;
}
