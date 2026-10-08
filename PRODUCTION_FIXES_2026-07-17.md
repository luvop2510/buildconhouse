# Production hardening — session log, 17 Jul 2026

Full pass across `BACKEND_AUDIT_2026-07-17.md`, `PRODUCTION_READINESS_AUDIT.md`,
`APP_STORE_PLAY_STORE_AUDIT.md`, and `MOBILE_UX_AUDIT.md`, worked Critical → High → Medium.
This session ran concurrently with another session working the same backlog against the
same repo/database — the two converged cleanly; this log covers both, noting who verified what.

Verified against the live stack throughout: MongoDB Atlas (`buildcon_house`, 2,601 products),
Supabase storage, real HTTP requests against a booted backend — not mocks, not a stale preview.

## Critical (5/5 fixed)

1. **Live demo credentials rotated.** `owner@forge.app`/`[legacy password removed; use injected test credentials]` and 7 sibling accounts were
   live in production with a password printed throughout the repo's test files. Ran
   `scripts/rotate_demo_credentials.py --apply` — found and fixed a real bug in it first (temp
   password expiry was set to *now*, not now+72h, so the new password would have been rejected as
   already-expired on first login attempt). Verified: old password now 401s, new password logs in
   and correctly returns `must_change_password: true`. New passwords delivered to the user in chat
   only, never committed (`backend/backups/credential_rotation_*.json` is gitignored).
2. **SSRF DNS-rebinding gap in catalog import.** `/catalog/imports/from-url` validated the initial
   hostname but fetched with `httpx.AsyncClient(follow_redirects=True)`, which never re-validates
   redirect targets — a URL could pass the public-hostname check and then 302 to a private/metadata
   address. Fixed: manual redirect loop (`_fetch_public_url`) that re-validates every hop before
   following it. Verified live: a direct request to `169.254.169.254` (cloud metadata IP) is
   rejected with 400.
3. **Catalog import: one bad row aborted the whole batch; rollback did nothing.** A single
   malformed row (bad price, e.g.) threw uncaught and killed the rest of a multi-hundred-row
   import; `rollback_job` only flipped the job status, never touched the products it had written.
   Fixed: per-row `try/except` in `catalog_pipeline/orchestrator.py` (failures collected, batch
   continues), plus a real snapshot-based rollback — each row's pre-write state is recorded to a
   new `catalog_import_snapshots` collection before mutation, and `rollback_job` now actually
   restores updated products and deletes newly-created ones. Also fixed a raw-dict crash vector in
   the row-edit endpoint (`PATCH .../rows/{id}` now validates `mrp`/`dealer_price` as numbers
   instead of accepting anything). Covered by `tests/unit/test_catalog_import_resilience.py`.
4. **Concurrent partial stock-moves could corrupt inventory quantities.** `purchases_tracker.py`'s
   partial-move path read a quantity, computed a split, then wrote it back unconditionally — two
   concurrent partial moves on the same item would silently clobber each other. Fixed with
   optimistic concurrency (the write's filter requires the item's qty to still match what was just
   read; a lost race returns a conflict instead of corrupting data) — later upgraded (by the
   parallel session, on top of this fix) into a retry-wrapped version covering the full-move path
   too, with a structured 409 after real exhaustion. Covered by
   `tests/unit/test_purchases_tracker_concurrency.py` (3 tests, all passing).
5. **CI never ran the test suite.** Backend tests existed but nothing executed them on push/PR.
   Split into `tests/unit/` (fast, no live dependencies — now gates every CI run) and
   `tests/integration/` (need a real deployed backend + credentials; previously hardcoded a stale
   preview URL and the since-rotated demo password, now read from `TEST_BACKEND_URL`/
   `TEST_OWNER_EMAIL`/`TEST_OWNER_PASSWORD` env vars and skip cleanly when unset, documented in
   `tests/INTEGRATION_TESTING_STRATEGY.md`). `.github/workflows/ci.yml` now runs pyflakes,
   compile-all, `pytest tests/unit`, and a Docker build on every push.

## High priority (13/13 addressed)

