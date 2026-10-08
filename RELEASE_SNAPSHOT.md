# BuildCon House — Release Snapshot

**Purpose:** project context document for Emergent. Describes the system as it exists at release freeze. Not a plan, not a proposal — a description of what is on `main` today.

| | |
|---|---|
| **Product** | BuildCon House ERP (internal codename `Forge`) |
| **Repository** | `https://github.com/yashvardhansinh2510-max/forge2.0` |
| **Release commit** | `ca062d7` — *fix: hide Purchases on Ground Floor, rebuild the Sales Data tab row* |
| **Branch** | `main`, identical to `origin/main` (0 ahead, 0 behind) |
| **Working tree** | Clean — no staged, unstaged, untracked or stashed changes |
| **Snapshot date** | 2026-08-02 |
| **Schema version** | `0014` (14 applied migrations) |
| **Verification at freeze** | 832 backend unit tests pass; `tsc --noEmit` clean; live backend health = `degraded` (see §6) |

---

## 1 · Architecture Summary

BuildCon House is a two-business-unit ERP for a building-materials retailer. The two units — **Ground Floor (Tiles)** and **The Sanitary Bathroom (first floor)** — share one codebase, one database and one deployment, and are kept apart at the query layer by a mechanism called *floor isolation*. Almost every architectural decision in this system traces back to that constraint.

```
Expo / React Native (iOS · Android · Web)
            │  Bearer JWT + X-Floor-Id header
            ▼
     FastAPI  (/api, 27 routers, 237 endpoints)
            │
   ┌────────┼─────────────┬──────────────┐
   ▼        ▼             ▼              ▼
 MongoDB  Supabase     Redis         Sentry / PostHog
 (Atlas)  Storage      (optional)    (optional, inert today)
```

### Backend
FastAPI (`backend/server.py`, app title `Forge API`, version `0.1.0`), Python 3.12, served by uvicorn (2 workers in the Docker image). Async throughout — Motor for Mongo, `httpx` for outbound. All routers mount under a single `/api` prefix.

Startup is a gated sequence, and the app does not report ready until it passes: infrastructure preflight → migrations → preflight again (migrations may create the indexes the first pass demanded) → floor bootstrap → seed-if-empty → catalog resync → index ensures → outbox dispatch → background outbox worker → catalog read-model build → automation-rule seed → follow-up reconcile.

Cross-cutting middleware: `SecurityHeadersMiddleware` then CORS. CORS is deliberately `allow_credentials=False` with wildcard origins — the app authenticates by Bearer token only and never uses cookies, so credentialed CORS would be both unnecessary and unsafe.

### Frontend
Expo SDK 54 / React Native 0.81.5 / React 19.1, routed by `expo-router` 6 (file-based, typed routes enabled). One codebase renders web (via `react-native-web` 0.21, Metro bundler, single-page output), iOS and Android. TypeScript 5.9, strict typecheck in CI.

Three route groups: `(auth)` for login and forced password reset, `(admin)` for the staff ERP, `(customer)` for the customer-facing quote portal. The admin shell renders three different navigation chromes (desktop sidebar, tablet rail, phone tab bar) from one shared `useVisibleNav()` composition of role permissions and floor restrictions.

### Mongo
MongoDB Atlas, database `buildcon_house` in production. 36 collections. Documents are addressed by an application-generated string `id` field, not `_id` — every collection that matters carries a unique index on `id`. Schema changes go through a numbered forward-only migration runner (§3).

### Supabase
Used purely as object storage for product media — not as a database and not for auth. Two buckets: `forge-products` (public, catalog imagery) and `forge-private` (signed-URL access). `backend/media_storage/` wraps it behind a driver interface (`MEDIA_STORAGE_DRIVER=supabase` is the only implemented driver). Uploads are SHA-1 deduped and registered in `product_media`; the DB row is the source of truth and the bucket object is cleaned up if registration fails.

### Authentication
Stateless JWT (HS256) issued on login, held client-side, sent as `Authorization: Bearer`. Default expiry 43,200 minutes (30 days). Alongside the token, `user_sessions` records live sessions so they can be revoked server-side — a rotated password invalidates existing sessions. A TTL-cached principal lookup keeps repeated authenticated requests off bcrypt and off Mongo (~280 ms cold → ~42 ms warm).

Two separate principals exist: **staff** (`users`) and **customers** (`customers`, portal login for quote viewing). Login is rate-limited by IP and identifier (`services/rate_limit.py`), shared across replicas when `REDIS_URL` is set and per-process otherwise.

Browser downloads (`?dl=` PDFs, chalans, `.xlsx` exports) are plain navigations that structurally cannot carry auth or floor headers, so they use short-lived download tokens that record both the session and the active floor at mint time and replay them at consumption.

### Permissions
Two independent layers, both enforced server-side:

