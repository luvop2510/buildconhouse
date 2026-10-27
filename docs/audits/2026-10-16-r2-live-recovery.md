# R2 photo recovery — 16 October 2026

The existing dashboard at https://buildconhouse.in and MongoDB Atlas business
records remain in service. Railway now uses Cloudflare R2 for object storage.
The public read-only Worker is https://forge-media.yashvardhansinh2510.workers.dev,
with only `PUBLIC_MEDIA -> forge-products`; `forge-private` has no public binding.
The user explicitly approved credentials, activation and publication.

## Deployment provenance

The runtime was assembled from tracked backend source at
`501b5622b0fefba3076eb9eb511868c7ac1f83f1`, overlaying only the R2 storage changes.
Unrelated concurrent editor changes were excluded. The 302-file runtime manifest
SHA-256 is `7371235a50e0f9d070d5f2a5df00608e9c8850afd4defa4fe6203d6a56cca198`.
The deployment directory contained no environment secrets, media archives,
backups, test fixtures or symlinks.

Railway deployment `ccdfbc58-865c-4712-91df-487488692349` succeeded. Same-image
redeployment `ae279dfa-0123-48b3-a8ef-fb853eaa39a5` activated the PDF image-host
allowlist for the public Worker. Same-image redeployment
`2fb95f10-7419-459c-b997-003a64c9fdff` succeeded and refreshed the in-memory catalog.
Final same-image catalog refresh deployment:
`eabd1e95-97c1-4a68-9f75-f669124f04ff` succeeded.
The provider remains one Singapore replica with sleep disabled. No frontend
release or business database migration was required. Canonical and direct
Railway readiness returned HTTP 200; system health identifies R2 as connected
and the catalog remains in memory below its 32 MiB budget.

## Recovery safeguards and scope

Supabase still rejects authenticated storage access with HTTP 402. Recovery
uses the existing local media archive, independently checked against current
record checksums. The completed copy contains 11,048 public object keys / 847,998,156 bytes,
including historical references. These are object keys, not unique photographs.
The copy preserves object keys and MIME types and uses conditional creates.
Local bytes must match the planned SHA-256. Earlier receipts include complete
R2 download/SHA-256 comparison. Later uploads use Content-MD5 and verify the
single-PUT ETag; pre-existing destination objects must match MD5, length and MIME.
A deliberately incorrect upload checksum was rejected with HTTP 400. Public
sample delivery is checked separately. This does not claim download/readback of
every later upload.

Only verified recovered keys can receive new app links. Conditional MongoDB
updates retain before/after journals privately in
`output/r2-migration/live/partial-links-*.private.json`. A changed field is
never blindly overwritten. Do not publish those journals: they contain business
records. No source objects or business records were deleted. The final link application
completed after five partial batches. Link changes are limited to application
collections (products/media, stock/media, quotations/shares, settings/brands,
furniture quotations and purchase orders); audit event history is preserved.
Every planned key has a verified receipt. Final MongoDB coverage is 8,484/8,497
catalog media URLs, 7/271 warehouse media URLs and 632 warehouse lot image
fields pointing to R2. Lot images and warehouse media are different references;
do not add those counts as unique recovered photographs.

All six before/after reference journals were additionally compressed into
`forge-private/recovery/r2-live-links-20261016.json.gz` (1,991,910 bytes) and
verified by authenticated full readback.

The fresh logical export covers 46 collections / 36,622 records, excludes
sessions and is not a point-in-time snapshot during concurrent writes. Every
backup chunk and completion manifest was uploaded to the private R2 bucket and
verified by downloading it. Railway source variables were independently
compared with local configuration before cutover; MongoDB URL/database,
Supabase URL and JWT root matched. Existing authentication/MFA roots were kept.

The local archive covers 8,484/8,497 current catalog media records and 7/271
warehouse media records by exact content matches. The private missing list has
277 record rows; these are neither 277 unique files nor a confirmation of the
user's estimate of 40 outstanding photos. Missing files require the user's
later originals or restored Supabase export access. Private historical files
have not been fully migrated from the inaccessible source. Never describe this
as a complete Supabase export.

## Verification

- Focused storage/configuration/readiness/backup checks: 83 passes.
- Isolated deployed-runtime backend tests: 2,893 passed; three Donato tests
  initially lacked their fixture, then all three passed with the fixture supplied.
- The separate working-tree suite had two failures in another editor's new
  password tests. They were not included in the deployed runtime.
