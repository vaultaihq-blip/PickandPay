#!/usr/bin/env node
// scripts/export-finetuning-db.js
// Exports OCR corrections from Supabase into a JSONL fine-tuning dataset.
//
// Prerequisites:
//   SUPABASE_URL        — your project URL (or set in .env.local)
//   SUPABASE_SERVICE_KEY — service_role key (bypasses RLS)
//
// Usage:
//   SUPABASE_URL=https://xxx.supabase.co \
//   SUPABASE_SERVICE_KEY=eyJ... \
//   node scripts/export-finetuning-db.js

const fs   = require("fs");
const path = require("path");
const https = require("https");
const http  = require("http");

// ── Config ────────────────────────────────────────────────────────────────────

const SUPABASE_URL      = process.env.SUPABASE_URL      ?? "https://eoevulbjtpidskzoyfno.supabase.co";
const SERVICE_KEY       = process.env.SUPABASE_SERVICE_KEY ?? "";
const OUTPUT_FILE       = process.env.OUTPUT_FILE ?? path.join(__dirname, "../finetuning_from_db.jsonl");
const MIN_CORRECTIONS   = parseInt(process.env.MIN_CORRECTIONS ?? "1", 10); // include rows with ≥N corrections
const LIMIT             = parseInt(process.env.LIMIT ?? "1000", 10);

if (!SERVICE_KEY) {
  console.error("❌  Set SUPABASE_SERVICE_KEY environment variable.");
  process.exit(1);
}

const SYSTEM_PROMPT = `You are a receipt parser for a bill-splitting app. Analyze the receipt and return a JSON object with fields: restaurant, date, currency, tax_mode, printed_total, categories (starters/mains/drinks/desserts/others arrays), globalCosts, suggestedTips, validation. Keep all item names in their original language. Return only valid JSON.`;

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function fetchJson(url, headers) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    lib.get(url, { headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error(`Invalid JSON from ${url}: ${body.slice(0, 200)}`)); }
      });
    }).on("error", reject);
  });
}

function fetchBuffer(url, headers) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    lib.get(url, { headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
}

// ── Supabase REST helpers ─────────────────────────────────────────────────────

const REST_HEADERS = {
  "apikey": SERVICE_KEY,
  "Authorization": `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

async function queryCorrections() {
  const url = `${SUPABASE_URL}/rest/v1/ocr_corrections?select=*&order=created_at.asc&limit=${LIMIT}`;
  const rows = await fetchJson(url, { ...REST_HEADERS, "Accept": "application/json" });
  if (!Array.isArray(rows)) throw new Error(`Unexpected response: ${JSON.stringify(rows).slice(0, 300)}`);
  return rows;
}

async function downloadImage(storagePath) {
  if (!storagePath) return null;
  // storagePath is like "ocr-receipt-images/USER_ID/TIMESTAMP.jpg"
  // or just "USER_ID/TIMESTAMP.jpg" (inside the bucket)
  const normalised = storagePath.startsWith("ocr-receipt-images/")
    ? storagePath
    : `ocr-receipt-images/${storagePath}`;

  const signedUrl = `${SUPABASE_URL}/storage/v1/object/authenticated/${normalised}`;
  try {
    const buf = await fetchBuffer(signedUrl, {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
    });
    if (buf.length < 100) return null; // likely an error body, not an image
    return buf.toString("base64");
  } catch {
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("📥 Fetching corrections from Supabase…\n");

  const rows = await queryCorrections();
  console.log(`   Found ${rows.length} correction rows`);

  const eligible = rows.filter(
    (r) => Array.isArray(r.corrected_items) && r.corrected_items.length >= MIN_CORRECTIONS
  );
  console.log(`   Eligible (≥${MIN_CORRECTIONS} corrections): ${eligible.length}\n`);

  const examples = [];
  let skippedNoImage = 0;

  for (let i = 0; i < eligible.length; i++) {
    const row = eligible[i];
    process.stdout.write(`   Processing ${i + 1}/${eligible.length}…\r`);

    const base64 = await downloadImage(row.receipt_image_path);
    if (!base64) {
      skippedNoImage++;
      continue;
    }

    const { ocr_passes: _p, _raw, ...cleanOutput } = row.user_corrected_json ?? {};

    examples.push({
      messages: [
        { role: "system",    content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64}`, detail: "high" } },
            { type: "text",      text: "Parse this receipt and return the JSON structure." },
          ],
        },
        { role: "assistant", content: JSON.stringify(cleanOutput) },
      ],
    });
  }

  console.log(); // newline after \r progress

  const jsonl = examples.map((e) => JSON.stringify(e)).join("\n");
  fs.writeFileSync(OUTPUT_FILE, jsonl, "utf8");

  const sizeMB = (fs.statSync(OUTPUT_FILE).size / 1024 / 1024).toFixed(1);

  console.log(`\n✅ Fine-tuning dataset exported`);
  console.log(`   Examples        : ${examples.length}`);
  console.log(`   Skipped (no img): ${skippedNoImage}`);
  console.log(`   Output file     : ${OUTPUT_FILE}`);
  console.log(`   Size            : ${sizeMB} MB`);
  console.log(`\nNext steps:`);
  console.log(`   1. openai api files create --purpose fine-tune -f "${OUTPUT_FILE}"`);
  console.log(`   2. openai api fine_tuning.jobs create --training-file <FILE_ID> --model gpt-4o-mini-2024-07-18`);
  console.log(`   3. Set OPENAI_FINETUNED_MODEL in Supabase secrets once the job is done.\n`);
}

main().catch((err) => {
  console.error("\n❌ Export failed:", err.message);
  process.exit(1);
});
