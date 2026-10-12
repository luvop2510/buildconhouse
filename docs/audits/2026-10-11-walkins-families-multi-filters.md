# Walk-ins, family variants, quotation ordering and filters

The local release preview is available at http://127.0.0.1:8090, with FastAPI
at http://127.0.0.1:8010. It uses the configured Atlas database and Supabase
storage. Sign in with an existing staff account. The preview preserves the
hosted app's cookie, CSRF and API-proxy behavior.

## Result

- Walk-ins can combine departments, statuses and lead sources. Their record
  actions send the source record's floor, including when viewing multiple units.
- Migration `0031` renamed the `second-floor` display name to `Kitchen Floor`
  and removed exactly `TEST Source 1785460004` and `TEST_SRC_1785460004` from
  selectable lead sources. Stable floor IDs and historical sources are preserved.
- Customers lists require actual confirmed quotations/orders. Walk-in prospect
  identities remain available to the existing quotation and contact workflows.
- Visit Showroom creates an immediate, persistent follow-up with a stable
  identity. Retries do not duplicate or reopen completed follow-ups. The new
  Visit Showroom tab filters by stored origin; callback reminders inherit it.
- Catalog and builder browse/search, Recent and Frequent shelves return one card per family in its
  floor/brand/category namespace. Exact variant SKUs, prices and source
  placements remain available inside the card. Staff with catalog edit access
  can rename the selected color variant without changing its SKU or siblings.
- Quotation products can be dragged with mouse, pen or touch. Neighbors animate
  into place, edge scrolling works on narrow canvases, and Escape cancels.
  Save/reload preserves order, included parts and products in collapsed rooms.
  Existing native dragging and accessible move actions use the same order rules.
- Categorical filters support multiple selections in catalog, quotations,
  walk-ins, follow-ups, notebooks, customers/purchase workspaces, stock,
  payments, tile operations and sales floor scopes. Choices within a filter
  match with OR; separate filters intersect. Dates and sorting retain their
  single range/order semantics. Explicit floors are checked against access.

## Verification

- 2,102 hermetic backend unit tests passed. Unit runs override live connection
  configuration with the CI Mongo URL, database name and placeholder secrets.
- Four catalog scale integration tests passed using disposable local MongoDB.
- Final feature browser run: 86 passed and two intentional touch-harness skips,
  covering Chromium at 320, 390, 768, 834, 1024 and 1440 pixels, desktop Firefox
  and phone WebKit. Firefox/WebKit cover mouse/order persistence; real CDP
  touch movement and cancellation run on every Chromium viewport.
- Surrounding purchase/payment/follow-up/PDF/PPTX regression run: 55 passed,
  two tablet-only test skips across desktop, tablet and phone.
- TypeScript and zero-warning lint passed; web build and iOS/Android exports passed.
  Existing frontend contracts plus filter, quotation order and Excel export
  contracts passed. The new contracts are included in CI. All 11 web route
  budgets passed below 576 KiB gzip.
- Controlled live route acceptance passed six checks: prospective customer
  exclusion, immediate/idempotent showroom transfer, family grouping, exact
  variant-label persistence, quotation item-order persistence and inclusion
  after confirmation. All uniquely tagged temporary records were removed.
- Read-only infrastructure preflight passed Mongo ping, required indexes and
  Supabase bucket access. Migration dry-run reports no pending migrations.
  Both direct and proxied `/api/health/ready` return 200 after the final restart;
  the local sign-in page returns 200.

The first feature run identified missing checkbox ARIA state and a touch-test
start point outside the visible handle at 320 pixels. Explicit ARIA state and
visible touch geometry fixed these; the final run retains the original checks
and deadlines. New payment/purchase test fixtures were corrected to provide the
actual floor-settings route and complete stage DTOs before the final run.
An additional variant-cache regression fixture was corrected to use a valid
email address and the actual composed floor-scope query.

Evidence: `output/playwright/walkin-feature-release.log`,
`walkin-surrounding-regressions.log`, `walkin-final-build.log`,
`walkin-final-lint.log`, `walkin-backend-unit-final.log`,
`walkin-catalog-scale-final.log`, `walkin-live-acceptance-final.log`,
`walkin-ios-export.log`, `walkin-android-export.log`
and their browser artifacts.
Output artifacts are local and ignored by Git.

Physical devices/simulators were not exercised. Optional route drift checking
still has no configured baseline. No production deployment or push is claimed.

## Local startup

From `backend/`, start `.venv/bin/python -m uvicorn server:app --host 127.0.0.1 --port 8010`.
From the repository root, run `npm run build` with the project's required build
backend configuration, then `npm run preview:local`. The local preview defaults
to port 8090 and proxies to 8010; `LOCAL_PORT` and `BACKEND_URL` can override it.

Live acceptance is opt-in: `backend/scripts/verify_walkin_product_changes.py --live`.
It changes only tagged temporary records and removes them in `finally`. Normal
unit and integration testing must continue to use isolated database settings.
