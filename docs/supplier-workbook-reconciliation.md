# Hansgrohe and Grohe supplier workbooks

The supplier catalog stores one canonical product for each brand/article identity.
`catalog_entries` retains every worksheet occurrence, including repeated articles,
exact supplier descriptions, original serial numbers, worksheet names, section
headings, prices, and source cells. Missing price/image/description data never
excludes a product. Supplier words are indexed in `catalog_search_text`.

The checked-in source manifest records Hansgrohe first and Grohe second. The
source files contain 2,255 product rows and 2,095 distinct brand/article identities.
Grohe's `TOTAL` sheet is a quotation summary, not a product category. Every other
product worksheet is represented, including `DISCONTINUE`.

The Grohe WC price rule is E (`mrp 2026`) first, then F (`MRP`) if E is blank.
Both values remain in the source metadata. Repeated articles with different
descriptions/prices keep placement-specific values. Canonical pricing uses the
first supplied price in workbook order. A missing supplier price retains a known
existing price when available; otherwise `price_status=unspecified` distinguishes
the required numeric storage placeholder from an actual zero supplier price.

Three numeric Hansgrohe articles lost their leading zero in Excel's General
format. Manufacturer-confirmed aliases match the existing canonical identifiers:

| Source value | Canonical identifier | Evidence |
|---|---|---|
| 1800187 | 01800187 | [Manufacturer assembly guide](https://assets.hansgrohe.com.cn/mam/celum/celum_assets/16__hrgh2351_pdf.pdf) |
| 1500180 | 01500180 | [Manufacturer product](https://www.hansgrohe.com.au/articledetail-ibox-universal-2-basic-set-01500180) |
| 1400180 | 01400180 | [AXOR product](https://www.axor-design.com/uk/articledetail-axor-ibox-universal-2-basic-set-01400180) |

The raw spreadsheet values remain in their source entries. No other identifiers
are guessed or corrected.

Family navigation follows the reviewed supplier model stems without merging
product records. Grohe stems `27572`, `22009`, `19571`, `19506`, `32468`, and `13255`
contain different named models/revisions and retain independent SKU navigation.
Source descriptions remain exact even where supplier size/function labels differ
from manufacturer documentation. For example, [Grohe's Tempesta brochure](https://cdn.cloud.grohe.com/Literature/Brochures/bg_BG/GROHE_Tempesta_Brochure_bg_BG/original/GROHE_Tempesta_Brochure_bg_BG.pdf)
distinguishes the old/new articles `27572002` and `27572003`.

## Run the reconciliation

Use the existing configured backend Python environment. Credentials are supplied
through the process environment or a gitignored `--env-file`; never commit them.

```sh
python scripts/reconcile_supplier_workbooks.py --report /path/to/plan.json
python scripts/reconcile_supplier_workbooks.py --execute \
  --backup-dir /path/to/new-backup-directory --report /path/to/result.json
python scripts/reconcile_supplier_workbooks.py --execute --images \
  --workbook-dir /path/to/workbooks --report /path/to/image-result.json
```

The first command is read-only. The second saves product, category, brand and
media before-images, then applies the product/category/brand changes in one
transaction. It verifies every source occurrence before committing, preserves
existing product IDs and stock, and never deletes historical products or media.
Brands marked `catalog_authoritative` use the workbook's products/categories in
current browsing while old product IDs remain accessible for existing business
records. Product cards are deduplicated after category/search filtering.

Images are registered through the existing media service with exact worksheet
provenance. Source SHA256 hashes are checked before upload. Per-product locks and
content hashes make image replay safe. Better existing photos and human or
manufacturer media retain priority; older objects remain available for rollback.
An unverified or absent image leaves the product visible with a placeholder.

Deploy the compatible application code before applying source-only brand
metadata. Confirm the complete source set, ordering, search coverage, category
membership, unknown-price visibility, stable stock IDs, media registration and
production health after the import. The catalog snapshot refreshes periodically;
verification must use the refreshed snapshot.

## Rollback

The backup contains full before-images plus the plan/result. Restore only the
target brands and product/category fields changed by this import; retain any
concurrent stock or business edits. New source products should be disabled rather
than deleted if they have acquired business references. New media can be demoted
without deleting its source objects. Removing `catalog_authoritative` from the
two brands restores the historical catalog view immediately after cache refresh.
