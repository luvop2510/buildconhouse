# Product media and backend verification — 5 October 2026

Four missing Hansgrohe Vivenis heroes were recovered from exact-SKU official
manufacturer originals. A subsequent exact supplied-workbook recovery restored
usable photos for 11 more Vitra products. The remaining image coverage gaps are explicit; the
catalog is not yet fully illustrated.

## Live recovery

| SKU | Finish | Stored original dimensions |
| --- | --- | --- |
| `75020140` | Brushed Bronze | 3545 × 4096 |
| `75020340` | Brushed Black Chrome | 3545 × 4096 |
| `75040140` | Brushed Bronze | 2587 × 4096 |
| `75040340` | Brushed Black Chrome | 2587 × 4096 |

The supplied 2027–28 Hansgrohe workbook had no image assigned to these exact
rows. Each official product page was opened in the Codex in-app browser;
the selected SKU, finish and primary product-photo DOM source were checked.
Original CDN bytes were downloaded again and checksum-checked before writing
through `media_service.upload_and_register`. Normalization retained the source
dimensions. Stored bytes, metadata, selected hero and unchanged product data
were verified after every write. Previous media was retained, and activity
events and recovery audit records retain provenance and rollback information.

The [applied manifest](2026-10-05-hansgrohe-media-recovery.json) records URLs,
hashes, product/media IDs and browser review evidence. Before-images are in
the local ignored `backend/backups/vivenis_media_recovery_20261005/` directory.
Backend catalog snapshots refresh offline writes through their existing
five-minute stale-while-revalidate policy; a new backend instance loads the
current catalog directly.

## Supplied Vitra originals recovered

The supplied `VITRA NEW MRP 2026-27.xlsx` was re-extracted with the deterministic
Vitra adapter. Its SHA-256 and each original ZIP image path are recorded in
the [applied manifest](2026-10-05-vitra-supplied-media-recovery.json).

- Six existing references for `5885B401H0101`, `5885B401H0559`,
  `7082B401H0075`, `7082B401H0090`, `7041B401H0075` and `7041B401H0090`
  matched the original normalized SHA-1 exactly. `upload_and_register` restored
  three missing shared storage objects in place, preserving all media IDs.
- Five exact provided WC photographs were assigned to `7082B076H0075`,
  `7082B076H0090`, `7906B476H0075`, `7906B476H0090` and `7508B003H0850`.
  The workbook exact SKU, finish column, source photo and separate product
  descriptions were reviewed. New media is product-owned; old media remains.
- All 11 stored downloads matched their normalized hashes and became the
  displayed hero for the unchanged product document. Each repair has an
  activity event and a `media_repair_audits` provenance record. Source bytes
  and before-images are retained under ignored `backend/backups/`.
- These provided originals range from 136 × 120 to 334 × 282 pixels. Their
  actual `poor`/`acceptable` labels are retained; this is restoration of
  supplied originals, not a 4K quality upgrade.
- Sixteen apparent seat-cover candidates actually show complete WC assemblies.
  They were rejected. Two `5885B420H0101`/`5885B420H0559` Memoria candidates
  show taupe in the WC worksheet while the exact SKU descriptions in `Sheet1`
  say Matt Black. That contradiction remains explicitly `ambiguous`.

## Current coverage

The read-only [coverage manifest](2026-10-05-product-media-coverage.json)
scans every active product after the supplied Vitra recovery and records the
scan timestamp. Its `unresolved_requirements` gives every remaining exact SKU
and required source evidence.

- 6,565 active products and 8,484 media metadata rows; no metadata identity
  issues.
- 122 products have no displayable product-owned photo: 81 in Sanitary
  Bathroom and 41 in Ground Floor.
- By brand: Vitra 71, Nexion 40, Hansgrohe 4, Oyster 4, Geberit 2, Renite 1.
- The 11 previously unresolved Vitra storage references were retried after
  recovery: six are now present and five remain missing. These are additional
  to the 122 products without heroes, so 127 products remain without a usable displayed
  photograph in the inspected coverage.
