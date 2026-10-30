#!/usr/bin/env node
// Post-build patch: replace import.meta (ESM-only) with safe shims.
// zustand uses import.meta.env.MODE (Vite syntax) which crashes when Metro
// serves the bundle as a classic <script> tag (not an ES module).
const fs = require("fs");
const path = require("path");

const distDir = process.argv[2] || "dist";
const jsDir = path.join(distDir, "_expo", "static", "js", "web");

if (!fs.existsSync(jsDir)) {
  console.log("[patch-web] No JS dir found at", jsDir, "— skipping.");
  process.exit(0);
}

const files = fs.readdirSync(jsDir).filter((f) => f.endsWith(".js"));
let patched = 0;
for (const file of files) {
  const fp = path.join(jsDir, file);
  let code = fs.readFileSync(fp, "utf8");
  if (!code.includes("import.meta")) continue;
  code = code.replace(/import\.meta\.env/g, '(typeof process!=="undefined"?process.env:{})');
  code = code.replace(/import\.meta/g, '(typeof globalThis!=="undefined"?globalThis:{})');
  fs.writeFileSync(fp, code);
  patched++;
}
console.log("[patch-web] Patched " + patched + " file(s) in " + jsDir);
