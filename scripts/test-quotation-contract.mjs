import assert from "node:assert/strict";

import { computeQuotationTotals } from "../src/components/quotation/helpers/totals.ts";
import { godownQuotationPrice } from "../src/components/quotation/helpers/godown.ts";
import { confirmQuotationLineCancellation, enqueueQuotationPersist, QuotationMutations } from "../src/components/quotation/helpers/autosave.ts";

const totals = computeQuotationTotals([
  { qty: 2, unitPrice: 2170 },
  { qty: 1, unitPrice: 2000, discountAmount: 100 },
], 100);

assert.deepEqual(totals, {
  subtotal: 6340,
  discount: 100,
  transportation: 100,
  grandTotal: 6340,
});

assert.deepEqual(computeQuotationTotals([], 125.678), {
  subtotal: 0,
  discount: 0,
  transportation: 125.68,
  grandTotal: 125.68,
});

const queue = { current: Promise.resolve(null) };
const order = [];
const slow = () => new Promise((resolve) => setTimeout(() => { order.push("first"); resolve("first"); }, 10));
const fast = () => Promise.resolve().then(() => { order.push("second"); return "second"; });
await Promise.all([enqueueQuotationPersist(queue, slow), enqueueQuotationPersist(queue, fast)]);
assert.deepEqual(order, ["first", "second"]);

console.log("shared quotation totals/autosave contract: 3 assertions passed");

for (const writeFails of [false, true]) {
  const mutations = new QuotationMutations();
  let settleActive;
  const activeSave = new Promise((resolve, reject) => { settleActive = writeFails ? reject : resolve; });
  const calls = [];
  const active = mutations.save("this-quotation", () => { calls.push("save"); return activeSave; });
  // The failure is observed independently of the deletion waiting for it.
  const observedActive = active.catch(() => null);
  await Promise.resolve();
  const queued = mutations.save("this-quotation", async () => { calls.push("queued"); return null; });
  const unrelated = mutations.save("other-quotation", async () => { calls.push("other save"); return "other"; });
  const remove = mutations.remove("this-quotation", async () => { calls.push("delete"); return true; });
  assert.strictEqual(mutations.remove("this-quotation", async () => { throw Error("Duplicate delete"); }), remove);
  assert.equal(await mutations.save("this-quotation", async () => { throw Error("Late autosave"); }), null);
  assert.equal(await unrelated, "other");
  assert.deepEqual(calls, ["save", "other save"]);
  settleActive(writeFails ? Error("Interrupted save") : "this-quotation");
  await observedActive;
  assert.equal(await queued, null);
  assert.equal(await remove, true);
  assert.deepEqual(calls, ["save", "other save", "delete"]);
  assert.equal(mutations.isDeleting("this-quotation"), false);
  await assert.rejects(mutations.remove("this-quotation", async () => { throw Error("Connection lost"); }), /Connection lost/);
  assert.equal(await mutations.remove("this-quotation", async () => true), true);
}

const confirmedCancellation = {
  id: "quotation", updated_at: "2026-11-23T12:00:00Z", items: [{ id: "independent-cover" }],
};
const confirm = (write, read) => confirmQuotationLineCancellation("quotation", "wc", ["seat"], write, read);
assert.equal(await confirm(async () => confirmedCancellation, async () => assert.fail("No read after a confirmed write")), confirmedCancellation);
for (const status of [undefined, 404, 502]) {
  let writes = 0;
  let reads = 0;
  assert.equal(await confirm(
    async () => { writes++; throw Object.assign(new Error("Cancelled response lost"), { status }); },
    async () => { reads++; return confirmedCancellation; },
  ), confirmedCancellation);
  assert.deepEqual([writes, reads], [1, 1]);
}
await assert.rejects(confirm(
  async () => { throw Object.assign(new Error("This quotation changed elsewhere"), { status: 409 }); },
  async () => assert.fail("No reconciliation after a known conflict"),
), /changed elsewhere/);
for (const item of [{ id: "wc" }, { id: "seat" }, { id: "new-seat", included_for_line_id: "wc" }]) {
  const unconfirmed = { ...confirmedCancellation, items: [item] };
  await assert.rejects(confirm(async () => unconfirmed, async () => unconfirmed), /Could not confirm/);
}

// Keep unavailable or unpriced physical lots out of quotation creation.
const lot = { id: 'stock', product_id: 'godown:stock', available_qty: 3, unit_price: 1200,
  price_variants: [{ label: 'With fittings', price: 1500 }] };
assert.deepEqual(godownQuotationPrice(lot), { price: 1200, label: null });
assert.deepEqual(godownQuotationPrice(lot, '0'), { price: 1500, label: 'With fittings' });
assert.deepEqual(godownQuotationPrice({ ...lot, unit_price: 0 }), { price: 0, label: null });
for (const patch of [{ archived: true }, { quantity_missing: true }, { product_id: null }, { available_qty: 0 }, { transferable_qty: 0 }]) {
  assert.throws(() => godownQuotationPrice({ ...lot, ...patch }), /no longer available/);
}
for (const unit_price of [null, undefined, NaN, -1, Infinity]) {
  assert.throws(() => godownQuotationPrice({ ...lot, unit_price }), /Record a unit price/);
}
for (const variant of ['', '1', '-1', 'NaN', '0.5']) {
  assert.throws(() => godownQuotationPrice(lot, variant), /variant is no longer available/);
}
console.log('Godown quotation source and price validation passed');

await import('./test-quotation-quick-add.mjs');
