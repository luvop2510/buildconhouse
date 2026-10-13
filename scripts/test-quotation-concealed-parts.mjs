import assert from "node:assert/strict";
import { addProductAndConcealedPart, syncDefaultIncludedParts } from "../src/components/quotation/helpers/concealedParts.ts";

const product = {
  id: "trim", sku: "TRIM-1", name: "Wall mixer trim", price: 9000, mrp: 10000,
  category_id: "mixers", images: [], concealed_part: {
    sku: "BODY-1", product_id: "body", name: "Concealed body", unit_price: 4000, mrp: 4500, qty: 1,
  },
};
let nextId = 0;
const id = (value) => `${value}-new-${nextId++}`;
const once = addProductAndConcealedPart([], product, undefined, "Master Bath", id, null);
assert.equal(once.length, 2);
assert.deepEqual(once.map((line) => [line.product_id, line.qty]), [["trim", 1], ["body", 1]]);
const twice = addProductAndConcealedPart(once, product, undefined, "Master Bath", id, null);
assert.equal(twice.length, 2);
assert.deepEqual(twice.map((line) => [line.product_id, line.qty]), [["trim", 2], ["body", 2]]);
const inOtherRoom = addProductAndConcealedPart(twice, product, undefined, "Guest Bath", id, null);
assert.equal(inOtherRoom.length, 4);

// The pure quotation expansion accepts the server-confirmed association.
// The modal persists this value before adding and mirrors it into its picker.
const selected = { sku: "BODY-2", product_id: "selected-body", name: "Selected body", unit_price: 4800, qty: 1 };
const quoted = addProductAndConcealedPart([], product, { sku: product.sku, price: product.price, mrp: product.mrp, concealed_part: selected }, "Master Bath", id, null);
assert.deepEqual(quoted.map((line) => line.product_id), ["trim", "selected-body"]);
assert.equal(product.concealed_part.product_id, "body");
const savedProduct = { ...product, concealed_part: selected };
const laterDefault = addProductAndConcealedPart([], savedProduct, undefined, "Master Bath", id, null);
assert.deepEqual(laterDefault.map((line) => line.product_id), ["trim", "selected-body"]);
// Exact sibling variants have independent associations, including explicit removal.
const sibling = { id: "trim-black", sku: "TRIM-BLACK", price: 9500, mrp: 10500 };
assert.deepEqual(addProductAndConcealedPart([], product, sibling, "Master Bath", id, null).map((line) => line.product_id), ["trim-black"]);
assert.equal(addProductAndConcealedPart([], product, { sku: product.sku, price: product.price, mrp: product.mrp, concealed_part: null }, "Master Bath", id, null).length, 1);
const batch = addProductAndConcealedPart([], { ...product, concealed_part: { ...selected, qty: 2 } }, undefined, "Master Bath", id, null, 4, "Bathroom wall");
assert.deepEqual(batch.map((line) => line.qty), [4, 8]);
assert.equal(batch[0].notes, "Bathroom wall");
assert.equal(batch[1].included_for_line_id, batch[0].id);
assert.equal(batch[1].included_qty_per_parent, 2);
const replaced = syncDefaultIncludedParts(batch, { ...batch[0], qty: 3 }, savedProduct, undefined, id);
assert.deepEqual(replaced.filter((line) => line.included_for_line_id === batch[0].id).map((line) => [line.product_id, line.qty]), [["selected-body", 3]]);
assert.equal(addProductAndConcealedPart([], product, undefined, "Master Bath", id, null, NaN).length, 0);

// Changing the saved link affects future additions, preserving previous lines.
const changedLink = addProductAndConcealedPart(once, savedProduct, undefined, "Master Bath", id, null);
assert.deepEqual(changedLink.filter((line) => !line.included_for_line_id).map((line) => line.qty), [1, 1]);
assert.deepEqual(changedLink.filter((line) => line.included_for_line_id).map((line) => line.product_id), ["body", "selected-body"]);
const changedPartPrice = addProductAndConcealedPart(once, { ...product, concealed_part: { ...product.concealed_part, unit_price: 5000 } }, undefined, "Master Bath", id, null);
assert.deepEqual(changedPartPrice.filter((line) => line.included_for_line_id).map((line) => line.unit_price), [4000, 5000]);

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
// Different quotation prices create separate parent lines. Included parts must
// follow the line that was just added, leaving the earlier line untouched.
const discounted = addProductAndConcealedPart(cswOnce, cswWc, {
  sku: cswWc.sku, price: 90000, mrp: cswWc.mrp,
}, "Master Bath", (value) => `${value}-discounted`, null);
const regularParent = discounted.find((line) => line.product_id === cswWc.id && line.unit_price === cswWc.price);
const discountedParent = discounted.find((line) => line.product_id === cswWc.id && line.unit_price === 90000);
assert.equal(regularParent.qty, 1);
assert.equal(discountedParent.qty, 1);
assert.deepEqual(discounted.filter((line) => line.included_for_line_id === regularParent.id).map((line) => line.qty), [1]);
assert.deepEqual(discounted.filter((line) => line.included_for_line_id === discountedParent.id).map((line) => line.qty), [1]);
const standaloneCover = {
  id: "memoria-cover", sku: "106-003H209", name: "Memoria seat cover",
  price: 30430, mrp: 30430, category_id: "seat-covers",
};
const withStandaloneCover = addProductAndConcealedPart(cswOnce, standaloneCover, undefined, "Master Bath", (value) => `${value}-standalone`, null);
assert.equal(withStandaloneCover.filter((line) => line.product_id === standaloneCover.id).length, 2);
assert.equal(withStandaloneCover.find((line) => line.included_for_line_id === cswOnce[0].id).qty, 1);
assert.equal(withStandaloneCover.find((line) => line.product_id === standaloneCover.id && !line.included_for_line_id).qty, 1);
// Custom descriptions survive the same add/quantity expansion as catalog lines.
const described = addProductAndConcealedPart([], { ...product, description: "Cut to customer dimensions" }, undefined, "Master Bath", id, null);
assert.equal(described[0].description, "Cut to customer dimensions");
const variantDescription = addProductAndConcealedPart([], { ...product, description: "Base specification" }, {
  sku: product.sku, price: product.price, mrp: product.mrp, description: "Exact variant specification",
}, "Master Bath", id, null);
assert.equal(variantDescription[0].description, "Exact variant specification");
console.log("quotation concealed-part and custom-description contract passed");
