# Stock image delivery and recoverable originals — 25 October 2026

Live evidence separates missing image sources from unavailable storage. The
read-only discovery phase is followed by a bound, exact-byte restoration plan;
copy/application outcomes are recorded below as verified. No frontend/backend
publication is claimed.

## Current stock evidence

The current floor-scoped stock resolver found 1,015 active Sanitary lots:
896 have stored image URLs and 119 have no resolved URL. Missing URL counts are
Grohe 57, Vitra 46, Hansgrohe 9 and Geberit 7. None of those 119 lots has one
exact same-floor, same-brand catalog candidate with an image. Stock-only
`godown:` identities must not acquire catalog links through a similar SKU.

All seven supplied workbook SHA256 identities were revalidated before source
correlation. Of the 119 missing-URL lots, 115 have no source-embedded photo and
four have two distinct embedded candidates each. Visual inspection found
different objects on the two Hansgrohe rows, while the two Grohe rows contain
small duplicated-looking product thumbnails. Neither anchor proximity nor
visual resemblance establishes exact ownership or an acceptable replacement
master. These remain review candidates, not applied corrections.

The bounded delivery audit checked 887 unique current image URLs, with four
concurrent HTTPS reads and at most 64 KiB examined per URL. It found:

| Current lot state | Lots |
| --- | ---: |
| Image URL responds and image header decodes | 630 |
| Supabase image URL returns HTTP 402 | 266 |
| No resolved image URL | 119 |

Every checked Cloudflare URL responded successfully. Every checked legacy
Supabase URL returned 402. Header decoding is not full-image verification and
does not establish SKU/finish ownership. These are measured responses from this
run, not a guarantee of future availability.

All 266 corresponding same-key public R2 candidates were also probed and failed
HTTP delivery. Do not repair these links by merely changing their hostname.

## Recovery evidence

Of those broken URLs, 264 have exact stock-media metadata records. Source images
from the supplied workbooks were hashed after the existing normalization helper.
248 media records match those bytes by SHA256 and also match their stock lot's
source SKU and brand. Their source bytes total 2,035,462 bytes. This is restoration
of the existing media content, not new manufacturer-image enrichment or a claim
of 4K quality. The other 16 stock-media records have no matching source bytes in
these workbooks. Two broken URLs are outside this stock-media match set.

The next storage repair must revalidate current lot/media identities, stage and
checksum the exact local bytes, bind its plan to the Mongo and storage identity,
conditionally create missing target objects, verify full downloaded target bytes
and public delivery, then conditionally update only reviewed references with a
private before/after journal. Preserve existing objects, historical audit/import
records and unrelated current edits. Existing recovery/publication gates remain.

## Local interface repair and acceptance

The stock photo frame now explicitly distinguishes “Photo needed,” “Loading
photo” and “Photo unavailable.” This optional ProductImage behavior is enabled
for stock cards; other consumers retain their existing interface. Replacing a
failed URL resets the image state and removes the failure copy when the image
loads. Image problems do not remove the stock editing/transfer actions.

The new scenario passed on desktop, tablet and phone. The complete stock-editor
suite then passed 32 cases across those three layouts plus WebKit, with zero
retries. TypeScript, focused ESLint and 46 quotation-media assertions passed.
The fresh web export completed; all 187 frozen-export bundle budgets passed
(largest 483 KiB gzip against 576 KiB). Desktop/tablet/phone screenshots were inspected.
This is a fixture UI verification, not live image restoration or acceptance of
the remaining stock list redesign. The first-render performance failures in the
pagination report remain unresolved.

## Backend read timing diagnostic

Three sequential calls per floor ran the current local paged route against the
configured live Mongo with no server startup or writes. Sanitary returned 60 of
1,015 lots, approximately 72.5 KB JSON, at 1,278 / 673 / 667 ms. The other floors
had zero stock lots and returned in approximately 42–78 ms. This measures only
this stock route; it does not establish timings for other pages, authentication,
proxy readiness, browser rendering or loaded images.

The Sanitary page find examined 1,023 keys/documents and used an in-memory sort;
Mongo reported 10 ms execution for that find. A matching pagination index is a
candidate for measured improvement, not a demonstrated fix for the remaining
browser startup delay. No production index was created.

Private row/URL/hash evidence and reproducible audit scripts are under the parent
workspace's `outputs/godown-review-2026-10-24/`. Public summaries include
`stock-image-coverage-summary.json`, `stock-image-url-summary.json`,
`original-photo-recovery-summary.json`, `legacy-r2-candidates-summary.json` and
`stock-paged-read-latency.json`.

The 248-file recovery plan was staged with current lot/media validation, complete
before-state records, source workbook identities and a Mongo/storage binding.
Its plan SHA256 is
`b409d4efd8d91e51523eeb0d3cf32cf4257a57fe80d4cd395991a6b8b032783f`.
The independent apply preflight passed before requesting conditional object
creation. All 248 objects were then conditionally created and fully downloaded
through authenticated R2 and public HTTP; both SHA256 values match each source.
The copy summary and 248 per-object receipts are retained. No old object was
overwritten or deleted.

The conditional reference plan was independently inspected: exactly 248 stock
`image` fields and 248 matching stock-media `public_url` fields change. Each
mapping preserves its exact object key and floor. No other field differs.
Reference-plan SHA256:
`910312144beab714e70bf411b8076f35730f69464a05ad175720bfe9ea70c6f9`.
Application is only complete when the apply summary and current stock pointers
have been verified; do not infer completion from the copied objects alone.

Final application is verified: all 496 conditional document updates match the
reviewed after-state. The complete rollback journal was uploaded to private R2
and verified by full readback before updates. Independent verification compared
each complete restored lot/media document with its full before-state backup:
only the two reviewed URL fields differ. All 1,015 active lot IDs and quantities
also match the pre-recovery audit. There remain 119 lots with no resolved image
URL, 18 legacy Supabase URLs and 360 unknown quantities. The repaired 248 stock
photos are a live data/storage repair; the new frontend photo-state UI remains
local and unpublished. This is not completion of overall photo identity/quality
coverage or the stock improvement goal.

Authoritative completion summaries:
`original-photo-restoration-copy-summary.json`,
`original-photo-reference-apply-summary.json` and
`original-photo-restoration-verification.json` in the parent review directory.
