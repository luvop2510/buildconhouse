import assert from "node:assert/strict";
import { mergeFurnitureAcquisition } from "../src/utils/furnitureEnrichment.ts";
const current = { id: "q1", updated_at: "v1", referrer_id: "r1" };
const enriched = { ...current, referrer_customers_acquired: 7 };
assert.equal(mergeFurnitureAcquisition(current, enriched, true).referrer_customers_acquired, 7);
assert.equal(mergeFurnitureAcquisition(current, enriched, false), current);
for (const change of [{ id: "q2" }, { updated_at: "v2" }, { referrer_id: "r2" }]) {
  const newer = { ...current, ...change };
  assert.equal(mergeFurnitureAcquisition(newer, enriched, true), newer);
}
assert.equal(mergeFurnitureAcquisition(null, enriched, true), null);
console.log("Furniture acquisition race checks passed");
