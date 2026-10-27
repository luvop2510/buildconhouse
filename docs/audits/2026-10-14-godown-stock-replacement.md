# Godown inventory replacement — 14 October 2026

Seven supplied stock workbooks replace the active sanitary inventory. The
reviewed plan contains 1,015 distinct lots and 4,393 recorded units. Eighteen
verified Grohe summary/template repeats are consolidated without adding their
quantities twice. Independent repeated lines and split Vitra seats retain
distinct identities and original worksheet provenance.

The new Duravit brand has eleven products and 32 recorded units. Official
manufacturer images and canonical identifiers are verified; original source
codes remain on stock lots. Duravit prices intentionally remain unknown for
later user entry. Numeric product-model defaults carry an explicit unspecified
price marker and cannot turn direct stock intake into an asserted zero price.

Exact floor/brand/product matching, reviewed Grohe transcription aliases,
supplier workbooks and official Geberit evidence enrich the inventory. The
reviewed plan still contains 353 unrecorded prices, 119 missing images and
360 unrecorded quantities. Missing quantities have a flagged zero technical
placeholder, display “Quantity not recorded”, and cannot be allocated.
Missing prices stay null; transfers require an explicitly entered selling
price. Missing media stays empty. No unrelated finish or guessed price fills
a source gap.

Stock cards support price and HTTPS image URL editing, photo uploads, image
removal and optional price variants. Photos use immutable storage objects and
separate lot-scoped metadata, preserving catalog and issued-document images.
The shared upload transport retains the original browser File under the
production CSP and enforces bounded photo envelopes, floor and permissions.

The stock response excludes bulky private import provenance, returns the
complete bounded inventory and explicitly rejects more than 2,000 lots instead
of silently truncating. The UI initially renders 60 cards, expands in batches,
and searches the complete response. Archived lots are excluded even when
ordinary zero-stock history is requested. Allocation and quotation matching
reject superseded and uncounted stock.

The controlled import validates source/media hashes, database identity,
manifest hash, active owner and the existing stock fingerprint. It captures
a private rollback snapshot, stages registered photos, rechecks stock inside
a MongoDB transaction, archives the eight old lots and inserts the replacement
plus Duravit records and a durable receipt. Customer, purchase, payment and
allocation history remain intact. Replays cannot reset subsequent stock edits.

Local verification includes responsive price/image/upload journeys across
eight profiles, stock-transfer regressions, hermetic import/permission/floor
tests, TypeScript, lint and current-source performance acceptance. The complete
performance audit passed 52 scenarios with no retries/skips/flakes; all 159
exported pages meet the 576 KiB gzip budget (largest 452 KiB). A previous
contended run failed the unrelated iPhone Team loading budget and is retained
in local evidence; the uncontended complete run passed unchanged limits.

## Publication and live reconciliation

Runtime source `3b58bcbb` is published on the existing feature branch. A
concurrent customer-outcome commit removed its accidentally included warehouse
identity hunk; that remote change was merged and the stock-specific hunk restored
in `724ef380`. The two source trees are byte-identical (`git diff` is empty).
The GitHub push passed the unchanged full performance hook and retained main's
review/status protections. PR #16 remains the review surface; existing dependency
security findings are not suppressed or represented as a green security gate.

Vercel deployment `dpl_Ah6NsPx87XDKXaJBMrmDLTx9NLdv` is READY and serves both
production domains, with the API function in `bom1`. Railway deployment
`fe452edf-20d0-4c90-8af7-11f153010643` is SUCCESS, with one Singapore replica and
sleep disabled. The first Railway upload timed out; the successful retry uses a
fresh hash-verified 299-file runtime context. Neither deployment receives the
private inventory manifest, source media or rollback snapshot.

Manifest SHA256:
`5c0f86c6369c6e71250651dbf5268a4b100edddef1ac9c6c13acf198fdff260a`.
Controlled apply archived eight historical lots, inserted 1,015 active lots and
eleven Duravit products, and staged 271 immutable stock photos. Receipt replay
returned already-applied without changing inventory. A private 22 MiB rollback
snapshot was written before the transaction.

Independent persisted reconciliation verifies every lot's identity, quantity,
price and source provenance against the reviewed manifest. All 271 uploaded
photos were downloaded, decoded and SHA256-verified. Five existing business
collections (customers, quotations, purchase orders, payments and customer stock
transfers) retain their baseline fingerprints.

Authorized hosted checks passed through Railway and `buildconhouse.in`: 1,015
lots, 4,393 recorded units, eleven Duravit entries, no archived stock exposure,
floor isolation, saved/restored price and image URL edits, and multipart photo
upload reuse of the original registered bytes. Temporary QA sessions were removed.
The Duravit brand is visible in the live catalog after its existing stale refresh.
Stock reads measured about 2.4 seconds directly and 1.8–2.1 seconds through
Vercel from this Mac; these are samples, not universal latency guarantees.

Final local acceptance: 2,497 hermetic backend tests, 24 responsive editor/upload
journeys, 24 surrounding stock-transfer browser checks, TypeScript, zero-warning
lint and 52 performance browser checks. Public production verification passed
19 route/asset, health, cache and security-header checks. The hosted build checks
159 pages with largest initial JavaScript 453 KiB gzip.

Remaining source gaps are explicitly visible: 353 unrecorded prices (including
the intentionally blank Duravit prices), 119 missing images and 360 unrecorded
quantities. These are not fabricated zero prices, replacement photos or units.
Private workbooks, manifests, source media and backups remain outside Git and
provider source contexts.
