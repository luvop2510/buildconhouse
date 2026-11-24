---
name: buildcon-manage-categories
description: Create or reuse a brand-specific category in the Buildcon House catalogue and assign supplied products. Use for targeted category additions or product placement.
---

For a category-only request with a named department and existing brand, run:

`python3 scripts/buildcon_catalogue.py category --floor sanitary --brand GROHE --name 'Basin'`

For products, include the confirmed Category in the source workbook. Use `import --operation add --create-categories` for new products, or `--operation update --create-categories` for existing SKUs. In an assignment-only update, include just Article No. and Category. Add `--apply` when the user authorizes the import. Verify the returned category and a sample of the assigned products through catalogue navigation or search.

See [Catalogue management](../../../docs/features/catalogue-management.md) for controls and recovery.
