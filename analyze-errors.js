const fs = require("fs");
const path = require("path");

const RESULTS_DIR = "./batch_results";

if (!fs.existsSync(RESULTS_DIR)) {
  console.error(`❌ Directory not found: ${RESULTS_DIR}`);
  process.exit(1);
}

const files = fs.readdirSync(RESULTS_DIR)
  .filter(f => f.endsWith("_receipt.json"))
  .sort();

console.log(`📂 Encontrados ${files.length} recibos\n`);

const results = [];
const erroredReceipts = [];

for (const file of files) {
  try {
    const filePath = path.join(RESULTS_DIR, file);
    const json = JSON.parse(fs.readFileSync(filePath, "utf8"));

    const allItems = [];
    if (json.categories) {
      Object.values(json.categories).forEach(itemsArray => {
        if (Array.isArray(itemsArray)) {
          itemsArray.forEach(item => {
            if (item && item.name && typeof item.totalPrice === "number") {
              allItems.push(item);
            }
          });
        }
      });
    }

    const itemsSum = allItems.reduce((s, i) => s + (i.totalPrice || 0), 0);
    const costsSum = (json.globalCosts || []).reduce((s, c) => s + (c.amount || 0), 0);
    const computedTotal = Math.round((itemsSum + costsSum) * 100) / 100;
    const printedTotal = json.printed_total || 0;
    const difference = Math.abs(computedTotal - printedTotal);
    const status = difference < 0.75 ? "OK" : "ERROR";

    const receipt = {
      filename: file.replace("_receipt.json", ""),
      status,
      restaurant: json.restaurant || "Unknown",
      currency: json.currency || "EUR",
      printed_total: printedTotal,
      computed_total: computedTotal,
      difference,
      items_count: allItems.length,
      ocr_passes: json.ocr_passes || 1,
    };

    results.push(receipt);
    if (status === "ERROR") erroredReceipts.push(receipt);
  } catch (err) {
    // Skip parse errors silently
  }
}

const ZERO  = erroredReceipts.filter(r => r.items_count === 0);
const OVER  = erroredReceipts.filter(r => r.items_count > 0 && r.computed_total > r.printed_total * 1.05);
const UNDER = erroredReceipts.filter(r => r.items_count > 0 && r.computed_total < r.printed_total * 0.95);
const MINOR = erroredReceipts.filter(r => r.items_count > 0 &&
  r.computed_total >= r.printed_total * 0.95 && r.computed_total <= r.printed_total * 1.05);

console.log(`\n📊 RESUMO GERAL:`);
console.log(`   Total recibos: ${results.length}`);
console.log(`   ✅ OK: ${results.filter(r => r.status === "OK").length}`);
console.log(`   ❌ ERROR: ${erroredReceipts.length}`);
console.log(`   Accuracy: ${((results.filter(r => r.status === "OK").length / results.length) * 100).toFixed(1)}%\n`);

console.log(`📈 CATEGORIZAÇÃO DOS ERROS:\n`);
console.log(`   ZERO_ITEMS:        ${ZERO.length}`);
console.log(`   OVER_EXTRACTION:   ${OVER.length}`);
console.log(`   UNDER_EXTRACTION:  ${UNDER.length}`);
console.log(`   MINOR_DISCREPANCY: ${MINOR.length}\n`);

if (ZERO.length > 0) {
  console.log(`🔴 TOP ZERO_ITEMS:\n`);
  ZERO.sort((a, b) => b.difference - a.difference).slice(0, 3).forEach(r => {
    console.log(`   ${r.filename} — ${r.restaurant}`);
    console.log(`   Diff: €${r.difference.toFixed(2)} | Items: ${r.items_count} | Passes: ${r.ocr_passes}\n`);
  });
}

if (OVER.length > 0) {
  console.log(`🟠 TOP OVER_EXTRACTION:\n`);
  OVER.sort((a, b) => b.difference - a.difference).slice(0, 3).forEach(r => {
    console.log(`   ${r.filename} — ${r.restaurant}`);
    console.log(`   Computed: €${r.computed_total.toFixed(2)} vs Printed: €${r.printed_total.toFixed(2)} (+€${(r.computed_total - r.printed_total).toFixed(2)})\n`);
  });
}

