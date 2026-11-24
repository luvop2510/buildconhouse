---
name: buildcon-sync-catalogue
description: Reconcile a complete revised supplier catalogue with an existing Buildcon House brand. Use for mixed product additions, changes, categories, and media rather than a price-only import.
---

`python3 scripts/buildcon_catalogue.py import --floor tiles --brand MCM --operation sync supplier.xlsx`

Select source sheets and ranges the user actually supplied. Add `--create-categories` if authorized and `--apply` if the user requests applying verified changes. Report new, updated, unchanged, rejected, and absent articles. Absent articles stay in the catalogue. Product archival requires separate explicit authorization. Verify one representative changed product and price through the selected floor’s catalogue.

See [Catalogue management](../../../docs/features/catalogue-management.md) for source formats and verification.
