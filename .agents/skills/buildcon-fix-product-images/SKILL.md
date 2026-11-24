---
name: buildcon-fix-product-images
description: Repair missing or incorrect Buildcon House product photos using supplied, article-matched catalogue images. Use when catalogue or quotation PDF images are unavailable or depict the wrong variant.
---

Identify the affected article numbers and finishes in the selected floor and brand. Use a source with exactly those articles and embedded photos or a supported PDF layout with verified image mapping.

`python3 scripts/buildcon_catalogue.py import --floor sanitary --brand Vitra --operation images verified-images.xlsx`

Add `--apply` when the user requests the repairs. The importer reuses stored identical image bytes. Resolve ambiguous matches from source evidence. Verify the exact finish in the catalogue and an authorized quotation PDF. Report any articles or image references that still need review.

See [Catalogue management](../../../docs/features/catalogue-management.md) for image scope and recovery.
