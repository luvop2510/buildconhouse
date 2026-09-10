import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const screen = readFileSync(resolve("app/(admin)/tiles/orders/index.tsx"), "utf8");
const client = readFileSync(resolve("src/api/tileOrders.ts"), "utf8");

const requiredScreenTokens = [
  '["customer", "Customer"]',
  '["brands", "Brands"]',
  '["dispatch-list", "Dispatch List"]',
  '["material-register", "Material Movement Register"]',
  "View Chalan",
  "Print Chalan",
  "View Dispatch",
  "dispatchRowKey",
  "Previous page",
  "Next page",
];
const requiredClientTokens = [
  "releaseMaterial:",
  "moveToGodown:",
  "dispatchFromReleased:",
  "dispatchFromGodown:",
  "listDispatchList:",
  "listMovements:",
  "chalanPdfUrl:",
];

for (const token of requiredScreenTokens) {
  if (!screen.includes(token)) throw new Error(`Tile Orders screen contract missing: ${token}`);
}
for (const token of requiredClientTokens) {
  if (!client.includes(token)) throw new Error(`Tile Orders API contract missing: ${token}`);
}

// PageShell is the vertical scroll owner for these tables. Keeping each tab
// to its current API page prevents an ever-growing ordinary-view render tree.
const pagedResultSetters = [
  "setCustomerOrders(result.orders)",
  "setBrands(result.brands)",
  "setHistory(result.rows)",
  "setInventory(result.rows)",
  "setDispatchRows(result.rows)",
  "setMovements(result.rows)",
];
for (const setter of pagedResultSetters) {
  if (!screen.includes(setter)) throw new Error(`Tile Orders must replace, not append, page results: ${setter}`);
}
if (screen.includes("[...previous, ...result.")) {
  throw new Error("Tile Orders must not accumulate paged results in a parent-scrolled table.");
}

console.log("Tile Orders workflow route contract verified.");
