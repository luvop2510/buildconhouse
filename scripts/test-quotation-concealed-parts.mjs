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
console.log("quotation concealed-part contract passed");
