import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { quotationGridColumns } from "../src/components/quotation/helpers/responsive.ts";
import { productImageList, resolveVariantImages } from "../src/components/quotation/helpers/media.ts";

// Phones retain two touch-friendly columns. Tablet picker widths use the
// available space to keep five complete choices in the first row.
assert.equal(quotationGridColumns(280), 2);
assert.equal(quotationGridColumns(320), 2);
assert.equal(quotationGridColumns(375), 2);
assert.equal(quotationGridColumns(390), 2);
assert.equal(quotationGridColumns(430), 2);
assert.equal(quotationGridColumns(479), 2);
assert.equal(quotationGridColumns(480), 3);
assert.equal(quotationGridColumns(575), 3);
assert.equal(quotationGridColumns(576), 4);
assert.equal(quotationGridColumns(640), 4);
assert.equal(quotationGridColumns(719), 4);
assert.equal(quotationGridColumns(720), 5);
assert.equal(quotationGridColumns(768), 5);
assert.equal(quotationGridColumns(800), 5);
assert.equal(quotationGridColumns(810), 5);
assert.equal(quotationGridColumns(1040), 5);
assert.equal(quotationGridColumns(1920), 5);
assert.equal(quotationGridColumns(600, true), 4);
assert.equal(quotationGridColumns(279), 1);
assert.deepEqual(productImageList({
  hero_image_url: "hero",
  gallery: [{ url: "gallery" }, { url: "hero" }],
  images: ["legacy", "gallery"],
}), ["hero", "gallery", "legacy"]);
assert.deepEqual(productImageList({
  hero_image_url: "thumbnail",
  family_key: "omega",
  gallery: [
    { url: "thumbnail", family_key: "omega", quality: "poor", width: 103, height: 162, is_primary: true },
    { url: "wrong-family", family_key: "sigma", quality: "acceptable", width: 365, height: 547 },
  ],
  images: [],
}), ["thumbnail", "wrong-family"]);
assert.deepEqual(productImageList({
  hero_image_url: "thumbnail",
  family_key: "omega",
  gallery: [
    { url: "thumbnail", family_key: "omega", quality: "poor", width: 103, height: 162, is_primary: true },
    { url: "original", family_key: "omega", quality: "acceptable", width: 365, height: 547 },
  ],
  images: [],
}), ["original", "thumbnail"]);
const chromeBase = {
  sku: "CHROME", hero_image_url: "chrome-hero", gallery: [{ url: "chrome-hero" }], images: ["chrome-hero"],
  variants: [{ sku: "BROWN-RED", image: "brown-red-hero", mrp: 1, price: 1 }],
};
assert.deepEqual(resolveVariantImages(chromeBase, chromeBase.variants[0]), {
  images: ["brown-red-hero"], isFallback: false,
});
assert.deepEqual(resolveVariantImages(chromeBase, { ...chromeBase.variants[0], image: null }), {
  images: ["chrome-hero"], isFallback: true,
});

// Keep this zero-config Node contract free of app-runtime imports. Importing
// tilePresentation used its @/ alias, which Node's strip-types runner cannot
// resolve and caused the quotation-media release gate to fail before running
// a single assertion.
const productImageSource = readFileSync(new URL("../src/components/ProductImage.tsx", import.meta.url), "utf8");
assert.match(productImageSource, /storage\/v1\/render\/image\/public/);
assert.match(productImageSource, /resize=contain/);
assert.match(productImageSource, /requestedWidth <= 1600 \? 1600 : 2048/);
assert.match(productImageSource, /const quality = width >= 1024 \? 90 : 85/);
assert.doesNotMatch(productImageSource, /resize=fill/);
assert.doesNotMatch(productImageSource, /scaleX:\s*-1/);
assert.doesNotMatch(productImageSource, /rotate:\s*rotation/);
assert.match(productImageSource, /contentFit=\{contentFit\}/);
assert.match(productImageSource, /preferOriginal/);

