# Custom products, uploads and quotation ordering — 14 October 2026

Custom quotation products previously failed server saves because one-off items
used browser-only synthetic product identifiers. The form also had no photo
picker. Custom creation now persists a real product for both modes; quotation-only
products remain inactive and outside catalog lists. Missing catalog references
are allowed for one-off products, while supplied references are validated on the
selected floor. Quotation-create grants authorize only the exact custom creation
endpoints and do not grant ordinary product/media editing.

The new multipart creation path validates the image, binds retries to the member,
floor and complete payload, then uploads through the shared media service.
Deterministic Mongo identities prevent duplicate product/media records on concurrent
retries. Failed uploads retain inactive records for safe retry and cannot appear in
the catalog. Photos live in Supabase object storage; MongoDB `product_media` stores
ownership, URL, size, hash and primary metadata. Quotations persist that image URL.
Exact product/media reads reflect saved and removed photos before catalog refresh.
The exact product editor also falls back to persisted inactive custom records when
saving, so one-off item edits do not depend on active catalog membership.

Shared native/web API transports now retain floor, authentication, CSRF, timeout,
cancellation and cache invalidation for multipart writes. Web photos above 3 MiB
are prepared at a maximum 2,400-pixel dimension below the hosted envelope limit;
small originals retain their bytes and transparent images prefer WebP. Native
uploads stream the picker URI. The proxy admits bounded 4 MiB envelopes only on
photo upload routes and preserves the 1 MiB bound for ordinary requests.

Web dragging now moves products with included parts and rooms as whole sections.
Quick release computes the final position, idle pointers cannot walk the product
through shifted rows, and scrolling uses elapsed time. Keyboard Up/Down shares the
ordering actions. Collapsed room products and totals remain intact. The responsive
admin shell keeps its route mounted across phone/tablet breakpoints, preserving
open custom forms and selected photos through rotation.

## Verification

The full hermetic backend suite plus disposable Mongo integration passes 2,385
checks. The integration exercises actual multipart parsing, concurrent retries,
disk byte/hash readback, real quotation create/PATCH/GET and reordered item/image
persistence. It never connects to production. Native/web client, image preparation,
actual React media-editor lifecycle, existing frontend contracts, TypeScript,
zero-warning lint and Expo Doctor (20/20) pass. Unsigned iOS/Android exports pass.

The final responsive matrix passes 162 cases across seven widths (320, 360, 390,
768, 1024, 1280 and 1440); 13 phone-only cases skip on wider layouts. All 35 media
and 49 drag scenarios pass across every width. The fresh performance audit passes
48 cases with zero failures, retries, skips or flakes; all 159 exported routes are
within the unchanged 576 KiB initial JavaScript budget (largest 452 KiB). Custom
form opening takes 55–90 ms with the 200 ms API fixture across the four devices.
The read-only configured Mongo catalog probe remains in memory mode (19,688,845
source bytes); warmed service samples stay below 37.76 ms. Its 22,965 ms source
load is recorded separately and is not a network-response or browser timing.

The final Chromium seven-width run has 162 passes / 13 intentional width skips.
An initial four-engine run has 87 passes / 12 intentional skips / one Firefox
cross-room test failure. Its fixture sampled a transient FLIP rectangle during a
captured scroll; stable layout coordinates and an asserted intermediate insertion
repair that test. The unchanged wait-free quick-drop case remains separate. The
corrected cross-room case passes on all four engines. Diagnostic reports remain
preserved; final release reruns and publication results are recorded below. Browser engines and device emulation do not certify physical
devices or signed native builds. The independent npm security audit still reports
22 high and five moderate findings; the audit and protected-main gates are preserved.

## Final local release acceptance

The final release export passes 162 responsive cases across seven widths with
13 intentional phone-only skips, then 88 device/engine cases with 12 explicit
skips (six phone-only and six Chromium-CDP-only touch harness cases). Both runs
have zero failures, flakes or retries. Every custom/media and gallery scenario
runs on every project; product/section pointer and keyboard ordering run on all
engines. Real touch commit/cancel journeys run in Chromium. The repaired downward
room gesture uses stable layout bounds and a visible intermediate insertion; the
separate immediate-release regression retains its wait-free drop.

