import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const screen = readFileSync(new URL("../app/(admin)/purchases.tsx", import.meta.url), "utf8");
const api = readFileSync(new URL("../src/api/purchases.ts", import.meta.url), "utf8");

assert.match(api, /items\/page/);
assert.match(api, /limit \?\? 30/);
assert.match(api, /signal\?: AbortSignal/);
assert.match(screen, /requestController\.current\?\.abort\(\)/);
assert.match(screen, /seq !== requestSeq\.current/);
assert.match(screen, /<FlatList/);
assert.match(screen, /initialNumToRender=\{8\}/);
assert.match(screen, /purchases-filter-button/);
assert.match(screen, /minHeight: 44/);
assert.doesNotMatch(screen, /rows\.filter\(\(candidate\) => candidate\.customer_id/);
assert.doesNotMatch(screen, /<ScrollView[^>]*>\s*<FlatList/);

// Stock is an operational availability surface. Movement audit data belongs in
// its History action, so the row must not expose a date, mover, or its creator
// fallback inline. It also needs enough room for all four row actions.
const stockRow = screen.slice(screen.indexOf("function ItemRow"), screen.indexOf("function BlockedCard"));
assert.doesNotMatch(stockRow, /fmtDate\(row\.last_moved_at\)/);
assert.doesNotMatch(stockRow, /row\.last_moved_by_name/);
assert.match(screen, /const TABLE_STACK = 720/);
assert.match(stockRow, /stockRowActionsDesktop/);
assert.match(stockRow, /stockRowActions/);

console.log("Purchases mobile/API contracts passed");