1. **Roles** — 8 roles in a strict hierarchy: `owner` 100, `admin` 90, `manager` 70, `accounts` 60, `purchase` 50, `sales` 40, `warehouse` 30, `worker` 10. Routes declare either `require_roles("owner","admin",...)` or `require_min_role("manager")`. Labels and human-readable capability blurbs live in `auth.py` as the single source of truth and are served to the frontend via `GET /api/roles`, so the Team screen never hardcodes the role list.
2. **Module permission matrix** — an owner-editable role × module grid persisted in `settings` under `permission_matrix`, covering 11 modules (dashboard, quotations, catalog, customers, purchases, payments, followups, notifications, team, settings, sales-data). Defaults mirror the pre-feature nav: everything open to `worker` and above except Team (`manager`) and Sales Data (`admin`).

### Floor Isolation
The load-bearing security property of the system. Three floors are seeded: `ground-floor` (Ground floor — Tiles), `first-floor` (The Sanitary Bathroom), `second-floor` (reserved, unused).

- Every scoped document carries a `floor_id`. Users carry `floor_ids[]`.
- The client sends the active floor as an `X-Floor-Id` header; the server intersects it with the user's assignment.
- Reads go through `floor_query(user, filter)`; writes through `floor_for_write()` / `floor_inherit()`; id-addressed lookups through `get_floor_scoped_or_404()`, which returns **404, not 403**, on a cross-unit id so existence is not disclosed.
- A structural gate in the test suite asserts that id-addressed mutations are floor-scoped, so a new route cannot silently opt out.
- Tile Orders is pinned harder still: `tiles_floor_query` forces Ground Floor unconditionally regardless of the header sent.
- A committed live-probe harness (`backend/scripts/probe_floor_isolation.py`) mints a real session and hits every scoped read three ways — no header, `first-floor`, `ground-floor` — asserting the set of `floor_id` values actually returned. At the last run every endpoint returned exactly one floor's rows and no cross-floor row appeared anywhere.

**One documented asymmetry remains:** `floor_query()` is unrestricted for an all-floors caller who sends no active floor, while `floor_for_write()` defaults to a single floor. This is unreachable through the product (login pins a floor, the switcher has no "All floors", and downloads were closed by the token binding above) but a direct API call or a future integration would bypass scoping. Hardening it touches every module and was deliberately not attempted during the freeze.

### Analytics
Three generations of analytics coexist, which is important context for anyone reading the numbers:

1. **Dashboard** (`dashboard_routes.py`) — per-floor operational counters on the Today screen.
2. **Executive Analytics / Executive OS** (`executive_analytics_routes.py`, `executive_overview_routes.py`, `sales_performance_routes.py`, `referral_analytics_routes.py`, `sales_breakdown_routes.py`, backed by `services/analytics/`) — the richer generation: health scores, attention/opportunity surfaces, morning brief, activity feed, periods, breakdowns, caching.
3. **Sales Data** (`sales_data_routes.py`) — the Milestone 4 launch dashboard: revenue, orders, payments, brands, customers, products, referrals, recent orders.

Generations 2 and 3 compute from overlapping-but-different definitions, so **`/executive-analytics` figures and Sales Data figures do not reconcile line-for-line**. That is a known, accepted divergence, not a bug to chase. Both read cross-floor by design for owner/admin via `accessible_floor_ids`.

Sales Data navigation carries the full planned workspace architecture, with unbuilt workspaces routed to a real "coming soon" screen rather than hidden — a deliberate owner directive (never delete or hide a planned surface; show it as Coming Soon). Implemented: Sales Data, Executive, Today's Priorities. Planned: Revenue, Collections, Forecasting, Customers, Architects, Interior Designers, Relationships, Products, Brands, Suppliers, Operations.

### Automation
Two mechanisms:

- **Domain outbox** (`services/domain_outbox.py`) — durable event dispatch. Mutations write an event to `event_outbox` in the same transaction; a background worker (`outbox_worker`, started at app startup) dispatches with retry and dead-letters after repeated failure. Events inherit the source record's floor.
- **Automation rules** (`services/automation_rules.py`) — follow-up cadences held in Mongo (`automation_rules`), *not* hardcoded, editable by owner/admin/manager. Seeded defaults: Tile Selection `[0,2,4,7,10]` days, Tile Quotation `[2,5,10,15]`, Walk-in `[1,3,7,14]`. Any category key is accepted, so a new department registers its own cadence without a code change. Staff-edited cadences are never overwritten by the seeder.

### Tile Orders
The Ground Floor logistics module, and the most operationally complex domain in the system. Models live in `models_tile_orders.py`; 26 endpoints in `routes/tile_orders.py`.

Object graph: `customer_orders` → `ready_batches` → `dispatches` → `chalans`, with `material_movements` recording physical stock moves.

Status is derived, never hand-set. `services/tile_order_status.py` is a pure module (no DB access) called by every write endpoint after box counters change, so stored `overall_status` / `current_location` / `completion_percentage` cannot drift from the counters that produced them. Two deliberately separate axes:

- **Status ladder** (furthest-progress): Pending → Ready → Partially Dispatched → Dispatched → Delivered.
- **Physical location**: Pending → Ready → Dispatched → Godown → Delivered. *Godown is not on the status ladder* — a fully dispatched item can sit at Buildcon's own warehouse while its status is still Dispatched.

