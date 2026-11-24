---
name: buildcon-update-prices
description: Update Buildcon House catalogue MRP by exact department, brand, and article number from an Excel workbook, CSV, or supported supplier PDF. Use for price-only MRP changes.
---

`python3 scripts/buildcon_catalogue.py import --floor sanitary --brand GROHE --operation prices prices.xlsx`

Run this directly for Article No. and New MRP columns or a verified MRP-only supplier list. Keep exported Current MRP, when present, as the concurrency check. Add `--apply` when the user requests the update. For a preview, stop at the job summary. Report unmatched codes and conflicting prices. Selling prices, other product fields, historical quotations, and placed orders retain their saved values.

For source formats and error reports, see [Catalogue management](../../../docs/features/catalogue-management.md).
