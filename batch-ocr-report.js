// batch-ocr-report.js — Pick&Pay OCR results visual report
// Gera report.html com cada recibo formatado como o ecrã de review da app
// Uso: node batch-ocr-report.js

const fs   = require("fs");
const path = require("path");

const RESULTS_DIR = "C:\\Users\\ricar\\Pictures\\Vault AI\\PickPay\\Faturas\\results";
const OUT_FILE    = path.join(RESULTS_DIR, "report.html");

// ── Cores exactas da app (constants/colors.ts) ────────────────────────────────
const C = {
  bgDark:        "#0B0D10",
  cardDark:      "#15181D",
  cardBorder:    "#252A32",
  textPrimary:   "#F8FAFC",
  textMuted:     "#7D8794",
  primary:       "#6366F1",
  success:       "#22C55E",
  warning:       "#F59E0B",
  error:         "#EF4444",
  starters:      "#F97316",
  mains:         "#EF4444",
  drinks:        "#3B82F6",
  desserts:      "#EC4899",
  others:        "#8B5CF6",
};

const CAT_LABELS = {
  starters: "STARTERS",
  mains:    "MAINS",
  drinks:   "DRINKS",
  desserts: "DESSERTS",
  others:   "OTHERS",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n, currency = "USD") {
  if (typeof n !== "number") return "–";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

function calcTotals(data) {
  const cats  = data.categories || {};
  const items = Object.values(cats).flat();
  const itemsSum   = Math.round(items.reduce((s, i) => s + (typeof i.totalPrice === "number" ? i.totalPrice : 0), 0) * 100) / 100;
  const costsSum   = Math.round((data.globalCosts || []).reduce((s, c) => s + (typeof c.amount === "number" ? c.amount : 0), 0) * 100) / 100;
  const computedTotal = Math.round((itemsSum + costsSum) * 100) / 100;
  const printedTotal  = typeof data.printed_total === "number" ? data.printed_total : 0;
  const diff          = Math.round(Math.abs(computedTotal - printedTotal) * 100) / 100;
  const status        = printedTotal === 0 ? "NO_TOTAL" : diff < 0.50 ? "OK" : "ERROR";
  return { itemsSum, costsSum, computedTotal, printedTotal, diff, status };
}

function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Card HTML ─────────────────────────────────────────────────────────────────

function renderCard(data, id) {
  const { itemsSum, costsSum, computedTotal, printedTotal, diff, status } = calcTotals(data);
  const currency = data.currency || "USD";
  const cats = data.categories || {};

  const statusColor = { OK: C.success, ERROR: C.error, NO_TOTAL: C.warning }[status] || C.textMuted;
  const passColor   = data.ocr_passes === 2 ? C.warning : C.success;
  const imgFile     = `${id}_receipt.jpg`;
  const imgExists   = fs.existsSync(path.join(RESULTS_DIR, imgFile));

  // Category sections
  let catHtml = "";
  for (const [key, label] of Object.entries(CAT_LABELS)) {
    const items = cats[key] || [];
    if (!items.length) continue;
    const color    = C[key] || C.others;
    const catTotal = items.reduce((s, i) => s + (i.totalPrice || 0), 0);

    let itemRows = "";
    for (const item of items) {
      const hasWarning = item.warnings && item.warnings.some(w => !w.toLowerCase().includes("consider grouping"));
      const warnIcon   = hasWarning ? `<span style="color:${C.warning};margin-left:4px">⚠</span>` : "";
      const qty        = item.quantity > 1 ? `<span style="color:${C.textMuted};font-size:11px"> ×${item.quantity}</span>` : "";
      itemRows += `
        <div style="display:flex;justify-content:space-between;align-items:center;
                    padding:6px 0;border-bottom:1px solid ${C.cardBorder}">
          <span style="color:${C.textPrimary};font-size:13px">
            ${escHtml(item.name)}${qty}${warnIcon}
          </span>
          <span style="color:${C.textPrimary};font-size:13px;font-weight:600">
            ${fmt(item.totalPrice, currency)}
          </span>
        </div>`;
    }

    catHtml += `
      <div style="margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <div style="display:flex;align-items:center;gap:6px">
            <div style="width:10px;height:10px;border-radius:50%;background:${color}"></div>
            <span style="color:${color};font-size:11px;font-weight:700;letter-spacing:1px">${label}</span>
            <span style="background:${color}22;color:${color};font-size:10px;padding:1px 6px;border-radius:10px">${items.length}</span>
          </div>
          <span style="color:${color};font-size:12px;font-weight:600">${fmt(catTotal, currency)}</span>
        </div>
        ${itemRows}
      </div>`;
  }

  // Global costs
  let costsHtml = "";
  if ((data.globalCosts || []).length > 0) {
    let costRows = "";
    for (const c of data.globalCosts) {
      costRows += `
        <div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid ${C.cardBorder}">
          <span style="color:${C.textMuted};font-size:12px">${escHtml(c.name)}</span>
          <span style="color:${C.textPrimary};font-size:12px">${fmt(c.amount, currency)}</span>
        </div>`;
    }
    costsHtml = `
      <div style="margin-bottom:14px">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
          <span style="color:${C.textMuted};font-size:11px;font-weight:700;letter-spacing:1px">SHARED COSTS</span>
        </div>
        ${costRows}
      </div>`;
  }

  // Validation breakdown
  const validationHtml = printedTotal > 0 ? `
    <div style="display:flex;justify-content:space-between;padding:4px 0;margin-top:4px">
      <span style="color:${C.textMuted};font-size:11px">Items subtotal</span>
      <span style="color:${C.textMuted};font-size:11px">${fmt(itemsSum, currency)}</span>
    </div>
    <div style="display:flex;justify-content:space-between;padding:4px 0">
      <span style="color:${C.textMuted};font-size:11px">+ costs</span>
      <span style="color:${C.textMuted};font-size:11px">${fmt(costsSum, currency)}</span>
    </div>
    <div style="display:flex;justify-content:space-between;padding:4px 0">
      <span style="color:${C.textMuted};font-size:11px">Computed total</span>
      <span style="color:${C.textMuted};font-size:11px">${fmt(computedTotal, currency)}</span>
    </div>
    <div style="display:flex;justify-content:space-between;padding:4px 0">
      <span style="color:${C.textMuted};font-size:11px">Printed total</span>
      <span style="color:${C.textMuted};font-size:11px">${fmt(printedTotal, currency)}</span>
    </div>
    <div style="display:flex;justify-content:space-between;padding:4px 0">
      <span style="color:${C.textMuted};font-size:11px">Difference</span>
      <span style="color:${diff < 0.50 ? C.success : C.error};font-size:11px;font-weight:600">
        ${fmt(diff, currency)}
      </span>
    </div>` : "";

  const dateStr = data.date
    ? new Date(data.date).toLocaleDateString("en-GB", { day:"2-digit", month:"short", year:"numeric" })
    : "";

  // Image panel (left side)
  const imgPanel = imgExists ? `
    <div style="flex-shrink:0;width:260px;border-radius:12px;overflow:hidden;
                border:1px solid ${C.cardBorder};align-self:flex-start;position:relative">
      <img src="${imgFile}" alt="receipt ${id}"
           style="width:100%;display:block;object-fit:contain;background:#000;max-height:600px" />
      <div style="position:absolute;top:8px;left:8px;
                  background:rgba(0,0,0,0.7);backdrop-filter:blur(4px);
                  border-radius:8px;padding:3px 10px;
                  color:${C.textMuted};font-size:10px">${imgFile}</div>
    </div>` : `
    <div style="flex-shrink:0;width:260px;height:200px;border-radius:12px;
                border:1px solid ${C.cardBorder};display:flex;align-items:center;
                justify-content:center;color:${C.textMuted};font-size:12px">
      no image
    </div>`;

  // OCR card (right side)
  const ocrCard = `
    <div style="background:${C.cardDark};border:1px solid ${C.cardBorder};border-radius:16px;
                padding:20px;width:320px;flex-shrink:0;display:flex;flex-direction:column;
                font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">

      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <span style="background:${C.cardBorder};color:${C.textMuted};font-size:10px;
                     padding:2px 8px;border-radius:8px">#${id}</span>
        <div style="display:flex;gap:6px;align-items:center">
          <span style="background:${passColor}22;color:${passColor};font-size:10px;
                       padding:2px 8px;border-radius:8px">
            ${data.ocr_passes === 2 ? "2nd pass" : "1 pass"}
          </span>
          <span style="background:${statusColor}22;color:${statusColor};font-size:11px;font-weight:700;
                       padding:3px 10px;border-radius:10px">
            ${status}
          </span>
        </div>
      </div>

      <div style="color:${C.textPrimary};font-size:17px;font-weight:700;margin-bottom:2px;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
        ${escHtml(data.restaurant || "Unknown")}
      </div>
      <div style="color:${C.textMuted};font-size:11px;margin-bottom:16px">${escHtml(dateStr)}</div>

      <div style="height:1px;background:${C.cardBorder};margin-bottom:14px"></div>

      ${catHtml}
      ${costsHtml}

      <div style="height:1px;background:${C.cardBorder};margin:4px 0 12px"></div>

      <div style="display:flex;justify-content:space-between;align-items:center">
        <span style="color:${C.textPrimary};font-size:15px;font-weight:700">Total</span>
        <span style="color:${C.primary};font-size:18px;font-weight:800">
          ${fmt(printedTotal || computedTotal, currency)}
        </span>
      </div>

      ${printedTotal > 0 ? `
        <div style="background:${C.bgDark};border-radius:10px;padding:10px;margin-top:12px">
          ${validationHtml}
        </div>` : ""}
    </div>`;

  // Wrapper: image + card side by side, full-width row
  return `
    <div style="display:flex;gap:16px;align-items:flex-start;
                background:${C.bgDark};border:1px solid ${C.cardBorder};
                border-radius:18px;padding:16px;width:100%">
      ${imgPanel}
      ${ocrCard}
    </div>`;
}

// ── Stats bar ─────────────────────────────────────────────────────────────────

function renderStats(all) {
  const ok      = all.filter(d => d._status === "OK").length;
  const error   = all.filter(d => d._status === "ERROR").length;
  const noTotal = all.filter(d => d._status === "NO_TOTAL").length;
  const failed  = all.filter(d => d._status === "FAILED").length;
  const twoPass = all.filter(d => d.ocr_passes === 2).length;
  const acc     = ok + error > 0 ? ((ok / (ok + error)) * 100).toFixed(1) : "–";

  function stat(label, value, color) {
    return `<div style="text-align:center">
      <div style="color:${color};font-size:24px;font-weight:800">${value}</div>
      <div style="color:${C.textMuted};font-size:11px;margin-top:2px">${label}</div>
    </div>`;
  }

  return `
    <div style="background:${C.cardDark};border:1px solid ${C.cardBorder};border-radius:16px;
                padding:24px 32px;margin-bottom:32px;display:flex;gap:40px;
                justify-content:center;align-items:center;flex-wrap:wrap">
      ${stat("TOTAL", all.length, C.textPrimary)}
      ${stat("OK", ok, C.success)}
      ${stat("ERROR", error, C.error)}
      ${stat("NO TOTAL", noTotal, C.warning)}
      ${stat("FAILED", failed, C.textMuted)}
      ${stat("2nd PASS", twoPass, C.warning)}
      <div style="text-align:center">
        <div style="color:${C.primary};font-size:24px;font-weight:800">${acc}%</div>
        <div style="color:${C.textMuted};font-size:11px;margin-top:2px">ACCURACY</div>
      </div>
    </div>`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  const jsonFiles = fs
    .readdirSync(RESULTS_DIR)
    .filter(f => /^\d{3}_receipt\.json$/.test(f))
    .sort();

  console.log(`\n📂 ${jsonFiles.length} JSON files found. Building report...\n`);

  const allData = [];

  for (const file of jsonFiles) {
    const id   = file.replace("_receipt.json", "");
    const full = path.join(RESULTS_DIR, file);
    try {
      const data  = JSON.parse(fs.readFileSync(full, "utf8"));
      const tots  = calcTotals(data);
      data._id     = id;
      data._status = tots.status;
      allData.push(data);
    } catch (e) {
      console.warn(`  SKIP ${file}: ${e.message}`);
    }
  }

  let cardGrid = "";
  for (const data of allData) {
    cardGrid += renderCard(data, data._id);
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Pick&amp;Pay OCR Batch Report</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: ${C.bgDark};
      color: ${C.textPrimary};
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      padding: 32px;
      min-height: 100vh;
    }
    h1 {
      font-size: 22px;
      font-weight: 800;
      color: ${C.textPrimary};
      margin-bottom: 6px;
    }
    .subtitle {
      color: ${C.textMuted};
      font-size: 13px;
      margin-bottom: 28px;
    }
    .grid {
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
  </style>
</head>
<body>
  <h1>Pick&amp;Pay — OCR Batch Report</h1>
  <p class="subtitle">${allData.length} receipts processed &nbsp;·&nbsp; Generated ${new Date().toLocaleString("en-GB")}</p>
  ${renderStats(allData)}
  <div class="grid">
    ${cardGrid}
  </div>
</body>
</html>`;

  fs.writeFileSync(OUT_FILE, html, "utf8");

  const ok    = allData.filter(d => d._status === "OK").length;
  const error = allData.filter(d => d._status === "ERROR").length;
  const acc   = ok + error > 0 ? ((ok / (ok + error)) * 100).toFixed(1) : "n/a";

  console.log(`✅ Report gerado: ${OUT_FILE}`);
  console.log(`   ${allData.length} recibos  |  OK: ${ok}  ERROR: ${error}  ACC: ${acc}%\n`);
}

main();