Chalan PDFs are generated server-side (`pdf_chalan.py`). Vehicle and driver capture, dispatch creation/editing, and a clickable Register are all wired. A route-contract check (`scripts/verify-tile-orders-contract.mjs`) runs in CI to catch frontend/backend workflow drift.

### Followups
`services/followup_engine.py` plus 23 endpoints. Follow-up cards are *derived* from business state — customers, quotations, purchase orders — reconciled against the `followups` collection, with `source_key` as the idempotency handle under a unique index.

`reconcile_followups()` is fired as a fire-and-forget task from 15 mutation routes and coalesced behind a lock so concurrent writes do not stack. It reads open, snoozed **and closed** source keys, so a card a human already completed is never resurrected, and inserts are guarded against `DuplicateKeyError` so one bad key cannot abort the whole pass. (That guard exists because it once did: a single duplicate killed follow-up automation app-wide, silently, for both floors.)

Supporting surfaces: saved views (`followup_saved_views`), per-user assignment, call-outcome and contact logging, snooze/complete.

### Sales Data
See *Analytics* above. **This module is FROZEN by owner directive** — no further work, and it was explicitly excluded from the floor-isolation audit. It ships in the app and its routes read cross-floor for owner/admin by design.

### Purchases
Two coexisting surfaces:

- **Purchase orders** (`purchase_routes.py`, 9 endpoints) — supplier POs, staged receiving, attachments, embedded chalans, status events.
- **Purchases Tracker** (`purchases_tracker.py`, 25 endpoints) — the operational layer: shortages, transfers between units, movement engine, PO-from-shortage creation.

Numbering (`QT-`, `PO-`, `CH-`) is allocated by `services/sequence.py` against a `counters` collection, with a collision-recovery path that rescans existing numbers if a counter is lost.

Purchases is hidden on Ground Floor in the nav (the most recent commit on `main`).

### Notifications
`notifications` collection, delivered via the in-app bell. Carries `floor_id` (added in migration `0014`) and is filtered by both `user_id` and the caller's floor scope. `services/notifications.notify()` requires an explicit floor from the source record — it does not infer one from ambient request state.

### Activity
`activity_events` — the audit and timeline substrate. Two read shapes:

- **Global feed** (`GET /api/activity`), floor-filtered in Mongo.
- **Per-entity timelines** (quotation / purchase / customer / product), where the parent access check is the boundary and floor filtering is deliberately *not* applied — filtering there would blank out legitimate history.

`log_event()` takes an explicit `floor_id` and falls back to the actor's active floor. Call sites where the request header is not the authority stamp explicitly: all 12 Tile Orders sites pin Ground Floor, quotation events take the document's own resolved floor, automation events inherit from the follow-up.

Rows the `0014` backfill could not resolve keep a **null** floor and are invisible to every unit — chosen over guessing a floor (silent corruption) or matching nulls everywhere (re-creating the leak).

### RBAC
See *Permissions* above. Enforcement is server-side at the route; the frontend's `use-permissions` / `use-roles` / `use-floor-access` hooks mirror it for nav visibility only and are not a security boundary.

### Settings
Company profile, PDF/quotation branding, catalog options, notifications, walk-in lead sources, privacy/terms text, permissions matrix, password change, system diagnostics. Persisted in the `settings` collection keyed by setting name. Frontend surfaces are one screen per domain under `app/(admin)/settings-*.tsx`.

### Deployment
- **Backend** — `backend/Dockerfile`, `python:3.12-slim`, non-root `forge` user, `requirements-prod.txt`, uvicorn 2 workers on `:8000`, `HEALTHCHECK` hitting `/api/health` (which returns 503 when Mongo is unreachable, so it doubles as a readiness probe). All configuration comes from the process environment; `.env` is never baked into the image.
- **Preview/dev** — Emergent pod (`.emergent/emergent.yml`, image `expo_mongo_base_image_cloud_arm:release-02072026-3`), with a pod-local webhook-cron dispatcher that self-heals its crontab from the persistent workspace copy on resume.
- **Mobile** — EAS (`eas.json`) with development / preview / production profiles, `appVersionSource: remote`, `autoIncrement` on production. `submit.production` is still empty.
- **CI** — GitHub Actions (`.github/workflows/ci.yml`) on every push and PR. Backend job: `pip-audit`, pyflakes, `compileall`, `pytest tests/unit`, Docker build. Frontend job: `npm audit --audit-level=high`, `tsc --noEmit`, Tile Orders route-contract check, `expo lint`. Integration tests are intentionally excluded from CI — they need a live backend with real credentials and must never touch the production Atlas cluster.

---

## 2 · Repository Structure