- The final full referenced-object scan and scoped post-recovery byte recheck
  are complete. Their actual timestamps and current findings are recorded
  in the final verification below.

The queue formerly counted primary dimension diagrams as product photos.
That understated Sanitary Bathroom's absent heroes by 14. The queue now
matches the runtime's photo, legacy URL and exact seat-cover fallback policy.

## Original-source review

Historical product snapshots, archived import rows and bundled media manifests
were checked before manufacturer discovery. Ten archived import rows initially
appeared to provide candidates. Decoding and visual inspection exposed
assembly/part and finish mismatches: three MyEdition plate rows contained
whole basin mixers; the gold shower-arm row contained a chrome ceiling
connector; stone-grey/black Vitra rows reused white/beige photographs; black
Geberit glass rows contained a different finish in a scene. The apparent
taupe Vitra candidate also lacks enough original mapping evidence to establish
exact variant identity. These images were not reassigned.

The latest checked-in Hansgrohe workbook manifest explicitly maps overlapping
MyEdition assembly photos to the mixer SKUs and leaves the plate SKUs empty.
The four remaining Hansgrohe gaps are `27412990`, `47904140`, `47904300` and
`47904340`. The exact official `47904140` plate master was found at
1695 × 4096, below the recovery skill's 2160-pixel short-edge requirement;
it was not represented as a 4K recovery.

Re-extracting the supplied `NEXION 2026.xlsx` produced 761 product rows and
confirmed 40 exact rows have no embedded images, covering the LEPTIS AMANI
BRONZE and ONICE PERSIANO size/finish variants. Fourteen Vitra rows in the
bundled dimension workbook have drawings but no product/seat-cover photo.
Exact SKU-level source requirements for every remaining gap are retained in
the coverage manifest. No generic sibling images were substituted.

## Code fixes and validation

The cached catalog and database-backed media hydrators now share the same
selection logic. Exact seat-cover-only products receive the same preview in
both paths, and selected-hero quality replaces stale import metadata.
Variant previews also use the shared policy, including the case where an
internal gallery or dimension drawing precedes an official primary. The legacy
database-backed variant hydrator now excludes collisions from another floor,
brand or category when the requested product supplies that namespace.

Quotation reads now prefer a surviving exact current legacy or seat-cover
photo over an expired snapshot when there is no regular media photo. Floor
and SKU proof still precede that lookup; retired/manual and renamed SKU
snapshots remain historical fallbacks. Purchases already follow current exact
floor/SKU previews. No per-row network probes were added to either path.

Go Down Stock still preserves zero-quantity lots in explicit history views
and excludes them from available-stock queries. Search now escapes user text
before constructing MongoDB regex filters, so punctuation and nested regex
operators cannot change a literal SKU/name search or create expensive regexes.
Floor scoping and quantity restrictions remain in force.

Focused catalog/media parity checks passed, including dimensions, exact
seat-cover photos, legacy URLs and source precedence. Stock/intake/customer
transfer checks passed 31 tests. The final full backend unit suite passed 1,528 tests with six existing
deprecation warnings. The focused catalog/media regression group passed
20 tests. The additional supplied-recovery, legacy-variant and expired-quotation
snapshot regression group passed 24 tests. `git diff --check` passed. A separate
final full-unit-suite run and complete stored-byte scan are recorded with the
release verification artifacts; the earlier 1,528-case result is historical.

## Final verification — 6 October 2026 IST

The credential-redacted [byte integrity evidence](2026-10-06-media-byte-integrity.json)
preserves the complete baseline and the later recovery recheck separately.
The baseline ran from 23:45:03 IST on 5 October to 00:09:58 IST on 6 October
(18:15:03–18:39:58 UTC on 5 October). It attempted every one of the 8,479
referenced media rows, using eight bounded workers and a 0.05-second worker
delay. Eleven known Vitra references were unavailable at their baseline check;
all other downloaded objects decoded and matched stored SHA-1, byte length,
MIME type and dimensions. There were no metadata identity discrepancies.

