/**
 * TEMPORARY tool — captures Google Vision's raw DOCUMENT_TEXT_DETECTION
 * response for a local image and saves it verbatim as a test fixture.
 * Not part of the pipeline; local/manual use only.
 *
 * Usage:
 *   GOOGLE_CLOUD_API_KEY=... npx tsx scripts/fetch-vision-fixture.ts <image path> <fixture output path>
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { callGoogleVision } from "../supabase/functions/parse-receipt/ocr";

/** Same loader as debug-parse-receipt.ts — never logs a value. */
function loadEnvLocal(): void {
  const envPath = join(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key && value && !(key in process.env)) process.env[key] = value;
  }
}

async function main() {
  loadEnvLocal();
  const imagePath = process.argv[2];
  const outputPath = process.argv[3];
  if (!imagePath || !outputPath) {
    console.error("Usage: GOOGLE_CLOUD_API_KEY=... npx tsx scripts/fetch-vision-fixture.ts <image path> <fixture output path>");
    process.exit(1);
  }
  const apiKey = process.env.GOOGLE_CLOUD_API_KEY ?? "";
  if (!apiKey) {
    console.error("Missing GOOGLE_CLOUD_API_KEY in the environment.");
    process.exit(1);
  }
  const base64Content = readFileSync(imagePath).toString("base64");
  const raw = await callGoogleVision(apiKey, base64Content, ["pt", "en", "es", "fr", "zh"]);
  writeFileSync(outputPath, JSON.stringify(raw, null, 2), "utf-8");
  console.log(`Fixture written to: ${outputPath}`);
}

main().catch((err) => {
  console.error("Failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