```
forge2.0/
├── backend/                  FastAPI service
│   ├── server.py             entrypoint, router wiring, startup sequence
│   ├── settings.py           fail-fast config loader (env authoritative)
│   ├── bootstrap.py          infrastructure preflight + demo-account check
│   ├── db.py                 Motor client
│   ├── auth.py               JWT, principals, RBAC, floor scoping primitives
│   ├── middleware.py         security headers
│   ├── models*.py            Pydantic domain models
│   ├── seed.py               first-run demo/reference data
│   ├── pdf_*.py              quotation, tiles and chalan PDF generation
│   ├── routes/               27 routers
│   ├── services/             domain services (incl. services/analytics/)
│   ├── migrations/           numbered forward-only migrations + runner
│   ├── media_storage/        Supabase storage driver
│   ├── catalog_pipeline/     brand import/normalisation pipeline
│   ├── scripts/              operational scripts (backup, probes, imports)
│   └── tests/                unit/ (129 files) + integration/ (13 files)
├── frontend/                 Expo app
│   ├── app/                  expo-router file routes
│   ├── src/api|components|hooks|state|design|theme|services|utils
│   └── scripts/              contract verification, guards
├── docs/superpowers/         plans + design specs per feature
├── memory/                   import/QA reports, PRD, design inventory
├── .github/workflows/ci.yml
├── .emergent/                preview-pod config and cron
└── *.md                      audits, roadmaps, release reports
```

### Major backend routers (237 endpoints)

| Router | Endpoints | Domain |
|---|---:|---|
| `tile_orders.py` | 26 | Ground Floor logistics: ready → dispatch → chalan → delivery |
| `purchases_tracker.py` | 25 | shortages, transfers, movement engine |
| `followup_routes.py` | 23 | follow-up cards, assignments, saved views, outcomes |
| `catalog_routes.py` | 20 | products, brands, categories, variants, search |
| `quotation_routes.py` | 17 | quotation lifecycle, revisions, order placement |
| `walkin_routes.py` | 12 | walk-in CRM, duplicate resolution |
| `misc_routes.py` | 11 | exports, downloads, PDFs |
| `auth_routes.py` | 10 | staff + customer login, sessions, password |
| `purchase_routes.py` | 9 | purchase orders, receiving, attachments |
| `executive_analytics_routes.py` | 9 | Executive OS metrics |
| `catalog_import_routes.py` | 9 | brand import jobs, snapshots, approval |
| `executive_overview_routes.py` | 8 | morning brief, health, attention |
| `customer_routes.py` | 8 | customers + portal |
| `sales_performance_routes.py` | 6 | salesperson performance |
| `payment_routes.py` | 6 | payments, receivables |
| `media_routes.py` | 6 | product media upload/replace/delete |
| `settings_routes.py` | 5 | company, PDF, catalog, notification settings |
| `activity_routes.py` | 5 | global feed + entity timelines |
| `supplier_routes.py` | 4 | suppliers |
| `sales_data_routes.py` | 4 | Sales Data launch dashboard *(frozen)* |
| `sales_breakdown_routes.py` | 4 | breakdown drilldowns |
| `referrer_routes.py` | 2 | referrer directory |
| `referral_analytics_routes.py` | 2 | referral performance |
| `permissions_routes.py` | 2 | module permission matrix |
| `analytics_settings_routes.py` | 2 | analytics targets/config |
| `roles_routes.py` | 1 | role list + capabilities |
| `dashboard_routes.py` | 1 | Today screen aggregate |

### Major backend services

`floor_scope` (floor bootstrap/defaults) · `activity_log` · `notifications` · `followup_engine` · `automation_rules` · `domain_outbox` · `workflow_transitions` · `transfer_workflow` · `chalan_stage` · `tiles_stage` · `tile_order_status` · `tile_movement_log` · `tile_order_indexes` · `catalog_service` (catalog read model) · `media_service` · `duplicate_detection` · `walkin_service` · `pricing` · `sequence` (QT-/PO-/CH- numbering) · `export` · `download_tokens` · `rate_limit` · `invite_service` · `email_service` · `messaging_service` · `monitoring` · `analytics/` (attention, breakdowns, cache, collections, feed, filters, gather×4, health, metrics, opportunity, performance, periods, referrals, rows)

### Major frontend pages

- **Auth** — `login`, `set-new-password`
- **Today** — `dashboard`
- **Walk-ins** — `index`, `new`, `[id]`
- **Quotations (Sanitary only)** — `index`, `new`, `[id]`, `[id]/place-order`
- **Tiles (Ground Floor only)** — `tiles/index`, `tiles/selection`, `tiles/quotation`, `tiles/orders/index`, `tiles/orders/[id]`, `tiles/orders/brands/[brandId]`, `tiles/orders/po/[poId]`
- **Catalog** — `index`, `[id]`, `import`
- **Customers** — `index`, `new`, `[id]`, `[id]/edit`
- **Purchases** — `purchases`, `purchase-orders/index`, `purchase-orders/[id]`
- **Payments** — `payments`
- **Follow-ups** — `followups`, `followup-assignments`
- **Notifications** — `notifications`
- **Sales Data** — `index`, `executive`, `today`, `brand/[id]`, `brands/[id]`, `people/[kind]/[id]`, `referrer/[id]`, `coming-soon`
- **Team & Settings** — `team`, `settings` + 10 domain settings screens
- **Customer portal** — `home`, `quotes/index`, `quotes/[id]`
- **Public** — `privacy`, `terms`

