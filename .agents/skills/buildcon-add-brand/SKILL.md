---
name: buildcon-add-brand
description: Add a Buildcon House brand and its products from a supplier workbook, CSV, or supported PDF. Use when the user supplies a catalogue for a new brand in a specified department.
---

Run the shared catalogue client from the repository root.

`python3 scripts/buildcon_catalogue.py import --floor sanitary --brand BIANA --operation add --create-brand --create-categories source.xlsx`

Choose the requested department and exact supplier name. The same command reuses an existing brand and skips its existing articles. Add `--apply` when the request authorizes importing the clean rows. Report additions, skipped articles, validation issues, and the job ID. Verify the new brand and a sample of products in the selected catalogue after completion.

For supplier layouts, source ranges, and recovery, see [Catalogue management](../../../docs/features/catalogue-management.md).
