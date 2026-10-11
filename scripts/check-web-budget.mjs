import { readFile, stat } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..", "dist", "client");
// These are the staff routes that carry the largest independently-loaded
// workflow code. Keep each initial payload within the same release envelope;
// checking only login/dashboard previously let Follow-ups and Purchases grow
// without a CI signal.
const ROUTES = [
  "login.html", "dashboard.html", "followups.html", "purchases.html",
  "tiles/quotation.html", "tiles/orders/index.html", "quotations/new.html",
  "sales-data/index.html",
  "team.html", "catalog/index.html", "notebook/furniture-quotations.html",
];
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
    const bytes = await readFile(path.join(ROOT, asset));
    const raw = (await stat(path.join(ROOT, asset))).size;
    const gzip = gzipSync(bytes, { level: 9 }).length;
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
  console.log(JSON.stringify(result));
  if (gzipBytes > MAX_INITIAL_JS_GZIP) failed = true;
}

if (failed) {
  console.error("Initial JavaScript exceeds the 576 KB gzip release budget.");
  process.exitCode = 1;
}
