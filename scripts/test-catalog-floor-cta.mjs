import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const catalogDetail = readFileSync(new URL("../app/(admin)/catalog/[id].tsx", import.meta.url), "utf8");
const tilesQuotationRoute = readFileSync(new URL("../app/(admin)/tiles/quotation.tsx", import.meta.url), "utf8");
const quotationBuilder = readFileSync(new URL("../src/components/quotation/QuotationBuilder.tsx", import.meta.url), "utf8");
const tilesBuilder = readFileSync(new URL("../src/components/tiles/TilesDocBuilder.tsx", import.meta.url), "utf8");

// A Ground Floor product must enter the tile workflow and arrive as a selected
// line item. Other currently unsupported floors must not be sent into the
// Sanitary builder by accident.
assert.match(catalogDetail, /p\.floor_id === "ground-floor"/);
assert.match(catalogDetail, /\(admin\)\/tiles\/quotation\?productId=\$\{p\.id\}/);
assert.match(catalogDetail, /p\.floor_id === "second-floor"/);
assert.match(tilesQuotationRoute, /initialProductId=\{productId \|\| null\}/);
assert.match(quotationBuilder, /<TilesDocBuilder docType=\{mode\} initialProductId=\{initialProductId \|\| null\}/);
assert.match(tilesBuilder, /function useTilesDoc\(docType: TilesDocType, initialProductId\?: string \| null\)/);
assert.match(tilesBuilder, /api\.get<Product>\(`\/products\/\$\{initialProductId\}`/);
assert.match(tilesBuilder, /if \(!initialProductId \|\| routeId/);

console.log("catalog floor quotation CTA contract: 8 assertions passed");
