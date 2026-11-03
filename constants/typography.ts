import { Platform } from "react-native";

// D.2 (04-11-2026) — the one monospaced font of the receipt (names and
// amounts), on every screen that shows a receipt. Buttons and interface text
// use the app's font.
export const RECEIPT_MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });
