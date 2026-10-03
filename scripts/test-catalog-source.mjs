import assert from "node:assert/strict";
import { catalogPriceUnknown, catalogProductDetailPath, manualCatalogPrice, supplierSourceDetails } from "../src/components/quotation/helpers/catalogSource.ts";

assert.equal(catalogProductDetailPath("canonical-sku", "supplier/second row"), "/products/canonical-sku?catalog_entry_id=supplier%2Fsecond%20row");
assert.equal(catalogProductDetailPath("canonical-sku"), "/products/canonical-sku");

assert.equal(catalogPriceUnknown({ price_unknown: true }), true);
assert.equal(catalogPriceUnknown({ price_unknown: true }, { price_unknown: false }), false);
assert.equal(catalogPriceUnknown({ price_unknown: false }, { price_unknown: true }), true);
assert.equal(catalogPriceUnknown({}), false);
for (const invalid of ["", " ", "0", "-100", "Infinity", "NaN", "abc"]) {
  assert.equal(manualCatalogPrice(invalid), null);
}
assert.equal(manualCatalogPrice("1250.50"), 1250.5);

const exact = "Supplier wording: preserved punctuation, case & finish.\nSecond line.";
const entries = [{
  category_name: "Wash Basins", subcategory: "Ceramics", name: exact,
  description: exact, source_sku: "01800187", source_status_note: "DISCONTINUE limited quantity",
  source_cells: { A: { value: 7 }, B: { value: "01800187" }, C: { value: exact },
    D: { value: "Every extra-column word appears" }, E: { value: 100 }, F: { value: null } },
}];
const texts = supplierSourceDetails(entries);
assert.deepEqual(texts, ["Wash Basins", "Ceramics", exact, "01800187", "DISCONTINUE limited quantity", "Every extra-column word appears"]);
assert.equal(texts.filter((text) => text === exact).length, 1);
assert.deepEqual(supplierSourceDetails(), []);
console.log("Catalog source words and manual price checks passed");