### Shared components

`ui.tsx` and `ds.tsx` (design system primitives) · `AdminPage` / `ScaffoldScreen` (page chrome) · `BottomSheet` · `Toast` · `ActivityTimeline` · `ProductImage` · `TempPasswordDialog` · `design/` (BrandLogo, CommandPalette, Screen, components, responsive, tokens) · `charts/` (ChartFrame, Sparkline) · `analytics/` (MorningBrief, HealthScoreCard, MoneyBlockedCard, ActivityFeed, ActionRow, RowList, WorkspaceSwitcher, HistoryNote) · `quotation/` (a full sub-architecture: canvas, catalog, context, footer, layout, panes, sheets, shared, helpers) · `tiles/` (TileLayout, TileTable, TilesDocBuilder, TilesProductPicker, TileOrderStatusUI, CreateDispatchSheet, DispatchRecordSheet, TileMovementSheets) · `salesData/` · `walkins/` · `purchases/MovementEngine` · `catalog/`

### Important utilities

**Frontend** — `src/api/client.ts` (fetch wrapper: base URL, bearer token, `X-Floor-Id`), `src/state/auth.tsx` (auth context), `hooks/use-permissions`, `use-roles`, `use-floor-access`, `use-breakpoint`, `utils/downloadFile`, `utils/portalPdf`, `utils/storage/` (platform-split secure storage), `lib/monitoring.ts`.

**Backend scripts** — `run_migrations.py`, `ensure_indexes.py`, `probe_floor_isolation.py` (live floor-isolation harness, exit code 64 = missing password, distinct from an isolation failure), `rotate_demo_credentials.py`, `backup_db.py` / `restore_db.py` / `pull_backup_from_supabase.py`, `data_integrity_audit.py`, `catalog_verify.py`, `full_catalog_audit.py`, plus per-brand import runners (GROHE, Hansgrohe, Geberit, Vitra, Oyster, Qutone, Dimore).

---

## 3 · Database Summary

MongoDB, database `buildcon_house` (production). Documents are keyed by an application-generated string `id`; `_id` is never used as the domain identifier.

### Collections (36)

**Identity & access** — `users`, `user_sessions`, `floors`, `settings`, `download_tokens`
**CRM** — `customers`, `walkins`, `referrers`
**Catalog** — `products`, `brands`, `categories`, `product_media`, `product_usage`, `catalog_imports`, `catalog_import_snapshots`, `catalog_image_blobs` *(legacy)*
**Sales** — `quotations`, `payments`
**Purchasing** — `suppliers`, `purchase_orders` (with embedded `chalans[]` and `items[]`), `purchase_shortages`, `purchase_transfers`, `chalans`
**Tile Orders** — `customer_orders`, `ready_batches`, `dispatches`, `material_movements`
**Workflow & automation** — `followups`, `followup_saved_views`, `automation_rules`, `workflow_transitions`, `event_outbox`
**Observability** — `activity_events`, `notifications`
**Infrastructure** — `counters`, `schema_migrations`

### Relationships

```
floors ──< users (floor_ids[])
floors ──< everything scoped (floor_id)

customers ──< walkins
          ──< quotations ──< payments
          ──< followups
          ──< activity_events

brands ──< products ──< product_media
categories ──< products
products ──> quotations.items[]  (line items, denormalised)

suppliers ──< purchase_orders ──< items[] ──< chalans[]
                              ──< purchase_shortages ──> purchase_orders
                              ──< purchase_transfers

customer_orders ──< ready_batches ──< dispatches ──< chalans
                ──< material_movements

quotations / purchase_orders / customers ──> followups (source_key)
any mutation ──> event_outbox ──> notifications / activity_events
```

### Indexes

Created idempotently by `scripts/ensure_indexes.py` plus per-domain ensures at startup (`ensure_outbox_indexes`, `ensure_tile_order_indexes`, `ensure_transfer_indexes`, `ensure_download_token_indexes`, `ensure_migrations_index`). `_safe_create_index` tolerates MongoDB error 85 (same keys under a different name, typical of an index made by hand in the Atlas UI) and logs-but-continues on 11000 (live duplicate data blocking a unique index) instead of crashing startup.

Notable:

| Collection | Index | Purpose |
|---|---|---|
| `products` | `products_text_v1` (weighted text: sku 20, name 12, family 10 …) | catalog search |
| `products` | `products_hierarchy` (brand, category, subcategory, series) | faceted navigation |
| `products` | `products_active_name_id` / `_price_id` / `_price_desc_id` | keyset pagination |
| `products` | `products_sku_brand_unique` **(unique)** | closes the historical Hansgrohe/AXOR data-loss class |
| `products` | `sku` unique per (floor, brand) — migration `0006` | floor-scoped SKU identity |
| `brands` / `categories` | `(floor_id, slug)` **unique, sparse** | floor-scoped slugs |
| `users` | `email` **unique** | account identity |
| `quotations` | `number` **unique** | document numbering |
| `purchase_orders` | `number` **unique**, `chalans.number` | numbering + CH- counter recovery scan |
| `customers` | `email` **unique, sparse** | closes a check-then-insert race |
| `quotations` | `analytics_orders_floor_date` / `_salesperson_date` / `_customer_date` | Executive analytics aggregations |
| `payments` | `analytics_payments_floor_date`, `quotation_id`, `(quotation_id,status)` | receivables + order detail |
| `activity_events` | `activity_entity_timeline` (entity_type, entity_id, created_at desc) | entity timelines |
| `followups` | `followups_source_key_unique` **(unique)** | reconciliation idempotency |
| `user_sessions` | `id` unique, `(user_type, user_id)` | revocation |
| `product_media` | `id` unique, `product_id`, `family_key`, `(sha1, product_id, source_type)`, `(is_primary desc, sort_order)` | media dedupe + ordering |
| `schema_migrations` | `name` **unique** | migration ledger |

### Migrations — current schema version `0014`

Forward-only, no `down()`. Filename order is apply order. Each must be idempotent; the runner records success in `schema_migrations` and skips applied ones. Migrations run automatically at startup, or manually via `scripts/run_migrations.py` (`--dry-run` lists pending).

| # | Migration | What it does |
|---|---|---|
| 0001 | `baseline` | establishes the ledger against existing data |
| 0002 | `add_catalog_import_snapshots_index` | import snapshot lookup |
| 0003 | `add_user_sessions_indexes` | session id + type/user |
| 0004 | `backfill_brand_category_floor_id` | floor-stamps brands and categories |
| 0005 | `add_categories_slug_unique_index` | category slug uniqueness |
| 0006 | `products_sku_unique_per_floor_brand` | SKU identity scoped to floor + brand |
| 0007 | `add_brands_slug_unique_index` | brand slug uniqueness |
| 0008 | `floor_scoped_brand_category_slugs` | converts slug uniqueness to (floor, slug) |
| 0009 | `add_purchase_orders_chalans_number_index` | CH- counter recovery scan |
| 0010 | `add_customers_email_unique_index` | customer email race |
| 0011 | `backfill_quotation_net_amounts` | denormalised net amount for analytics |
| 0012 | `backfill_quotation_ordered_at` | order timestamp for analytics periods |
| 0013 | `add_analytics_indexes` | Executive analytics compound indexes |
| 0014 | `backfill_activity_notification_floor_id` | floor-stamps activity + notifications; unresolvable rows keep a null floor and stay invisible to every unit |

---

## 4 · Environment Requirements

### Backend

Python **3.12**. Configuration comes from the process environment; `backend/.env` is a local/preview fallback only and never overrides platform-injected values. `settings.py` fails fast with `ConfigurationError` on anything missing or placeholder-shaped (`<...>`, `...`).

**Required — the backend refuses to start without these:**

| Variable | Notes |
|---|---|
| `MONGO_URL` | Atlas connection string |
| `DB_NAME` | `buildcon_house` in production |
| `JWT_SECRET` | 32+ chars — `openssl rand -hex 32` |
| `SUPABASE_URL` | project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | server-side only, never shipped to clients |
| `SUPABASE_ANON_KEY` | |
| `SUPABASE_PUBLIC_BUCKET` | `forge-products` |
| `SUPABASE_PRIVATE_BUCKET` | `forge-private` |

**Optional (defaults shown):** `JWT_ALGORITHM=HS256` · `JWT_EXP_MINUTES=43200` · `MEDIA_STORAGE_DRIVER=supabase` (only driver implemented) · `ENVIRONMENT=development` (`production|staging|development`) · `FORGE_ALLOW_DEMO_SEED=false` (**must stay false when `ENVIRONMENT=production`**) · `FORGE_DEMO_PASSWORD` (only when demo seed is on) · `REDIS_URL` · `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE=0.1` · `POSTHOG_API_KEY`, `POSTHOG_HOST` · `INVITE_SERVICE_DRIVER=manual` · `BACKUP_DIR=./backups`

Dependencies: `requirements.txt` (dev) / `requirements-prod.txt` (image). Run: `uvicorn server:app --host 0.0.0.0 --port 8000 --workers 2`.

### Frontend

Node **20**, `npm ci` in CI (yarn 1.22.22 declared as `packageManager`). One variable:

| Variable | Notes |
|---|---|
| `EXPO_PUBLIC_BACKEND_URL` | API base URL, **no trailing slash** |

### Mongo
MongoDB Atlas. Replica-set required — Tile Orders dispatch and the domain outbox use multi-document transactions (`session=`). Indexes are ensured at startup; migrations apply automatically.

### Supabase
Storage only. Two buckets (`forge-products` public, `forge-private` private). Service-role key must be server-side only.

### Redis
**Optional.** Shared rate-limit state across replicas. Omitted → per-process in-memory limiting, which is correct for a single instance and degrades gracefully (a failed client init logs a warning and falls back rather than failing the request).