if (UNDER.length > 0) {
  console.log(`🟡 TOP UNDER_EXTRACTION:\n`);
  UNDER.sort((a, b) => b.difference - a.difference).slice(0, 3).forEach(r => {
    console.log(`   ${r.filename} — ${r.restaurant}`);
    console.log(`   Computed: €${r.computed_total.toFixed(2)} vs Printed: €${r.printed_total.toFixed(2)} (-€${(r.printed_total - r.computed_total).toFixed(2)})\n`);
  });
}

console.log(`\n🏪 TOP 5 RESTAURANTES COM MAIS ERROS:\n`);
const restaurantErrors = {};
erroredReceipts.forEach(r => {
  if (!restaurantErrors[r.restaurant]) restaurantErrors[r.restaurant] = { errors: 0, total: 0 };
  restaurantErrors[r.restaurant].errors++;
});
results.forEach(r => {
  if (!restaurantErrors[r.restaurant]) restaurantErrors[r.restaurant] = { errors: 0, total: 0 };
  restaurantErrors[r.restaurant].total++;
});

Object.entries(restaurantErrors)
  .filter(([_, data]) => data.errors > 0)
  .sort((a, b) => b[1].errors - a[1].errors)
  .slice(0, 5)
  .forEach(([name, data], i) => {
    const rate = ((data.errors / data.total) * 100).toFixed(0);
    console.log(`   ${i + 1}. ${name}`);
    console.log(`      ${data.errors}/${data.total} errors (${rate}%)\n`);
  });

const pass2Errors = erroredReceipts.filter(r => r.ocr_passes === 2);
console.log(`\n🔄 2ND PASS ANALYSIS:\n`);
console.log(`   Erros com 2nd pass: ${pass2Errors.length}/${erroredReceipts.length}`);
console.log(`   % que ainda falham: ${erroredReceipts.length > 0 ? ((pass2Errors.length / erroredReceipts.length) * 100).toFixed(1) : 0}%\n`);

console.log(`\n💡 IMPACTO POTENCIAL DA CORREÇÃO:\n`);
const potentialZero  = ZERO.length;
const potentialOver  = Math.round(OVER.length * 0.6);
const potentialUnder = Math.round(UNDER.length * 0.5);
const totalPotential = potentialZero + potentialOver + potentialUnder;
const newAccuracy = (((results.length - erroredReceipts.length + totalPotential) / results.length) * 100).toFixed(1);

console.log(`   Fixar ZERO_ITEMS (${ZERO.length}):        +${potentialZero} receipts`);
console.log(`   Fixar OVER_EXTRACTION (${OVER.length}):   +${potentialOver} receipts`);
console.log(`   Fixar UNDER_EXTRACTION (${UNDER.length}): +${potentialUnder} receipts`);
console.log(`   ─────────────────────────────────────────────`);
console.log(`   Total potencial: +${totalPotential} receipts`);
console.log(`   🎯 Nova accuracy: ${newAccuracy}% (${results.length - erroredReceipts.length + totalPotential}/${results.length})\n`);

const analysis = {
  summary: {
    total: results.length,
    ok: results.filter(r => r.status === "OK").length,
    errors: erroredReceipts.length,
    accuracy: ((results.filter(r => r.status === "OK").length / results.length) * 100).toFixed(1),
  },
  errorBreakdown: {
    ZERO_ITEMS: ZERO.length,
    OVER_EXTRACTION: OVER.length,
    UNDER_EXTRACTION: UNDER.length,
    MINOR_DISCREPANCY: MINOR.length,
  },
  potentialGain: {
    ZERO_ITEMS: potentialZero,
    OVER_EXTRACTION: potentialOver,
    UNDER_EXTRACTION: potentialUnder,
    total: totalPotential,
    newAccuracy,
  },
};

fs.writeFileSync("./error_analysis.json", JSON.stringify(analysis, null, 2));
console.log(`✅ Análise salva em error_analysis.json\n`);
