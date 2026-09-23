import assert from "node:assert/strict";
import { addProductAndConcealedPart } from "../src/components/quotation/helpers/concealedParts.ts";

const product = {
  id: "trim", sku: "TRIM-1", name: "Wall mixer trim", price: 9000, mrp: 10000,
  category_id: "mixers", images: [], concealed_part: {
    sku: "BODY-1", product_id: "body", name: "Concealed body", unit_price: 4000, mrp: 4500, qty: 1,
  },
};
const id = (value) => `${value}-new`;
const once = addProductAndConcealedPart([], product, undefined, "Master Bath", id, null);
assert.equal(once.length, 2);
assert.deepEqual(once.map((line) => [line.product_id, line.qty]), [["trim", 1], ["body", 1]]);
const twice = addProductAndConcealedPart(once, product, undefined, "Master Bath", id, null);
assert.equal(twice.length, 2);
assert.deepEqual(twice.map((line) => [line.product_id, line.qty]), [["trim", 2], ["body", 2]]);
const inOtherRoom = addProductAndConcealedPart(twice, product, undefined, "Guest Bath", id, null);
assert.equal(inOtherRoom.length, 4);

// A part chosen in one product preview belongs to that quotation addition;
// it must not rewrite the product's catalog default or follow another item.
const selected = { sku: "BODY-2", product_id: "selected-body", name: "Selected body", unit_price: 4800, qty: 1 };
const quoted = addProductAndConcealedPart([], product, { sku: product.sku, price: product.price, mrp: product.mrp, concealed_part: selected }, "Master Bath", id, null);
assert.deepEqual(quoted.map((line) => line.product_id), ["trim", "selected-body"]);
assert.equal(product.concealed_part.product_id, "body");
const laterDefault = addProductAndConcealedPart([], product, undefined, "Master Bath", id, null);
assert.deepEqual(laterDefault.map((line) => line.product_id), ["trim", "body"]);

const cswWc = {
  id: "memoria-wc", sku: "5885B403H0101", name: "Memoria RIM-EX WC", price: 100180, mrp: 100180,
  category_id: "water-closets", images: [], specs: { default_included_parts: [{
    sku: "106-003H209", product_id: "memoria-cover", name: "Memoria seat cover", unit_price: 30430, mrp: 30430, qty: 1,
  }] },
};
const cswOnce = addProductAndConcealedPart([], cswWc, undefined, "Master Bath", id, null);
assert.deepEqual(cswOnce.map((line) => [line.product_id, line.qty, line.included_for_line_id != null]), [
  ["memoria-wc", 1, false], ["memoria-cover", 1, true],
]);
const cswTwice = addProductAndConcealedPart(cswOnce, cswWc, undefined, "Master Bath", id, null);
assert.equal(cswTwice.length, 2);
assert.deepEqual(cswTwice.map((line) => [line.product_id, line.qty]), [["memoria-wc", 2], ["memoria-cover", 2]]);
console.log("quotation concealed-part contract passed");
