// Removes, from the StyleSheet.create({...}) of the given files, the style keys
// that nothing references any more (no "styles.<key>" left in the file).
// Prints what it removed. Run with --dry to only list them; --only=a,b limits
// the removal to those keys (when other unused ones predate the change).
//   node scripts/prune-unused-styles.js [--dry] [--only=a,b] <file>...
const fs = require("fs");
const args = process.argv.slice(2);
const dry = args.includes("--dry");
const onlyArg = args.find((a) => a.startsWith("--only="));
const only = onlyArg ? new Set(onlyArg.slice("--only=".length).split(",")) : null;
const files = args.filter((a) => !a.startsWith("--"));

for (const f of files) {
  let t = fs.readFileSync(f, "utf8");
  const crlf = t.includes("\r\n");
  if (crlf) t = t.replace(/\r\n/g, "\n");
  const start = t.lastIndexOf("StyleSheet.create({");
  if (start < 0) { console.log(`${f}: no StyleSheet`); continue; }
  const removed = [];
  let changed = true;
  while (changed) {
    changed = false;
    const body = t.slice(start);
    const re = /^  ([A-Za-z0-9_]+): \{/gm;
    let m;
    while ((m = re.exec(body))) {
      const key = m[1];
      if (only && !only.has(key)) continue;
      const uses = (t.match(new RegExp(`styles\\.${key}\\b`, "g")) || []).length;
      if (uses > 0) continue;
      // the block: from "  key: {" to its matching "}," (braces counted)
      const from = start + m.index;
      let depth = 0, i = t.indexOf("{", from);
      for (; i < t.length; i++) {
        if (t[i] === "{") depth++;
        else if (t[i] === "}") { depth--; if (depth === 0) break; }
      }
      let end = i + 1;
      if (t[end] === ",") end++;
      if (t[end] === "\n") end++;
      removed.push(key);
      if (!dry) { t = t.slice(0, from) + t.slice(end); changed = true; }
      break;
    }
    if (dry) break;
  }
  if (dry) {
    const body = t.slice(start);
    const keys = [...body.matchAll(/^  ([A-Za-z0-9_]+): \{/gm)].map((x) => x[1]);
    const unused = keys.filter((k) => !(t.match(new RegExp(`styles\\.${k}\\b`, "g")) || []).length);
    console.log(`${f}: ${unused.length} unused: ${unused.join(", ")}`);
    continue;
  }
  if (crlf) t = t.replace(/\n/g, "\r\n");
  fs.writeFileSync(f, t);
  console.log(`${f}: removed ${removed.length}${removed.length ? `: ${removed.join(", ")}` : ""}`);
}