- **Token-in-URL fully closed.** `?_t=<raw JWT>` (weeks-long validity, leaked into browser
  history/proxy logs) replaced everywhere with `services/download_tokens.py` — a 60-second,
  single-use, atomically-consumed token minted via `POST /downloads/token`. Found and fixed one
  straggler this session: `quotations/[id]/index.tsx`'s PDF-open fallback path was still building
  a raw-JWT URL (and would have 401'd outright, since the backend no longer accepts `_t` at all).
- **Hardcoded demo OAuth domain** (`demobackend.emergentagent.com`) moved to `GOOGLE_SESSION_URL`
  setting, defaulting to the same value but overridable per deployment.
- **Legacy tokens without `session_id` were unrevocable** — skipped the session-validity check
  entirely, so logout/"sign out everywhere"/credential rotation couldn't touch them until raw JWT
  expiry (up to 30 days). Every login path has embedded `session_id` since sessions were
  introduced, so the compatibility branch was removed outright; a token without one is now simply
  invalid.
- **Password change didn't revoke other sessions.** A compromised password, once changed, left
  every other already-issued session/token valid for its full lifetime. Fixed: change-password now
  revokes every *other* session for that user (keeps the current device signed in, matching
  Google/GitHub UX).
- **Maker-checker not enforced on catalog import approval** — `approve_and_import` required only
  "purchase" (same role that uploads/edits the pricelist); raised to "manager". Also tightened
  `GET`/`list` on unapproved import jobs (unverified MRP/dealer pricing) from any authenticated
  user to "purchase"+.
- **Suppliers had zero floor isolation** despite already having a `floor_id` field — routes never
  called `floor_query`/`floor_for_write`. Fixed to match the pattern used everywhere else
  (Customers/Quotations/POs/Payments/Followups).
- **Racy document numbering** — `transfer_workflow.py` and `purchases_tracker.py` each had their
  own `count_documents`-then-format numbering, independent of the atomic counter
  (`services/sequence.py`) the primary create paths use. Fixed both to delegate to the same atomic
  counter — critically, using the *same* counter key as the primary path (a subtle bug caught
  during my own review: an earlier draft of this fix gave transfers their own independent counter,
  which would have reintroduced duplicate numbers between transfer-created and normally-created
  documents sharing the same number space).
- **Missing indexes** (`customers.email` unique, `user_sessions.id`/`(user_type,user_id)`,
  `payments.quotation_id`, `activity_events` timeline lookups, `suppliers`) added to
  `scripts/ensure_indexes.py` and `bootstrap.py`'s `REQUIRED_INDEXES` startup gate. Verified
  duplicate-free against live data before adding any unique constraint.
- **PO attachments stored as base64 directly on the document** — no cap on count/aggregate size,
  trending toward MongoDB's 16MB document limit. Moved to the private Supabase bucket via the
  existing `media_storage` abstraction; only `storage_key` + metadata persist on the PO now. Added
  `GET /purchase-orders/{id}/attachments/{id}/url` (short-lived signed URL) and wired a tap-to-open
  handler in the PO detail screen (previously attachments were listed but never actually openable
  from the UI at all).
- **Multi-worker cache/rate-limit incoherence** — addressed by the parallel session: Redis-backed
  login rate limiting (INCR+EXPIRE) when `REDIS_URL` is set, falling back to the original
  single-process behavior otherwise, documented in `DEPLOYMENT.md`.

## Medium priority (targeted fixes, not exhaustive)

- **Delete-quotation had no guard** for linked purchase orders/payments — deleting silently
  orphaned them. Now blocks with a 409 listing exact counts. Verified live against a real
  quotation with 1 linked PO and 1 linked payment.
- **Money-field validation** — `Product.mrp/price`, `QuotationLineItem.unit_price/discount_pct`,
  `Quotation.project_discount_pct`, `Payment.amount` had no bounds; a negative `discount_pct` acts
  as an undetected markup, anything over 100% makes net revenue negative. Added `Field(ge=/gt=/le=)`
  constraints — verified zero live records would be rejected before adding any of them.
- **Media MIME trusted only the client-supplied header** (trivially spoofable). Added magic-byte
  signature verification (PNG/JPEG/GIF/WEBP/PDF) — upload now rejects a body whose actual bytes
  don't match its declared type.
- **Floor-isolation gaps in activity timelines** — the global activity feed had no floor filtering
  at all (documented as a containment measure pending real per-event `floor_id`, which would need
  a large sweep across every `log_event` call site — deferred, not silently "fixed"); the
  per-quotation/per-purchase/per-customer timeline endpoints didn't verify the caller's floor
  access to the referenced entity before returning it (closed — same `floor_query` pattern used
  everywhere else).
- **Outbox worker "no atomic claim"** — assessed, not changed: `dispatch_event` already runs
  inside a Mongo transaction touching the event document, so MongoDB's document-level transaction
  locking already prevents two workers from both completing the same event (one gets a write
  conflict and aborts). The audit's concern is real for wasted computation on a rare collision, not
  data corruption.
- **Duplicate SKU found** (see Product decisions below) — the unique index that would prevent this
  class of bug going forward (`products_sku_brand_unique`) is created defensively and will apply
  automatically once the existing duplicate is resolved.

## App Store / Play Store readiness

- **Icon regenerated** to 1024×1024 with alpha flattened (Apple rejects transparent App Store
  icons) — upscaled from the 512×512 source onto a black background matching the existing Android
  adaptive-icon config. Adaptive-icon foreground also upscaled to 1024×1024. Favicon fixed from
  512×513 (1px off-square) to a clean 512×512. **Caveat:** upscaled from a 512² source, so it will
  look soft next to a true vector-sourced 1024² icon — usable for submission, worth a designer pass
  later.
- **ATS/cleartext blocker made loud instead of silent.** A release build with a non-`https://`
  `EXPO_PUBLIC_BACKEND_URL` used to boot to a fully network-dead app with no clear signal why.
  Added a startup check in `client.ts` that throws with a clear message in any non-dev build if the
  backend URL isn't `https://` (same-origin/empty string, a legitimate ingress setup, is exempt). I
  don't know the real production API domain, so I could not set it — this only prevents shipping a
  broken build *silently*.
- **In-app privacy/data screen added** (`Settings → Privacy & data`) with accurate content based on
  what this codebase actually collects/stores (Atlas, Supabase, optional Sentry/PostHog) and a
  deletion-request path via account admin (matches the existing invite-only account model — there's
  no self-registration to build a self-serve delete flow against). **This does not by itself
  satisfy App Store Connect / Play Console**, which both require a separately hosted, stable URL —
  that still needs to be published externally on a domain the user controls.

## Bugs found *by verifying the change set*, not by reading

Booting the backend fresh after all changes (not just compiling it) surfaced two real,
previously-undetected crashes in the parallel session's new migration framework:

- **Migration `0002_add_catalog_import_snapshots_index`** and **`ensure_indexes.py`** both created
  "the same" index under different default names — MongoDB treats that as a hard conflict
  (`OperationFailure` code 85), uncaught, and crashed `uvicorn` startup outright. I'd already run
  `ensure_indexes.py` manually earlier in the session, which is what triggered it. Fixed by making
  the migration the sole owner of that index (removed the redundant creation from
  `ensure_indexes.py`) and dropping the orphaned duplicate from the live database.
- **Migration `0003_add_user_sessions_indexes`** hit the identical class of bug against indexes
  that were already present on this database under MongoDB's auto-generated default names (created
  by hand before either mechanism existed). Fixed by making the migration tolerate that specific
  conflict code instead of crashing.