// Tile document frames are horizontal, but source media must remain upright
// and fully visible instead of being mirrored, rotated, or cropped.
const tilesDocBuilderSource = readFileSync(new URL("../src/components/tiles/TilesDocBuilder.tsx", import.meta.url), "utf8");
assert.match(tilesDocBuilderSource, /function TileImageCell\(\{ uri \}/);
assert.match(tilesDocBuilderSource, /contentFit="contain"/);
assert.doesNotMatch(tilesDocBuilderSource, /forceLandscape|tileNeedsLandscapeRotation|rotation=\{/);
const lineRowSource = readFileSync(new URL("../src/components/quotation/canvas/LineRow.tsx", import.meta.url), "utf8");
assert.doesNotMatch(lineRowSource, /<ProductImage source=\{l\.image\} mirror/);
assert.match(lineRowSource, /line-move-up-\$\{line\.id\}/);
assert.match(lineRowSource, /line-move-down-\$\{line\.id\}/);
assert.match(tilesDocBuilderSource, /This product has no image\. Add a product image before including it in a tile selection\./);
assert.match(tilesDocBuilderSource, /Every selected tile needs a product image before generating the PDF\./);
// Phone and tablet both use MobileTilesEditor. Keep downloading explicit in
// its persistent action bar rather than hiding it behind the overflow menu.
assert.match(tilesDocBuilderSource, /label="Download PDF" icon="download" onPress=\{doc\.generatePdf\}/);
assert.match(tilesDocBuilderSource, /testID="tiles-mobile-download-pdf"/);
const tilesStageSource = readFileSync(new URL("../src/components/tiles/tilesStage.ts", import.meta.url), "utf8");
assert.match(tilesStageSource, /if \(docType === "tiles_selection"\) return false/);

const builderSource = readFileSync(new URL("../src/components/quotation/context/BuilderContext.tsx", import.meta.url), "utf8");
const concealedPartSource = readFileSync(new URL("../src/components/quotation/helpers/concealedParts.ts", import.meta.url), "utf8");
const catalogServiceSource = readFileSync(new URL("../src/services/catalogService.ts", import.meta.url), "utf8");
assert.ok(builderSource.includes('api.get<Customer[]>("/customers", request)'), "missing essential customer bootstrap request");
assert.match(builderSource, /catalogReferences\.categories<Category\[\]>\(null, request\)/);
assert.match(builderSource, /catalogReferences\.brands<Brand\[\]>\(request\)/);
for (const endpoint of ["/products/recent", "/products/frequent", "/quotations/recent?limit=10", "/referrers"]) {
  assert.ok(builderSource.includes(endpoint), `missing lazy quotation request: ${endpoint}`);
}
assert.match(builderSource, /q\.trim\(\) \? 300 : 0/);
assert.match(builderSource, /loadMoreController\.current\?\.abort\(\)/);
assert.match(catalogServiceSource, /signal\?: AbortSignal/);
assert.match(builderSource, /retryReferenceData/);
assert.match(builderSource, /controller\.abort\(\)/);
// A picker card represents a family, but a selected swatch must be persisted
// as its own SKU/product so the saved quotation and PDF resolve its own media.
assert.match(builderSource, /addProductAndConcealedPart\(/);
assert.match(concealedPartSource, /const productId = variant\?\.id \|\| product\.id/);
assert.match(concealedPartSource, /image: variant\?\.image \|\| primaryImage/);
assert.match(builderSource, /const selectedProductId = variant\?\.id \?\? target\.id/);
assert.match(builderSource, /image: variant \? variant\.image \?\? null : productImageList\(target\)\[0\] \?\? null/);
const assistantSource = readFileSync(new URL("../src/components/quotation/panes/AssistantPane.tsx", import.meta.url), "utf8");
assert.match(assistantSource, /focusedLine\?\.image/);
assert.match(assistantSource, /height: 148/);

console.log("quotation media/layout helpers: 46 assertions passed");
