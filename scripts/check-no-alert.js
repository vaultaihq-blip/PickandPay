#!/usr/bin/env node
// Fails when Alert.alert appears in the app outside lib/dialog.ts.
// react-native-web implements Alert.alert as a no-op (the web logout did
// nothing because of it): use showDialog from lib/dialog.ts instead.
// Usage: npm run check:alerts
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const dirs = ["app", "components", "lib", "utils", "store", "hooks"];
const allowed = new Set([path.join("lib", "dialog.ts")]);
const hits = [];

const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(e.name)) {
      const rel = path.relative(root, p);
      if (allowed.has(rel)) continue;
      fs.readFileSync(p, "utf8").split(/\r?\n/).forEach((line, i) => {
        if (/\bAlert\.alert\s*\(/.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
  }
};
for (const d of dirs) if (fs.existsSync(path.join(root, d))) walk(path.join(root, d));

if (hits.length) {
  console.error(`[check-no-alert] Alert.alert found (use showDialog from lib/dialog.ts):\n${hits.join("\n")}`);
  process.exit(1);
}
console.log("[check-no-alert] no Alert.alert outside lib/dialog.ts");
