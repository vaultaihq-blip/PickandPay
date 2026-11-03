// Summarises a corpus run (scripts/corpus-run.sh) as one row per reading:
// printed total, number of items, items sum, whether it reconciles, and the
// Çerez & Meyva line when there is one. With two folders, compares them.
//   node scripts/corpus-table.js <before folder> [<after folder>]
const fs = require("fs");
const path = require("path");

function read(dir) {
  const rows = {};
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".debug.json")).sort()) {
    const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    const items = d.finalItems ?? [];
    const sum = Math.round(items.reduce((s, it) => s + (Number(it.effectiveTotal) || 0), 0) * 100) / 100;
    const cerez = items.find((it) => /erez/i.test(it.name ?? ""));
    rows[f.replace(/^vision-|\.debug\.json$/g, "")] = {
      printed: d.printedTotal ?? null,
      items: items.length,
      sum,
      ok: d.finalReconciles === true || d.reconciles === true,
      cerez: cerez ? Number(cerez.effectiveTotal) : null,
    };
  }
  return rows;
}

const [beforeDir, afterDir] = process.argv.slice(2);
const b = read(beforeDir);
const a = afterDir ? read(afterDir) : null;
const fmt = (r) => r ? `${String(r.printed).padStart(8)} | ${String(r.items).padStart(3)} | ${String(r.sum).padStart(8)} | ${r.ok ? "yes" : "no "}${r.cerez !== null ? ` | Çerez ${r.cerez}` : ""}` : "—";
let lost = 0;
console.log(`${"reading".padEnd(30)} printed | items | sum | adds up${a ? "   →   after" : ""}`);
for (const name of Object.keys(a ? { ...b, ...a } : b)) {
  const x = b[name], y = a ? a[name] : null;
  if (a && x && y && x.ok && !y.ok) lost++;
  console.log(`${name.padEnd(30)} ${fmt(x)}${a ? `   →   ${fmt(y)}${x && y && x.ok && !y.ok ? "   << STOPPED ADDING UP" : ""}` : ""}`);
}
if (a) console.log(`\n${lost} reading(s) that added up before and no longer do`);