The scoped recheck finished at 00:10:13 IST on 6 October. It attempted the
16 distinct IDs comprising every baseline issue and every supplied-Vitra
recovery row, and recomputed identity and selected-hero coverage across all
8,484 current media rows and 6,565 active products. All eleven recovery rows
passed; the remaining five unavailable references are the selected heroes
for Vitra `7810B401H0016`, `7812B401H0016`, `5991B401H0016`, `5993B403H0016`
and `5995B403H0016`. None of these failures is an inactive historical or
unselected reference. No additional displayed-image failures appeared.

Together, the baseline and scoped recheck verify bytes for 8,479 of the
8,484 current media rows. The five missing objects plus 122 absent selected
photos leave 127 products without usable displayed photographs. The integrity
gate correctly exits nonzero; this is not complete product-image acceptance.
The audit made no application-data or storage writes and did not delete or
repair historical references. Reads are not one point-in-time snapshot, and
unreferenced storage objects are outside this media-row gate's scope. No
active product relied on a legacy URL outside the byte checks.

After source changes settled, the fresh full backend unit suite passed
**1,539 tests** with six existing deprecation warnings in 20.08 seconds.
The nine focused scanner/byte checks cover bounded downloads, atomic reports,
provider-error redaction and failure closure for inspection, database-read
and storage-close failures. The ordered-quotation edit regression now uses a
real catalog snapshot instead of an incomplete test fixture.

## Nexion official-source follow-up — 6 October 2026 IST

The 40 missing Ground Floor Nexion rows now have current manufacturer research,
recorded in `2026-10-06-nexion-official-image-research.json`. Both official
product pages, matching public original-upload metadata, current 2026 Marble
Gallery and historical official brochures were inspected. The 17 matching
manufacturer originals decoded successfully; none meets the fresh web-source
4K gate. The published face originals are 1400×700, the largest original edge
is 1920, and relevant native catalogue images also fall below the gate. Page
renders were used for visual review only. Retailer candidates inspected also
fell below the gate; their authorization and exact row assignments were not
established.

The current catalogue explicitly maps all five nominal formats to the actual
millimetre dimensions used in the supplied workbook (PDF page 77 / printed
page 153). Six Satinato entries remain in conflict with the current manufacturer
availability: both collections list Satinato only for 120×180 and 120×240 cm,
whereas the supplied source also lists the square, 80×160 and 60×120 formats.
These require supplier confirmation; no catalog row was removed or altered.
Supplier “Soft Natural” versus official “Soft Naturale” still needs exact finish
confirmation. Collection face numbers indicate graphic variation rather than
an exact finish assignment.

Exactly 40 Nexion unresolved entries were refined from the earlier supplied-file
`not_found` result: 34 are `not_4k`, and six are `mismatch` for the finish/format
catalogue conflict with resolution as an additional blocker. No database,
storage or runtime changes were made. The 127 missing/unusable display-photo
count remains unchanged. Exact native originals and supplier confirmation are
still required; the unanswered quality question does not authorize below-gate
web photos or cross-finish/cross-format imagery.

## Oyster supplied-source follow-up — 6 October

Three exact supplied missing originals were restored and two incorrect
rose-gold assignments were corrected to Matt Black/Brushed Gold. OOXML
bounds explain the cause: pictures mostly occupy the next finish row despite
starting at the bottom of the previous row. The scoped adapter fix checks
explicit bounds and row heights, requires at least85% target-row overlap,
and retains ambiguous same-hash ownership without moving it. Three
regressions pass, and the full backend suite passes1,552 cases. All132 rows
in the three available source workbooks retain product identity/pricing;
only five reviewed image assignments change, with basin coverage53→56.

Current read-only coverage and21/21 affected-object byte rechecks find
8,489 media rows,119 absent selected photos and five missing displayed
objects: **124 known usable-photo gaps**. Both Oyster manifests record
exact ownership, native quality and storage/display checks. Existing media
was retained and product documents did not change. The full baseline byte
audit remains dated evidence; no claim is made that every product is fixed.
