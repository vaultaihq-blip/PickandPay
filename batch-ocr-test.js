// batch-ocr-test.js — Pick&Pay OCR batch accuracy test
// Uso: SUPABASE_SERVICE_KEY=<service_role_key> node batch-ocr-test.js
// A service role key está em: Supabase Dashboard → Project Settings → API → service_role

const fs = require("fs");
const path = require("path");
const https = require("https");

const RECEIPTS_DIR = "C:\\Users\\ricar\\Pictures\\Vault AI\\PickPay\\Faturas\\Database";
const OUTPUT_DIR   = "C:\\Users\\ricar\\Pictures\\Vault AI\\PickPay\\Faturas\\results";

const SUPABASE_HOST = "eoevulbjtpidskzoyfno.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVvZXZ1bGJqdHBpZHNrem95Zm5vIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgyNjY0MzksImV4cCI6MjA5Mzg0MjQzOX0.zNSayOaF_kbdCneO5rq_sIg7jw98ETiElA5HgFfPuQg";

// ── Helpers ───────────────────────────────────────────────────────────────────

function httpsPost(host, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const data = typeof body === "string" ? body : JSON.stringify(body);
    const req = https.request(
      {
        hostname: host,
        port: 443,
        path: urlPath,
        method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(data) },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => { raw += c; });
        res.on("end", () => {
          let body;
          try { body = JSON.parse(raw); }
          catch { body = { _raw: raw.slice(0, 200) }; }
          resolve({ status: res.statusCode, body });
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ── Auth ──────────────────────────────────────────────────────────────────────

function getServiceKey() {
  const key = process.env.SUPABASE_SERVICE_KEY || "";
  if (!key) throw new Error(
    "Define a variável SUPABASE_SERVICE_KEY com a service_role key do Supabase.\n" +
    "  Supabase Dashboard → Project Settings → API → service_role (secret)"
  );
  return key;
}

// ── OCR call ──────────────────────────────────────────────────────────────────

async function parseReceipt(imageBase64, serviceKey) {
  const res = await httpsPost(
    SUPABASE_HOST,
    "/functions/v1/parse-receipt",
    {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${serviceKey}`,
      "apikey": SUPABASE_ANON_KEY,
    },
    { imageBase64 }
  );
  if (res.status === 429) {
    throw new Error(`Rate limit atingido (429). Aumenta RATE_LIMIT_MAX no edge function para o batch.`);
  }
  if (res.status !== 200) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
  }
  return res.body;
}

// ── Soma de itens + globalCosts (métrica correcta) ────────────────────────────

function calcItemsSum(ocrResult) {
  const cats = ocrResult.categories || {};
  const allItems = Object.values(cats).flat();
  const itemsTotal = allItems.reduce((s, item) => s + (typeof item.totalPrice === "number" ? item.totalPrice : 0), 0);
  const costsTotal = (ocrResult.globalCosts || []).reduce((s, c) => s + (typeof c.amount === "number" ? c.amount : 0), 0);
  return Math.round((itemsTotal + costsTotal) * 100) / 100;
}

function countItems(ocrResult) {
  const cats = ocrResult.categories || {};
  return Object.values(cats).flat().length;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const serviceKey = getServiceKey();
  console.log("\n🔑 Service key carregada. A processar...\n");

  const MAX = parseInt(process.env.MAX_RECEIPTS || "50", 10);

  const files = fs
    .readdirSync(RECEIPTS_DIR)
    .filter((f) => /\.(jpg|jpeg|png)$/i.test(f))
    .sort()
    .slice(0, MAX);

  console.log(`📂 ${files.length} imagens encontradas (limite: ${MAX}). A processar...\n`);

  const results = [];
  let processed = 0;
  const startTime = Date.now();

  for (let i = 0; i < files.length; i++) {
    const filename = files[i];
    const imagePath = path.join(RECEIPTS_DIR, filename);
    const paddedId  = String(i + 1).padStart(3, "0");

    try {
      process.stdout.write(`[${i + 1}/${files.length}] ${filename} ... `);

      const base64    = fs.readFileSync(imagePath).toString("base64");
      const ocrResult = await parseReceipt(base64, serviceKey);

      // Copy image
      fs.copyFileSync(imagePath, path.join(OUTPUT_DIR, `${paddedId}_receipt.jpg`));
      // Save JSON
      fs.writeFileSync(
        path.join(OUTPUT_DIR, `${paddedId}_receipt.json`),
        JSON.stringify(ocrResult, null, 2)
      );

      const itemsSum    = calcItemsSum(ocrResult);
      const printedTotal = typeof ocrResult.printed_total === "number" ? ocrResult.printed_total : 0;
      const difference  = Math.abs(itemsSum - printedTotal);
      const status      = printedTotal === 0 ? "NO_TOTAL" : difference < 0.75 ? "OK" : "ERROR";

      const source = ocrResult.source ?? "unknown";
      const statusIcon = status === "OK" ? "✅" : status === "NO_TOTAL" ? "⚠️ " : "❌";
      console.log(`${statusIcon} ${status.padEnd(8)} src=${source.padEnd(15)} items=${itemsSum.toFixed(2)} printed=${printedTotal.toFixed(2)} diff=${difference.toFixed(2)} passes=${ocrResult.ocr_passes ?? 1}`);

      results.push({
        id: paddedId,
        image_name: `${paddedId}_receipt.jpg`,
        ocr_sum: itemsSum.toFixed(2),
        printed_total: printedTotal.toFixed(2),
        difference: difference.toFixed(2),
        status,
        ocr_passes: ocrResult.ocr_passes ?? 1,
        source,
        currency: ocrResult.currency ?? "EUR",
        item_count: countItems(ocrResult),
        restaurant: (ocrResult.restaurant ?? "").replace(/"/g, "'"),
      });
      processed++;
    } catch (err) {
      console.log(`FAILED  ${err.message}`);
      results.push({
        id: paddedId,
        image_name: filename,
        status: "FAILED",
        error: String(err.message).slice(0, 120).replace(/"/g, "'"),
      });
    }

    // 1s delay to avoid hammering the API
    await new Promise((r) => setTimeout(r, 1000));
  }

  // ── CSV ───────────────────────────────────────────────────────────────────
  const csvPath = path.join(OUTPUT_DIR, "results.csv");
  const header = "id,image_name,ocr_sum,printed_total,difference,status,ocr_passes,source,currency,item_count,restaurant,error\n";
  const rows = results
    .map(
      (r) =>
        `${r.id},"${r.image_name}",${r.ocr_sum ?? ""},${r.printed_total ?? ""},${r.difference ?? ""},${r.status},${r.ocr_passes ?? ""},${r.source ?? ""},${r.currency ?? ""},${r.item_count ?? ""},"${r.restaurant ?? ""}","${r.error ?? ""}"`
    )
    .join("\n");
  fs.writeFileSync(csvPath, header + rows);

  // ── Stats ─────────────────────────────────────────────────────────────────
  const elapsed  = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  const ok       = results.filter((r) => r.status === "OK").length;
  const error    = results.filter((r) => r.status === "ERROR").length;
  const noTotal  = results.filter((r) => r.status === "NO_TOTAL").length;
  const failed   = results.filter((r) => r.status === "FAILED").length;
  const accuracy = ok + error > 0 ? ((ok / (ok + error)) * 100).toFixed(1) : "n/a";

  // Source breakdown
  const sourceCounts = {};
  for (const r of results) {
    if (r.source) sourceCounts[r.source] = (sourceCounts[r.source] ?? 0) + 1;
  }
  const sourceLines = Object.entries(sourceCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([src, count]) => `  ${src.padEnd(20)}: ${count}`)
    .join("\n");

  console.log(`
=== RESULTADOS (${elapsed} min) ===
Total processadas : ${processed}
✅ OK             : ${ok}
❌ ERROR          : ${error}
⚠️  NO_TOTAL      : ${noTotal}
💥 FAILED         : ${failed}
📊 Accuracy       : ${accuracy}%

=== FONTE POR PASS ===
${sourceLines || "  (sem dados de source)"}

📁 Resultados em  : ${OUTPUT_DIR}
📊 CSV            : ${csvPath}
`);

  // ── HTML report (errors only) ─────────────────────────────────────────────
  generateReport(results, OUTPUT_DIR);
}

function generateReport(results, outputDir) {
  const C = {
    bg: "#0B0D10", card: "#15181D", border: "#252A32",
    text: "#F8FAFC", muted: "#7D8794", primary: "#6366F1",
    success: "#22C55E", warning: "#F59E0B", error: "#EF4444",
  };

  const errorsOnly = results.filter((r) => parseFloat(r.difference || "0") > 0.01 || r.status === "FAILED");
  const correct    = results.length - errorsOnly.length;

  // Source breakdown for HTML
  const htmlSourceCounts = {};
  for (const r of results) {
    if (r.source) htmlSourceCounts[r.source] = (htmlSourceCounts[r.source] ?? 0) + 1;
  }
  const sourceChips = Object.entries(htmlSourceCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([src, count]) =>
      `<span style="background:${C.primary}22;color:${C.primary};font-size:10px;
                    padding:2px 8px;border-radius:8px;white-space:nowrap">
        ${src} <strong>${count}</strong>
      </span>`
    ).join(" ");

  function stat(label, value, color) {
    return `<div style="text-align:center">
      <div style="color:${color};font-size:26px;font-weight:800">${value}</div>
      <div style="color:${C.muted};font-size:11px;margin-top:3px">${label}</div>
    </div>`;
  }

  const statsBar = `
    <div style="background:${C.card};border:1px solid ${C.border};border-radius:16px;
                padding:24px 40px;margin-bottom:16px;display:flex;gap:48px;
                justify-content:center;align-items:center;flex-wrap:wrap;
                font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
      ${stat("TOTAL", results.length, C.text)}
      ${stat("CORRECT (hidden)", correct, C.success)}
      ${stat("ERRORS SHOWN", errorsOnly.length, C.error)}
      <div style="text-align:center">
        <div style="color:${C.primary};font-size:26px;font-weight:800">
          ${results.length > 0 ? (correct/results.length*100).toFixed(1) : 0}%
        </div>
        <div style="color:${C.muted};font-size:11px;margin-top:3px">ACCURACY</div>
      </div>
    </div>
    <div style="background:${C.card};border:1px solid ${C.border};border-radius:12px;
                padding:12px 24px;margin-bottom:28px;display:flex;gap:8px;
                align-items:center;flex-wrap:wrap;
                font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
      <span style="color:${C.muted};font-size:11px;margin-right:4px">FONTE:</span>
      ${sourceChips || '<span style="color:' + C.muted + ';font-size:11px">sem dados</span>'}
    </div>`;

  let rows = "";
  for (const r of errorsOnly) {
    const imgFile = `${r.id}_receipt.jpg`;
    const imgPath = path.join(outputDir, imgFile);
    const hasImg  = fs.existsSync(imgPath);
    const diffNum = parseFloat(r.difference || "0");
    const diffColor = r.status === "FAILED" ? C.muted : diffNum > 10 ? C.error : C.warning;
    const passColor = (r.ocr_passes ?? 1) > 4 ? C.error : (r.ocr_passes ?? 1) > 1 ? C.warning : C.success;
    const statusColor = r.status === "OK" ? C.success : r.status === "FAILED" ? C.muted : C.error;
    const srcLabel = r.source ?? "unknown";

    rows += `
      <div style="display:flex;gap:14px;align-items:flex-start;
                  background:${C.card};border:1px solid ${C.border};
                  border-radius:16px;padding:14px;width:100%">

        ${hasImg
          ? `<div style="flex-shrink:0;width:200px;border-radius:10px;overflow:hidden;
                         border:1px solid ${C.border};align-self:flex-start">
               <img src="${imgFile}" alt="${r.id}" style="width:100%;display:block;
                    object-fit:contain;background:#000;max-height:400px" />
             </div>`
          : `<div style="flex-shrink:0;width:200px;height:120px;border-radius:10px;
                         border:1px solid ${C.border};display:flex;align-items:center;
                         justify-content:center;color:${C.muted};font-size:12px">no img</div>`}

        <div style="flex:1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <span style="background:${C.border};color:${C.muted};font-size:10px;
                         padding:2px 8px;border-radius:8px">#${r.id}</span>
            <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
              <span style="background:${C.primary}22;color:${C.primary};font-size:10px;
                           padding:2px 8px;border-radius:8px">${srcLabel}</span>
              <span style="background:${passColor}22;color:${passColor};font-size:10px;
                           padding:2px 8px;border-radius:8px">pass ${r.ocr_passes ?? 1}</span>
              <span style="background:${statusColor}22;color:${statusColor};font-size:11px;
                           font-weight:700;padding:3px 10px;border-radius:10px">${r.status}</span>
            </div>
          </div>

          <div style="color:${C.text};font-size:16px;font-weight:700;margin-bottom:12px">
            ${(r.restaurant || "Unknown").replace(/</g,"&lt;")}
          </div>

          <div style="background:#0B0D10;border-radius:10px;padding:12px;display:grid;
                      grid-template-columns:1fr 1fr;gap:8px">
            <div>
              <div style="color:${C.muted};font-size:10px;margin-bottom:2px">OCR SUM</div>
              <div style="color:${C.text};font-size:14px;font-weight:600">
                ${r.currency||"$"} ${r.ocr_sum||"0.00"}
              </div>
            </div>
            <div>
              <div style="color:${C.muted};font-size:10px;margin-bottom:2px">PRINTED</div>
              <div style="color:${C.text};font-size:14px;font-weight:600">
                ${r.currency||"$"} ${r.printed_total||"0.00"}
              </div>
            </div>
            <div>
              <div style="color:${C.muted};font-size:10px;margin-bottom:2px">DIFFERENCE</div>
              <div style="color:${diffColor};font-size:15px;font-weight:800">
                ${r.currency||"$"} ${r.difference||"0.00"}
              </div>
            </div>
            <div>
              <div style="color:${C.muted};font-size:10px;margin-bottom:2px">ITEMS</div>
              <div style="color:${C.text};font-size:14px;font-weight:600">
                ${r.item_count||0} item${(r.item_count||0)===1?"":"s"}
              </div>
            </div>
          </div>

          ${r.error ? `<div style="color:${C.error};font-size:11px;margin-top:8px;
                                    background:${C.error}11;border-radius:8px;padding:8px">
            ${r.error}</div>` : ""}
        </div>
      </div>`;
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Pick&amp;Pay OCR — Errors Report</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{background:${C.bg};color:${C.text};
         font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
         padding:32px;min-height:100vh}
    h1{font-size:20px;font-weight:800;margin-bottom:4px}
    .sub{color:${C.muted};font-size:12px;margin-bottom:24px}
    .grid{display:flex;flex-direction:column;gap:16px}
    .note{background:${C.warning}22;border:1px solid ${C.warning}44;border-radius:10px;
          padding:10px 16px;color:${C.warning};font-size:12px;margin-bottom:20px}
  </style>
</head>
<body>
  <h1>Pick&amp;Pay — OCR Errors Report</h1>
  <p class="sub">${results.length} receipts processed &nbsp;·&nbsp; Generated ${new Date().toLocaleString("en-GB")}</p>
  ${statsBar}
  <div class="note">
    Showing <strong>${errorsOnly.length}</strong> receipts with difference &gt; $0.01
    &nbsp;·&nbsp;
    <strong>${correct}</strong> receipts assumed correct and hidden
  </div>
  <div class="grid">${rows}</div>
</body>
</html>`;

  const htmlPath = path.join(outputDir, "report.html");
  fs.writeFileSync(htmlPath, html, "utf8");
  console.log(`🌐 HTML report   : ${htmlPath}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("\n❌ Fatal:", err.message);
    process.exit(1);
  });
}

module.exports = { generateReport };
