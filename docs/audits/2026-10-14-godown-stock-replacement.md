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

Publication and live reconciliation evidence will be appended after rollout.
Private workbooks, manifests, source media and backups remain outside Git and
provider source contexts.