### Expo
SDK **54**, new architecture enabled, `expo-router` 6 with typed routes. App identity: name `BuildCon House`, slug `buildcon-house`, scheme `buildconhouse`, version `1.0.0`.

### Web
Metro bundler, `output: "single"` (SPA). Runs anywhere static files can be served. This is the surface the business uses day to day.

### iOS
Bundle id `com.buildconhouse.app`, tablet supported, portrait, `ITSAppUsesNonExemptEncryption: false`, `NSPhotoLibraryUsageDescription` set. Built via EAS. `PrivacyInfo.xcprivacy` is **not** present.

### Android
Package `com.buildconhouse.app`, edge-to-edge, adaptive icon, `READ_MEDIA_IMAGES` permission. Built via EAS.

---

## 5 · Release Notes

### Completed

**Core ERP**
- Catalog: ~2,966 products across GROHE, Hansgrohe/AXOR, Geberit, Vitra, Oyster, Qutone, Dimore, with a repeatable import pipeline, weighted text search, faceted navigation, variants, and SHA-1-deduped media on Supabase.
- Quotation Builder (Sanitary): rooms, line items, discounts, variants, custom products, revisions, referrer attribution, PDF generation, customer portal viewing.
- Tile Selection and Tile Quotation builders (Ground Floor).
- Customers, walk-in CRM with tiered duplicate detection, referrer directory.
- Purchase orders, staged receiving, shortages, inter-unit transfers, movement engine, chalans.
- Payments and receivables.
- Follow-ups engine with DB-backed configurable cadences, saved views, assignments, call outcomes.
- Tile Orders logistics end to end: ready batches → dispatch → chalan → delivery, with derived status, vehicle/driver capture, clickable Register, and chalan PDFs.
- Notifications, activity timeline, in-app audit trail.
- Team management, 8-role RBAC, owner-editable module permission matrix.
- Settings across company, PDF, catalog, notifications, walk-ins, privacy, terms, system.
- Customer portal for quote viewing.

**Platform**
- Floor isolation enforced in Mongo across all 17 scoped endpoint families, verified live by a committed probe harness. Cross-unit id access returns 404, not 403. A structural test gate blocks new unscoped id-addressed mutations.
- Download tokens bind session *and* floor, closing the one request path that structurally cannot send headers.
- Numbered forward-only migration runner with an auditable ledger, replacing ad-hoc one-off scripts.
- Fail-fast configuration with a startup preflight that gates readiness.
- Durable domain outbox with retry and dead-lettering.
- Login rate limiting, security headers, non-credentialed CORS, session revocation, `pip-audit` and `npm audit` in CI.
- Full CI: lint, typecheck, compile check, 832 unit tests, route-contract verification, Docker build.
- Backup/restore tooling and a data-integrity audit script.

**Most recent milestones**
- `bb3baef` — Milestone 4: Sales Data MVP (launch dashboard).
- `5b3ef6b` — Tile Orders logistics redesign.
- `71017e3` — Phase 1: floor scope asymmetry resolved, write-path isolation probing added.
- `ca062d7` — Purchases hidden on Ground Floor; Sales Data tab row rebuilt. **← release commit**

### Intentionally deferred

- **Sales Data / Executive OS beyond Milestone 4** — frozen by owner directive. Eight further workspaces (Revenue, Collections, Forecasting, Customers, Architects, Interior Designers, Relationships, Products, Brands, Suppliers, Operations) are navigable and land on a real Coming Soon screen rather than being hidden. Owner directive: *never delete or hide — show Coming Soon.*
- **Restrictive `floor_query()` default for header-less all-floors callers** — deliberate. It touches every module and the executive/Sales Data surfaces legitimately read cross-floor; a blind change was judged riskier than the remaining exposure, which is unreachable from the product.
- **Store submission work** — no developer accounts, no listing assets, no reviewer account, no hosted privacy/terms URL, `eas.json` `submit.production` empty, Emergent-vs-EAS build path unreconciled, `PrivacyInfo.xcprivacy` missing.
- **Delete/deactivate endpoints** for `customer_orders`, `ready_batches`, `dispatches`, `suppliers` — never built, which is why test fixtures cannot be cleared through the product.
- **Integration test suite in CI** — needs a live backend and real credentials; must never run against production Atlas.

### Known issues