The final source additionally closes stale image deletion prompts on product
changes, covered by the actual React-hook lifecycle harness. The fresh full
backend suite including real inactive-custom editor save, multipart/retry and
quotation persistence integration passes 2,385 checks. TypeScript, zero-warning
lint and all required frontend contracts pass; exact-source unsigned iOS/Android
exports pass. The standalone fresh performance audit passes 48/48 with unchanged
budgets. The mandatory push hook remains enabled and rebuilds before each push.

Production publication and controlled live upload results are recorded below
after provider rollout.

## Production security-policy regression

The first production photo journey on frontend revision `643ed12c` caught an
additional defect: previewing the picker blob URL worked, but fetching that URL
to create the multipart Blob was blocked by the site's `connect-src`. Custom
creation without a photo succeeded. The photo request never reached the backend.
The web helper now uses Expo's original `File` directly, and gallery preview state
retains that file. The production security policy remains unchanged. The audit
server now emits the actual Vercel security headers, covering the previously
missing environment constraint in every browser journey. The File regression
contract also asserts that uploading performs no URI fetch.

## Published runtime and live acceptance

The backend runtime is `643ed12c3113469c48efb5a1d491d53554e95e63` on Railway
deployment `32189ae0-76fb-4247-b2fe-1e3d080c7b10` (SUCCESS), retaining one
always-running Singapore replica and `/api/health/ready`. A first large source
upload failed to create a provider snapshot; a hash-verified 396-file backend
context was accepted. No database migrations or environment changes were needed.

The additional browser File fix is frontend revision
`72cd20952eb0a16311bc71998270bdda22c5fa72`, published by Vercel deployment
`dpl_Cgcj5jrDbVeGhR8NS6VSY9BVhDxT` (READY) at `buildconhouse.in` and
`www.buildconhouse.in`, with API functions in `bom1`. Cloud builds pass the same
159-page budget (largest 453 KiB versus 576 KiB). The observed cloud chunk names
match the first fresh CSP audit's build log; SHA-256 identities of the three
served chunks are retained separately. A later local rebuild changed chunk
identities, so the initial local identity manifest is not evidence of final
cloud byte parity. Source revision, provider metadata and live behavior establish
the deployed feature identity.

The final security-policy reruns pass 93 responsive cases / five intentional
phone-only skips and 48 device cases / eight explicit phone/CDP harness skips,
with zero failures, flakes or retries. Every photo/gallery case runs on all
projects. TypeScript, zero-warning lint, the File regression and existing API/hook
contracts pass; exact-source unsigned iOS/Android exports pass. A fresh CSP
performance audit passes 48/48 with unchanged limits.

An owner session on the public site created two run-owned, inactive one-off
products without selecting a customer. The photo upload saved one Mongo media
record and one Supabase object. Downloading that object matched its metadata hash
and all 4,845 original PNG bytes exactly. The uploaded product was moved above the
other product; restoring the local draft after a page reload retained that order
and its photo. Disposable media/object/products and the local draft were then
removed. No business quotation was created or modified. Screenshot and readback
evidence are retained in `output/custom-product-release/`.

Final public acceptance passes all 19 route/asset/security/cache/health/auth
checks. Five-sample health medians were 236 ms through Vercel and 172 ms directly
through Railway; readiness medians were 836 ms and 579 ms. These include customer
network/TLS/body transfer; they are not database-only or 2 ms response claims.

Diagnostic reports are preserved for an interrupted device run: the local push
hook rebuilt mutable `dist` while that server was reading it, producing eight
startup failures. The full device rerun used an immutable export and passed.
One push was blocked by two iPad performance timing breaches while other browser
suites ran; no budgets or retry settings were changed. Final publication requires
the complete pre-push audit with other builds and browser suites closed. The
independent dependency-security gate remains blocked by the existing 22 high and
five moderate findings; protected main is not bypassed or merged.
