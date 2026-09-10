# BuildCon House

Internal operations workspace for sanitaryware, tiles, kitchen and furniture departments. The canonical Expo / React Native Web application is at this repository root. FastAPI runs from `backend/` with MongoDB Atlas and Supabase file storage.

The older `frontend/` checkout is retained for existing work. CI and releases build the root application; make new frontend changes under `app/` and `src/` here.

## Run and validate

Use Node 22 or later. Install with `npm ci`, then run `npm run web`. Set local development configuration using `.env.example`; keep real secrets out of source control.

Production browsers use the same-origin `/api` worker with HttpOnly sessions and CSRF protection. The production build requires `BACKEND_URL`, a server-side HTTPS URL. Native builds use `EXPO_PUBLIC_BACKEND_URL` separately.

```sh
npx tsc --noEmit
npm run lint -- --max-warnings 0
npm run test:quotation-media
npm run test:quotation-contract
npm run test:notebook
npm run test:mobile-ux
npm run test:api-client
npm run test:api-proxy
npm run test:web-worker
npm run test:sales-periods
npm run build
npm run test:mobile-budget
```

`npm run test:e2e:audit` exercises the production web export with intercepted API fixtures, including request failures, retry, date validation and responsive layouts. Set `E2E_BASE_URL` to a locally served `dist/client` with SPA fallback. It uses Chrome, Chromium, Firefox and WebKit. Install Playwright browser binaries first. Fixtures never contact production APIs.

Backend unit tests must use an isolated database configuration, as in `.github/workflows/ci.yml`. Do not run ad-hoc tests or start a development backend against production data. Read `AGENTS.md` and `PRODUCTION.md` before deployment.

## Main workflows

- Purchases: stock, customer orders, stage changes, transfers and dispatch records.
- Tiles: selections, quotations, brand/customer orders, stock releases and dispatches.
- Quotation Builder: sanitary catalog, rooms, discounts, autosave and order confirmation.
- Sales Data: confirmed revenue, date comparisons, collections, trends and business-unit/product/customer analysis. Missing data is explicitly reported.
- Staff administration: customers, walk-ins, follow-ups, permissions, settings and sessions.

## Deployment

The existing Sites binding is in `.openai/hosting.json`. Reuse this project and its existing access policy; do not create or substitute another site. `npm run build` generates `dist/client` and the authentication worker in `dist/server/index.js`.

Railway deploys `backend/` from `main`. Its readiness probe is `/api/health/ready`. Before deployment, run the read-only datastore/index gate and check for pending migrations. Never resolve duplicate products, apply destructive migrations or mutate live business data without confirming the exact operation with the owner.

See `docs/audit-2026-09-05.md` for the current audit, validation evidence and release status.