- Public Worker contract passes GET/HEAD, ETag/304, traversal/listing refusal
  and write refusal.
- A run-owned temporary storage probe passed public upload/download/delivery,
  private upload/download, signed private delivery and unsigned access denial.
  Its scratch objects were removed. A recovered image also passed the real PDF
  image loader and rendered into a PDF locally, without triggering quotation
  generation events against live business records. Public domains remain disabled on the
  private bucket, verified using the approved read-only management token.
- Production frontend contract: 19 routes/assets/security/cache checks passed.
- Required full performance audit: 159 exported pages meet budgets; 52 browser
  performance/stability cases pass across four device profiles, without retries,
  skips or flakes. Largest JS output is 450 KiB gzip against the 576 KiB cap.
- Live read-only API probes passed identity, brands, catalog hierarchy/search,
  warehouse and quotations. Storage health is connected and memory catalog
  reports 6,597 products and 8,497 media records.
- With bulk upload paused, live catalog search measured 423 ms; four recovered
  photo GETs returned 200 in 790/141/144/152 ms. These are bounded samples from
  this network, not universal latency guarantees. Health's external storage
  checks are slower (roughly 1.8 s).
- Two extended authenticated live browser runs hit existing hosted-navigation
  timeouts after successful quotation list/editor checks. Failures were retained
  and deadlines were not relaxed. The later quiet run completed desktop acceptance and most iPhone checks,
  then found a harness focus issue: phone navigation is hidden while the stock
  search remains focused. The verifier now blurs the search before navigating.
  The floor/mobile verifier also needed its Payments heading assertion to accept
  the existing workspace/details pair. Both failures remain in the evidence.
  Subsequent runs encountered live navigation/product-fetch timeouts during
  bulk upload. After the copy stopped, floor/mobile acceptance passed all 32
  read-only checks across desktop/iPhone and four floors. A subsequent iPhone run exposed a harness race: it checked link visibility
  before the focus-hidden phone bar returned, then opened a More sheet that
  intentionally excludes primary links. The verifier now waits for the primary
  navigation before choosing that sheet. Final authenticated acceptance is
  recorded separately when complete.

## Operations and rollback

R2 credentials are backend-only, stored privately and omitted from reports.
Production provider variables and reference journals are backed up privately.
Restoring old Supabase references or driver does not restore availability while
Supabase returns 402. Prefer correcting R2 configuration. Any rollback of links
must condition on the journal's after value and respect later human edits;
reverse completed journals in reverse order. Never reset the whole database.

Workers stays on its existing free plan and no paid image feature was enabled.
R2 activation includes usage-based overages; it is not a hard zero-spend cap.
Do not accumulate unbounded backups or claim that billing can never occur.
The independent GitHub operations workflow still names Supabase and needs a
separate R2 secret/configuration update before it can serve as the R2 recovery
job; no Cloudflare secrets were copied into GitHub. The application storage
factory and the private logical backup are already on R2. Source changes are
retained locally for review and have not been merged into a protected branch.

## Final live observations

After the complete reference update, the real catalog browser displayed 24/24
product images from Cloudflare, all decoded successfully and no Supabase image
sources in that visible sample. Screenshot:
`output/r2-migration/live/live-catalog-restored.jpg`.

A post-copy API sample returned readiness/system/search 200, R2 connected,
catalog memory mode and 14 recovered URLs in the sampled search. Search took
387 ms; six image GETs returned 200 in 429/128/406/253/485/144 ms. A later API
probe hit a 30-second read timeout, and extended browser verification remains
intermittent even after uploads stop. Do not describe the app as universally
fast or the entire hosted release suite as green. Floor/mobile acceptance is
32 passed; desktop and most iPhone quotation/editor/stock checks passed in
individual runs, but a complete uninterrupted extended run did not pass.

The verifier corrections retain original timeouts and runtime-error guards.
Local backend `.env` now also selects R2 and permits the public image hostname
for PDF loading. No credentials or business data were committed or published
in this report. The user-provided missing originals remain future recovery work.

Final deployment readiness and authenticated storage/system/search checks return
200, with R2 connected and memory catalog source 19,490,501 bytes. Final search
measured 437 ms and six recovered photo GETs returned 200 in
465/163/170/200/325/157 ms. These successful samples do not erase the retained
intermittent timeout failures. The run-owned QA session was revoked and its
local token removed; other sessions were preserved. No copy or reference-update
process remains running. Missing-source recovery and the legacy GitHub
operations workflow are explicitly incomplete as described above.
