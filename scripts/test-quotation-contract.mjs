import assert from "node:assert/strict";

import { computeQuotationTotals } from "../src/components/quotation/helpers/totals.ts";
import { godownQuotationPrice } from "../src/components/quotation/helpers/godown.ts";
import { enqueueQuotationPersist } from "../src/components/quotation/helpers/autosave.ts";

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
