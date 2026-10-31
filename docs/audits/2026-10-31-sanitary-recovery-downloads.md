# Sanitary quotation and purchase repair — 31 October 2026

The three supplied phone screenshots show fixed builder/export/filter controls
occupying the product viewport, a failed draft save, and a redundant commercial
summary page before PO Final products. Scope is the existing interface and
workflow; there are no new catalog entries, business-data rewrites or migrations.

## Causes and changes

- Compact builder and product-picker controls belong to their list's scrolling
  header. Fullscreen keeps the compact Exit control; leaving it restores the
  editing/review tools. Preserve focus, room selection, dragging and draft state.
- Explicit saved-quotation routes previously skipped all local recovery drafts.
  They now offer only a draft matching that quotation, account and floor. Draft
  writes register immediately so navigation cannot cancel a pending debounce.
- The Sanitary PDF image path explicitly rotated portrait product photos by
  90 degrees and trimmed white image margins. The user's final clarification
  makes strict preservation PDF-only on Sanitary: preserve normalized catalog
  orientation, full canvas and aspect ratio, with no additional rotation,
  cropping, stretching or forced landscape. Other floors and catalog ingestion
  retain their existing behavior. One bounded prefetch snapshot supplies product,
  seat-cover and dimension images; rendering never retries missing remote images
  serially. Unavailable optional photos retain the placeholder behavior.
- Quotation image ownership checks use the existing exact-product catalog helper,
  avoiding a cold full-catalog rebuild during saves, reads and exports. Floor,
  SKU and image-ownership validation remain in place.
- Sanitary PO Final uses its original cover followed by products. Real payment
  and additional-cost information flows after products without a forced extra
  summary page. Quotation choices select metadata only; the selected document
  alone loads its full history, and independent history reads overlap.
- Purchase status/history and received quantities use one floor-scoped,
  snapshot-guarded update. A 30-line delivered fixture requires one write rather
  than 31. Bulk moves overlap at most three independent POs and retain sequential
  changes within each PO. Exact result order, per-item errors, receipts and
  explicit retries remain. An unchanged retry completes pending status repair.
- Download actions already use the authenticated file helper: named browser
  downloads, a fresh-tap mobile Download/Save or share panel, and native file
  sharing. They do not call the PDF preview action. Keep its 30-second preparation
  bound and identity cancellation; the user's save destination dialog has no
  preparation timeout. No security, cache or request deadlines were relaxed.

## Verification and limits

Focused document tests: 147 passed. Focused purchase tests: 91 passed, including
same-PO contention, partial failures, status repair and legacy missing item IDs.
The reciprocal backend reviews found no unresolved blocking issue. The full
hermetic backend unit suite passes 4,068 tests. Download/native-file and both API
client contracts pass, including failures, deadlines and identity/floor races.
Final focused browser acceptance covers 47 scenarios, including four iPhone
Safari cases and a paused-clock check proving immediate local draft registration.
Phone fullscreen, scrolled quotation and scrolled picker renders were reviewed.
Two older standalone fixtures needed their current React state/phone-formatter
dependencies restored; their existing keyboard and failed-intake assertions pass.
TypeScript, lint, clean lockfile installation and the security gate pass.

Before deployment, a bounded authenticated read of the screenshot quotation
returned its summary in 546 ms, detail in 347 ms, Excel in 1,741 ms and PO Final
JSON in 581 ms. Its first PDF transferred in 22,810 ms while server application
time was 3,273 ms; these are separate measurements. They demonstrate that local
rendering changes cannot certify the user's network or eliminate all transport
failures. Recent Railway HTTP samples also include successful PDF/Excel/movement
requests; no persistent backend error was reproduced in the inspected logs.

Final release/performance and publication results belong to the source-bound
receipt in `outputs/sanitary-repair-2026-10-31` at the workspace root. The unchanged
pre-push hook runs the complete audit before publication. Browser emulation is not physical-iPhone or
signed-native acceptance. No business writes are used for hosted verification;
only the run-owned short-lived QA session is created and revoked.

## Tile document existing-person reuse

Both tile document types expose Existing customer beside the customer field,
using the same component on phone, tablet and desktop. Discovery reads contact
fields from Customers, Walk-ins and Follow-ups on every account-permitted floor,
rechecking source resource grants. Selection revalidates its source, reuses an
existing Ground profile or upserts a deterministic profile identity; it never
moves source financial/workflow records. Contact and referral fields populate the
existing builder state and draft/autosave path. Search is literal, bounded and
paged; obsolete reads and closed/unmounted pickers cannot publish selections.

Six focused backend cases verify all-floor owner discovery, contact whitelists,
literal bounded queries, source denial, existing-profile preservation and stable
retry identity. Six browser cases pass across phone, tablet and desktop for both
Selection and Quotation, choosing a Follow-up from another floor and filling the
customer field. TypeScript and zero-warning lint pass. No production business
write is used to demonstrate this feature.

The subsequent user instruction retires customer company, alternate phone, city,
state, PIN and GST fields throughout customer entry, display and exports. These
fields are omitted from customer create/update/public serialization, rather than
unsetting historical database values. Customer names replace company-name
fallbacks in newly generated quotation/follow-up/transfer snapshots. Supplier,
brand and operator company settings remain separate business entities.
