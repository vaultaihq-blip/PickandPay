#!/usr/bin/env node
// scripts/prepare-finetuning.js
// Prepara dataset de fine-tuning usando APENAS recibos correctos (diff < 0.50)
// Uso: node scripts/prepare-finetuning.js

const fs   = require("fs");
const path = require("path");

const RECEIPTS_DIR = "C:\\Users\\ricar\\Pictures\\Vault AI\\PickPay\\Faturas\\results";
const OUTPUT_FILE  = "C:\\Users\\ricar\\Pictures\\Vault AI\\PickPay\\Faturas\\finetuning_dataset.jsonl";
const DIFF_THRESHOLD = 0.50; // só exemplos com extracção correcta

const SYSTEM_PROMPT = `You are a receipt parser for a bill-splitting app. Analyze the receipt and return a JSON object with fields: restaurant, date, currency, tax_mode, printed_total, categories (starters/mains/drinks/desserts/others arrays), globalCosts, suggestedTips, validation. Keep all item names in their original language. Return only valid JSON.`;

function calcDiff(jsonData) {
  const cats = jsonData.categories ?? {};
  const itemsSum = Object.values(cats).flat()
    .reduce((s, i) => s + (typeof i.totalPrice === "number" ? i.totalPrice : 0), 0);
  const costsSum = (jsonData.globalCosts ?? [])
    .reduce((s, c) => s + (typeof c.amount === "number" ? c.amount : 0), 0);
  const computed = Math.round((itemsSum + costsSum) * 100) / 100;
  const printed  = typeof jsonData.printed_total === "number" ? jsonData.printed_total : 0;
  return { diff: Math.abs(computed - printed), printed };
}

async function prepareDataset() {
  console.log("Preparando dataset para fine-tuning (only correct receipts)...\n");

  const jsonFiles = fs.readdirSync(RECEIPTS_DIR)
    .filter(f => f.endsWith("_receipt.json"))
    .sort();

  const examples = [];
  let skippedError = 0, skippedNoImg = 0;

  for (const jsonFile of jsonFiles) {
    const imgFile  = jsonFile.replace(".json", ".jpg");
    const jsonPath = path.join(RECEIPTS_DIR, jsonFile);
    const imgPath  = path.join(RECEIPTS_DIR, imgFile);

    if (!fs.existsSync(imgPath)) { skippedNoImg++; continue; }

    let jsonData;
    try { jsonData = JSON.parse(fs.readFileSync(jsonPath, "utf8")); }
    catch { skippedError++; continue; }

    const { diff, printed } = calcDiff(jsonData);

    // Só incluir recibos correctos com total conhecido
    if (printed === 0 || diff >= DIFF_THRESHOLD) {
      skippedError++;
      continue;
    }

    const imageBase64 = fs.readFileSync(imgPath).toString("base64");

    // Remover campos internos do output de treino
    const { ocr_passes, _raw, ...cleanJson } = jsonData;

    examples.push({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}`, detail: "high" } },
            { type: "text",      text: "Parse this receipt and return the JSON structure." },
          ],
        },
        { role: "assistant", content: JSON.stringify(cleanJson) },
      ],
    });

    if (examples.length % 20 === 0) {
      process.stdout.write(`  ${examples.length} exemplos OK...\r`);
    }
  }

  const jsonl = examples.map(e => JSON.stringify(e)).join("\n");
  fs.writeFileSync(OUTPUT_FILE, jsonl);

  const sizeMB = (fs.statSync(OUTPUT_FILE).size / 1024 / 1024).toFixed(1);

  console.log(`\nDataset pronto!`);
  console.log(`  Exemplos de treino : ${examples.length} (de ${jsonFiles.length} recibos)`);
  console.log(`  Descartados (erro) : ${skippedError}`);
  console.log(`  Sem imagem         : ${skippedNoImg}`);
  console.log(`  Ficheiro           : ${OUTPUT_FILE}`);
  console.log(`  Tamanho            : ${sizeMB} MB`);
  console.log(`\nAVISO: fine-tuning com imagens requer gpt-4o-mini-2024-07-18 ou superior.`);
  console.log(`GPT-4o vision fine-tuning pode nao estar disponivel na tua conta.\n`);
  console.log(`Proximo passo:`);
  console.log(`  openai api files create --purpose fine-tune -f "${OUTPUT_FILE}"`);
}

prepareDataset().catch(console.error);
