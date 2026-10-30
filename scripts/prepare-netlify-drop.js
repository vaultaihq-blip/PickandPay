#!/usr/bin/env node
// Makes an `expo export --platform web` output safe for Netlify Drop
// (same steps as the earlier scripts/prepare-netlify-drop.py).
//
// Netlify Drop silently skips some folders (any `node_modules`, and the
// vector-icons font folder), so those assets 404 into index.html and the
// icons vanish. This script:
//   1. moves every file under dist/assets/node_modules/ to dist/assets/v/
//      (flat; the file names already carry a content hash) and rewrites the
//      URLs in the JS bundle;
//   2. inlines the Ionicons font into the bundle as a data: URI, so the icons
//      never depend on the host;
//   3. renames the bundle (cache-busting) and adds the SPA _redirects file.
// Usage: node scripts/prepare-netlify-drop.js dist   (run by `npm run web:export`)
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const dist = process.argv[2] || "dist";
const nm = path.join(dist, "assets", "node_modules");
const flat = path.join(dist, "assets", "v");
fs.mkdirSync(flat, { recursive: true });

// 1. flatten dist/assets/node_modules → dist/assets/v
const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]
  );
let moved = 0;
if (fs.existsSync(nm)) {
  for (const file of walk(nm)) {
    const dest = path.join(flat, path.basename(file));
    if (fs.existsSync(dest) && !fs.readFileSync(dest).equals(fs.readFileSync(file))) {
      throw new Error(`[netlify-drop] two different assets named ${path.basename(file)}`);
    }
    fs.renameSync(file, dest);
    moved++;
  }
  fs.rmSync(nm, { recursive: true, force: true });
}

const jsDir = path.join(dist, "_expo", "static", "js", "web");
const bundles = fs.readdirSync(jsDir).filter((f) => /^entry-.*\.js$/.test(f));
if (bundles.length !== 1) throw new Error(`[netlify-drop] expected one entry-*.js in ${jsDir}, found ${bundles.length}`);
const bundle = path.join(jsDir, bundles[0]);
let src = fs.readFileSync(bundle, "utf8");
let rewritten = 0;
src = src.replace(/"\/assets\/node_modules\/(?:[^"]*\/)?([^"/]+)"/g, (_, name) => {
  rewritten++;
  return `"/assets/v/${name}"`;
});

// 2. Ionicons inline
let inlined = 0;
for (const font of fs.readdirSync(flat).filter((f) => /^Ionicons\..*\.ttf$/.test(f))) {
  const uri = "data:font/ttf;base64," + fs.readFileSync(path.join(flat, font)).toString("base64");
  const before = src;
  src = src.split(`"/assets/v/${font}"`).join(`"${uri}"`);
  if (src !== before) inlined++;
}

// 3. new bundle name + index.html + _redirects
const digest = crypto.createHash("md5").update(src, "utf8").digest("hex");
const newName = `entry-${digest}.js`;
fs.rmSync(bundle);
fs.writeFileSync(path.join(jsDir, newName), src, "utf8");
const index = path.join(dist, "index.html");
const html = fs.readFileSync(index, "utf8");
if (!html.includes(bundles[0])) throw new Error(`[netlify-drop] index.html does not load ${bundles[0]}`);
fs.writeFileSync(index, html.split(bundles[0]).join(newName), "utf8");
fs.writeFileSync(path.join(dist, "_redirects"), "/*  /index.html  200\n");

console.log(`[netlify-drop] ${moved} assets moved to assets/v, ${rewritten} asset URLs rewritten, ${inlined} Ionicons font inlined, bundle -> ${newName}`);
