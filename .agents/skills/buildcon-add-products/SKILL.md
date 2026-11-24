---
name: buildcon-add-products
description: Add missing SKU records to an existing Buildcon House brand from selected Excel, CSV, or supported PDF content. Use for additive imports, including a requested supplier sheet or PDF page range.
---

Run the shared catalogue client with an existing brand and the requested scope.

`python3 scripts/buildcon_catalogue.py import --floor sanitary --brand GROHE --operation add --printed-pages 405-427 supplier.pdf`

Use `--sheet` for a named workbook tab or `--physical-pages` for one-based file page indexes. Add `--create-categories` when the request includes new categories and `--apply` when it authorizes importing clean rows. Existing SKUs retain their IDs, fields, and prices. Verify a sample in the catalogue and applicable quotation picker.

For source mapping and recovery, see [Catalogue management](../../../docs/features/catalogue-management.md).
