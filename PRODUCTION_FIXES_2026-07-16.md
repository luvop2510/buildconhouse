# Production hardening — session log, 16 Jul 2026

Verified against the live stack (backend on Atlas `buildcon_house`, 2,601 products; Expo web) at 375×812, 768×1024, and 1280×720.

## Fixed and verified this session

### Backend
1. **Follow-ups list/export 500** — `routes/followup_routes.py` referenced `user` while the dependency was still named `_` (floor-scoping refactor leftover). `GET /api/followups` returned 500 on every call and the dashboard silently rendered "All clear" instead of the queue; `GET /api/followups/export` had the same crash. Both now 200 and floor-scoped correctly.
2. **Atomic document numbering** — `FQ-`/`FPO-` numbers were `count+1` (duplicate numbers under concurrent creates). New `services/sequence.py`: `findOneAndUpdate $inc` on a `counters` collection, seeded from the existing max so no already-issued number repeats.
3. **Outbox worker** — events only dispatched at startup or ad-hoc. Now a lifetime background loop (30 s cycle) with retry cap and `dead_letter` status after 8 attempts (`services/domain_outbox.py`, wired in `server.py` startup/shutdown).
4. **Payment recording fallback** — the new transactional balance-check path 503'd on any Mongo without replica-set transactions. Now falls back to the guarded non-transactional path (still idempotency-key protected) only when the server reports transactions unsupported.
5. **Floor-scope user backfill** — staff created before floor scoping have no `floor_ids`; default-deny would have blanked their app. `ensure_floor_scope()` now grants existing users every active floor once (owners can narrow in Team settings).

### Frontend
6. **"All floors" mode** — the floor switcher defaulted to `floors[0]` (Ground floor) while every legacy record was backfilled to First floor, so owners saw empty lists by default. All-floor staff now default to an "All floors" (unscoped) option; switching floors reloads so every mounted screen refetches. Switcher also added to the phone "More" sheet (it existed only on desktop/tablet before).
7. **One breakpoint contract** — removed the last hardcoded `width >= 900 / < 640` checks (followups, payments, purchases, customers ×2, quotations ×2, purchase-order detail, BottomSheet) in favour of `useBp()`; `useBreakpoint()` (catalog/builder) now reads its phone/tablet boundaries and gutters from `design/tokens.ts`. Phone/tablet/desktop now flip at 768/1024 everywhere with 20/28/40 gutters.
8. **AdminPage** — now uses the shared `useBp()` gutter (was a local `width < 768` check that gave desktop pages tablet padding).
9. **Lint errors** — 2 `react/no-unescaped-entities` errors fixed (followups, settings-catalog). `tsc --noEmit` clean; remaining lint output is warnings only.

### Delivery
10. **`backend/Dockerfile` + `requirements-prod.txt` + `.dockerignore`** — reproducible image that does not depend on the PyPI-nonexistent `emergentintegrations` package; health check wired to `/api/health` (which now correctly returns 503 when Mongo is down).
11. **`.github/workflows/ci.yml`** — backend compile + pyflakes + docker build; frontend `tsc` + lint.

### Verified from the prior session's uncommitted work (all confirmed running)
- Payment idempotency key + unique index + Atlas transaction path.
- Demo seed gated behind `FORGE_ALLOW_DEMO_SEED` (default off).
- `/api/health` returns 503 on Mongo failure.
- SVG uploads rejected; uploads size-bounded before read.
- Login "Use demo account" hidden unless `EXPO_PUBLIC_ENABLE_DEMO_AUTH=true` in dev.
- App identifiers renamed to `com.buildconhouse.app` / scheme `buildconhouse`; `NSPhotoLibraryUsageDescription` fixed; `eas.json` present.
- 44 px touch targets in shared Button/IconButton/SegmentedControl/Tabs/Search; ScreenTitle/SectionHeader wrap to 2 lines; BottomSheet footer clearance.

## Still required before charging customers (in priority order)

1. **Rotate the owner credentials.** `owner@forge.app` / `[legacy password removed; use injected test credentials]` is live in the production database and printed throughout the repo's test files. Rotate every `*@forge.app` account password (or deactivate unused ones) before any public exposure. Verified this session that the known password still logs in.
2. **JWT download tokens in URLs** (`?_t=` in `src/api/client.ts` / `auth.py`) — replace with short-lived single-use download tokens; URLs leak into logs/history.
3. **Shared rate limiting** — login limiter is per-process (`services/rate_limit.py`); use Redis or an edge/WAF limit for multi-replica deploys.
4. **Migrations** — bootstrap + one-off scripts exist but there is no versioned migration history; adopt a numbered-migration runner before schema changes on live data.
5. **Backups/DR** — enable Atlas continuous backup/PITR + a documented restore drill; in-app JSON export is not disaster recovery.
6. **Monitoring** — set `SENTRY_DSN` (backend + Expo) and `POSTHOG_API_KEY`; wiring already exists and no-ops without keys.
7. **Store release** — EAS build with final signing, store metadata, privacy policy URL, and real-device permission tests (config is ready; release evidence isn't).
8. **Pagination hardening** — several endpoints still load capped full collections (customers 500, payments 500, followups 10k); fine at current volume, add cursor pagination before ~10× data growth.
9. **UX polish backlog (non-blocking):** collapse catalog phone filters into a sheet; two-line clamp for remaining `numberOfLines={1}` business data; accessibility labels on More-sheet rows and icon-only actions; BuilderTopbar chip overlap at ~1280 px; floor names are currently fixed defaults (Ground/First/Second) — Settings-level floor management UI exists only for create.

## Local dev notes
- `backend/.env` (gitignored) now contains real Atlas/Supabase config; `DB_NAME=buildcon_house`.
- Run backend: `backend/.venv/bin/uvicorn server:app --port 8000` (this session used 8010 because another local process owns 8000).
- Frontend: `frontend/.env` sets `EXPO_PUBLIC_BACKEND_URL`; `npx expo start --web`.