1. **`owner@forge.app` is on the publicly-known demo password.** `/api/health` currently returns `degraded` and startup logs `CRITICAL`. This is a real `bcrypt.checkpw` match against `[legacy password removed; use injected test credentials]`, a string that lives in the git-tracked `backend/seed.py`. It is the highest-privilege account in the system. Fix is one command (see §6). **Hard blocker for any real-customer deployment.**
2. **Test fixtures in the production database.** All 6 Ground Floor tile customer orders are test records (`Task18 Test Customer`, `Task19 MultiSupplier Test`, `TEST_LC4_*`); 7 more sit on first-floor with 2 ready batches, 4 dispatches, 4 chalans and 17 material movements (invisible by construction, still stored); 118 synthetic `followup.call_logged` activity events reference ids that resolve to nothing; a follow-up card named `ZZTEST TILES E2E` is the #1 Ground Floor priority. Clearing these needs new endpoints or a reviewed cleanup script.
3. **Sentry and PostHog are wired but inert** — no DSN or key is set, so a production crash currently goes nowhere.
4. **Executive Analytics and Sales Data figures do not reconcile.** Different generations, different definitions. Accepted, not a bug.
5. **Catalog media gaps** — 16 Qutone tile families (452 products) have zero photos; one GROHE product's Supabase source image is a solid red block.
6. **One live same-brand duplicate SKU** (`26456000`, two distinct Hansgrohe products) blocks `products_sku_brand_unique` from applying catalog-wide. Startup logs and continues; needs a human decision on which record is correct.
7. **Splash image is a poster in a logo-mark slot.**

### Non-blocking limitations

- `reconcile_followups()` is a full scan of customers + quotations + purchase orders, fired from 15 mutation routes. Coalesced behind a lock and fine at current volume (~122 customers, ~78 quotations). It will not be fine at 100k — the clearest scaling cliff in the backend.
- `db.referrers` has no floor scoping. Arguably correct as a shared contact directory, but it is a product decision, not an accident.
- `supplier_routes.py:26` looks up a brand by bare id during supplier creation, so a cross-floor brand *name* could be attached. Low.
- Pydantic v1 `.dict()` calls remain in Tile Orders routes — deprecated in Pydantic 2, removed in 3. 236 deprecation warnings in the test run, zero failures.
- Repo root carries a large amount of historical audit/report markdown and ad-hoc `*_test.py` scripts outside `backend/tests/`. Harmless, but it is not the maintained test suite.
- `second-floor` is seeded but unused.
- Preview containers do not persist gitignored `.env` files across recreation — an Emergent preview limitation, not a code issue.

---

## 6 · Current Production Status

### Production-ready

- **Floor isolation** — enforced in Mongo, probe-verified live across every scoped endpoint family, with a structural test gate preventing regression. This was the single largest risk in the system and it is closed.
- **Core ERP workflows** — quotations, tile selections, tile quotations, customers, walk-ins, purchases, payments, follow-ups, Tile Orders logistics. All exercised live against real data.
- **Catalog** — ~2,966 products, search, navigation, media, repeatable import pipeline.
- **RBAC and permissions** — 8 roles plus an owner-editable module matrix, enforced server-side.
- **Auth** — JWT with server-side session revocation, rate-limited login, forced password reset on temporary credentials.
- **Data integrity** — unique indexes where they matter, versioned migrations, backup/restore tooling.
- **Build and test pipeline** — CI green: 832 unit tests pass, `tsc --noEmit` clean, Docker image builds, dependency scans pass.
- **Web delivery** — the surface the business actually uses day to day is ready.

### Requires operational work

**Before any real-customer deployment (blocking):**

1. **Rotate the owner password.** `/api/health` returns `degraded` right now. One command, which issues a one-time password that forces a reset on first login and revokes existing sessions:
   ```bash
   cd "backend" && ./.venv/bin/python -m scripts.rotate_demo_credentials --apply
   ```
   `/api/health` must return `{"status":"ok"}` before shipping.
2. **Clear the test fixtures** listed in §5 from `buildcon_house`, or accept a paying client seeing `Task18 Test Customer` and `ZZTEST TILES E2E`. No product endpoint can delete them — this needs either new endpoints or a reviewed cleanup script run against the live database.
3. **Set `SENTRY_DSN` and `POSTHOG_API_KEY`** in the production environment, or accept that production crashes are invisible.
4. **Confirm production environment variables** are set in persistent deployment settings, not in a preview container: `MONGO_URL`, `DB_NAME`, `JWT_SECRET`, all four Supabase values, `ENVIRONMENT=production`, `FORGE_ALLOW_DEMO_SEED=false`.

**Before store submission (blocking for mobile only, all untouched):**

- Apple Developer and Google Play developer accounts — neither exists yet.
- Hosted privacy policy and terms URLs (the in-app screens exist; public URLs do not).
- Store listing assets, screenshots, reviewer account.
- `PrivacyInfo.xcprivacy`.
- `eas.json` `submit.production` is empty; the Emergent-vs-EAS build path is unreconciled.
- Splash asset replacement.

**Operational hygiene (non-blocking):**

- Resolve the duplicate Hansgrohe SKU so `products_sku_brand_unique` can apply catalog-wide.
- Backfill the 452 Qutone products missing photos; replace the corrupt GROHE source image.
- Provision `REDIS_URL` before running more than one backend replica.
- Plan the `reconcile_followups()` rewrite before volume grows an order of magnitude.

### Verdict

**Go for internal and pilot use** once item 1 above is done.
**Go for real-customer web deployment** once items 1 and 2 are done.
**No-Go for App Store / Play Store submission** — not because of application defects, but because none of the store-readiness work has been started and neither developer account exists.
