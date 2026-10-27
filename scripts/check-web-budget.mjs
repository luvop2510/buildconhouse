import { readFile, stat, readdir, mkdir, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..", "dist", "client");
// Discover every exported page so newly added routes inherit the release
// constraint automatically. Cache shared asset sizes rather than recompressing
// the same shell for each page.
async function exportedPages(directory, relative = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const pages = await Promise.all(entries.map(entry => {
    const name = path.join(relative, entry.name);
    return entry.isDirectory() ? exportedPages(path.join(directory, entry.name), name)
      : entry.isFile() && entry.name.endsWith(".html") ? [name] : [];
  }));
  return pages.flat().sort();
}
const ROUTES = await exportedPages(ROOT);
if (!ROUTES.length) throw new Error("No exported pages found. Run npm run build first.");
const assetCache = new Map();
const report = [];
// Expo Router + React Native Web form the unavoidable shell shared by every
// route (about 490 KiB gzip in the production export). The profiled largest
// route is 519 KiB, so retain at least 10% (57 KiB) of release headroom while
// still failing CI on a meaningful dependency or root-layout regression. The
// former 528 KiB cap left only 1.7% headroom and did not satisfy that guard.
const MAX_INITIAL_JS_GZIP = 576 * 1024;

let failed = false;
for (const route of ROUTES) {
  const html = await readFile(path.join(ROOT, route), "utf8");
  const assets = [...new Set(
    [...html.matchAll(/(?:src|href)=["']\/?([^"']+\.js)["']/g)].map((match) => match[1]),
  )];
  let gzipBytes = 0;
  let rawBytes = 0;
  const assetStats = [];
  for (const asset of assets) {
    if (!assetCache.has(asset)) {
      const bytes = await readFile(path.join(ROOT, asset));
      assetCache.set(asset, { raw: (await stat(path.join(ROOT, asset))).size, gzip: gzipSync(bytes, { level: 9 }).length });
    }
    const { raw, gzip } = assetCache.get(asset);
    rawBytes += raw;
    gzipBytes += gzip;
    assetStats.push({ asset, raw, gzip });
  }
  const result = {
    route,
    assets: assets.length,
    rawKb: Math.round(rawBytes / 1024),
    gzipKb: Math.round(gzipBytes / 1024),
    budgetKb: Math.round(MAX_INITIAL_JS_GZIP / 1024),
    largestAssets: assetStats
      .sort((left, right) => right.gzip - left.gzip)
      .slice(0, 5)
      .map(({ asset, gzip }) => ({ asset, gzipKb: Math.round(gzip / 1024) })),
  };
  report.push(result);
  if (!assets.length) throw new Error(`No initial JavaScript found for ${route}; the budget must not silently skip a page.`);
  if (gzipBytes > MAX_INITIAL_JS_GZIP) failed = true;
}

await mkdir(path.resolve(SCRIPT_DIR, "..", "output", "playwright"), { recursive: true });
await writeFile(path.resolve(SCRIPT_DIR, "..", "output", "playwright", "bundle-budget.json"), JSON.stringify({ budgetBytes: MAX_INITIAL_JS_GZIP, pages: report }, null, 2));
console.log(JSON.stringify({ pagesChecked: report.length, largestPages: report.sort((a, b) => b.gzipKb - a.gzipKb).slice(0, 12), failed }));

if (failed) {
  console.error("Initial JavaScript exceeds the 576 KB gzip release budget.");
  process.exitCode = 1;
}