Re-verified after both fixes: clean boot, migration applies and records itself, `/api/health` →
200, and a full smoke test (login, followups, dashboard, suppliers, catalog imports, activity,
payments, quotations, delete-guard, payment-bound rejection, SSRF rejection) all passed against the
live database.

## Product decisions — flagged, not resolved

1. **Duplicate SKU across two distinct products.** Same brand (`Hansgrohe`), same SKU
   (`26456000`), two different real products (`FixFit S wall outlet DN15` vs.
   `FixFit Porter 300 Schlauchanschl.`) — a supplier catalog data-entry error. Product IDs:
   `639c8d2e-95e6-406b-a117-f18155b9519d` and `811a1b0f-1b20-401b-9f36-e8134b63bbf2`. I did not
   auto-merge or delete either — that's real catalog data that quotations may already reference.
   Needs a human decision on which SKU is correct (or assign a corrected SKU to one). The
   `products_sku_brand_unique` index will apply automatically the moment this is resolved.
2. **Sign in with Apple** (App Store Guideline 4.8) — Apple requires it wherever Google Sign-In is
   offered unless the app is provably employees-only. This app also serves external customers via
   the portal, so that exemption likely doesn't apply cleanly. Two valid paths: add Sign in with
   Apple, or restrict Google Sign-In to a provably staff-only surface. Both are product decisions,
   and implementing either fully requires Apple Developer account access and real-device testing
   this environment doesn't have — not attempted.

## Still deferred (not started this session)

- Real per-event `floor_id` on the global activity feed (needs `log_event` updated at every call
  site — 30+ locations).
- Catalog-adapter classification logic duplicated across 4 brand adapters (lower-value refactor).
- Unbounded embedded arrays (`stage_history`, `revisions`) — no cap/archival strategy yet.
- Splash-screen aspect-ratio mismatch (336×729 poster image used where the plugin expects a small
  logo mark) — genuinely needs a new design asset, not a code fix.
- Customer portal has no equivalent privacy/deletion screen (staff Settings only).
- Push notifications, offline handling, deep-linking beyond OAuth return, `PrivacyInfo.xcprivacy` —
  all previously flagged as "decide and document a v1 stance," none decided this session.

## Verification summary

- `pytest tests/unit` — 45 passed, 0 failed.
- `python -m compileall` — clean across the full backend.
- `npx tsc --noEmit` — clean across the full frontend.
- Live boot test on a throwaway port against the real Atlas DB — clean, then killed after
  verification (see chat for the persistent LAN-bound instance used for mobile testing).
- Manual live-request verification: credential rotation, SSRF block, delete-quotation guard,
  payment amount bound, MIME-mismatch rejection, PO attachment upload+signed-URL retrieval.
