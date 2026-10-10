# Company catalog revisions and quotation price decisions

Company CSV/XLSX imports now use deterministic parsing with no AI provider or
model tokens. The required company file headers are `sku`, `name`, `category`,
`mrp`; `dealer_price` and ProductRow description/finish/size fields are optional.
XLSX embedded images are matched by their row anchors. Known manufacturer
adapters retain their existing supported formats. Unknown companies must use
CSV/XLSX; arbitrary PDFs are not guessed. Removed suppliers remain rejected.

Updates match `(floor_id, brand_id, sku)` and keep durable product IDs.
Price-only files preserve previously verified images and missing scalar
metadata. New image bytes use the existing content-addressed storage/dedupe
path; failed or unavailable images fail their row for retry. Re-selecting a
previously demoted supplier image promotes its existing pointer without
uploading duplicate bytes. No file objects are deleted during an update.
Finite, nonnegative prices are required. Changed rows record catalog version,
actor, job, modification time and price-change time. Repeated identical rows
skip the write and history. Rollback snapshots are persisted before product
mutation. Existing-row writes compare the prior catalog version, so concurrent
changes fail the row for review/retry instead of silently overwriting prices.

New quotation lines store catalog price/MRP/version independently of negotiated
offer prices. Autosaves preserve that snapshot for the same product and line.
Only open, unfinalized quotations compare current catalog prices. Sent,
approved, ordered, won, lost and cancelled quotations keep stored prices;
ordered_at is also a freeze marker. A changed open quotation requires an
explicit original/latest choice when creating the PO. Both builder Place Order
and shared PO Review show the responsive price dialog. A digest includes quote
update time and changed catalog values; changes since the review return 409 and
a fresh review. The choice, actor and date are saved with order placement in the
same Mongo transaction. Latest prices recalculate net values with existing
product/room/category/project discounts. Tile Box rates multiply current
per-sqft rates by box sqft; Pieces remain per-piece rates. Godown-reserved lines
are excluded. Confirmed tile quotations are already approved and retain their
confirmed commercial rates.

The importer retains the existing admission, process resource, deadline,
file-size, row-count and Mongo document-size limits, and 20-row jobs. Large
supplier files must be split when those limits are reached. It does **not**
claim unlimited capacity. The warmed snapshot has a shared 32 MiB BSON budget
and collection row budgets; small cursor batches stop loading when either is
exceeded. The partial snapshot is discarded and all catalog reads switch to
Mongo filtering, grouping, counting and pagination. Requested pages hydrate
only their scoped product relationships and media. Related-response budgets
return an explicit 413 requiring narrower filters rather than silently losing
records. Query deadlines and disk-backed aggregations bound database work.
Migration 0029 adds floor/company/category, family, configuration, media-owner
and usage indexes. The existing 6,565-product catalog retains its fast warmed
read path. Real isolated Mongo tests cover 10,004 floor-scoped products, late
pages, counts, placements, families, facets, media and parity with the cache.
Supplier source files and images remain stored once by content hash; Mongo
stores references and audit metadata, rather than duplicating image bytes.
