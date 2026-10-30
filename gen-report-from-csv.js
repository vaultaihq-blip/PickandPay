// Gera report.html filtrado (erros only) a partir do CSV existente
const fs   = require("fs");
const path = require("path");

const OUTPUT_DIR = "C:\\Users\\ricar\\Pictures\\Vault AI\\PickPay\\Faturas\\results";
const { generateReport } = require("./batch-ocr-test.js");

const csv = fs.readFileSync(path.join(OUTPUT_DIR, "results.csv"), "utf8").trim().split("\n");
const results = csv.slice(1).map((line) => {
  const p = []; let c = "", q = false;
  for (const ch of line) {
    if (ch === '"') { q = !q; continue; }
    if (ch === "," && !q) { p.push(c); c = ""; continue; }
    c += ch;
  }
  p.push(c);
  return {
    id: p[0], image_name: p[1], ocr_sum: p[2], printed_total: p[3],
    difference: p[4], status: p[5], ocr_passes: parseInt(p[6]) || 1,
    currency: p[7], item_count: parseInt(p[8]) || 0, restaurant: p[9], error: p[10],
  };
});

generateReport(results, OUTPUT_DIR);
