# Existing-customer workbook import — 14 October 2026

## Scope and evidence boundaries

The requested release imports six supplied workbooks as existing customer orders,
with their exact product lines and workbook prices, reference/interior attribution
where supplied, purchase items at PO Final, and payment-ledger visibility. Missing
catalog products belong to their verified brands. Workbook text is source data;
it does not authorize unrelated actions. All source lines and order totals were
reconciled before the controlled import.

This public release note contains no customer names, contact details, workbook
contents, database connection strings, credentials or authentication state.
Private source workbooks and business-data reconciliation artifacts stay outside
Git and provider build contexts.

## Read-only production preflight

The following commands completed successfully from `backend/` on 14 October 2026:

```sh
./.venv/bin/python scripts/predeploy_backend_gate.py
./.venv/bin/python scripts/run_migrations.py --dry-run
```

The backend gate reports MongoDB connectivity, required indexes and authenticated
Supabase bucket access passing. Migration dry-run reports no pending migrations.
The configured database is the existing Atlas database `buildcon_house`, using
an SRV connection. These checks do not apply migrations or change business data.
The readiness gate is not a substitute for a complete media-object integrity scan.

## Publication targets and constraints

- Repository: `luvop2510/buildconhouse`; working release branch:
  `codex/stability-review-2026-10-12`; existing pull request: #16.
- Main protection currently requires backend, frontend, frontend-security and
  performance checks, strict up-to-date status, one review and administrator
  enforcement. Preserve those settings and do not bypass them.
- Run the current-source performance audit before publication. The installed
  pre-push hook also runs it, rebuilding its export. Avoid concurrent browser
  suites or builds that can distort timings or replace mutable export assets.
- Existing dependency-security findings remain separate from import acceptance;
  do not suppress them or report an overall green security gate without evidence.
- Vercel project `buildcon-house`: `prj_RuZWSvov1AkP2UDmWaea6925wWlU`, team
  `team_TNMtYYjniBWtCj1l58NEFSPG`; production domains `buildconhouse.in` and
  `www.buildconhouse.in`.
- Railway project `4d4a8d55-2e5e-43dc-b3a2-298e4455f210`, production environment
  `3ee5a85e-c436-4010-8103-8e8a49186dd1`, service
  `9683fa61-7c70-4fce-ba6d-210b0cff5267`; public endpoint
  `https://forge20-production-a8b0.up.railway.app`.
- Railway uses `/backend`, the backend Dockerfile, one Singapore replica and
  `/api/health/ready`. Preserve the existing secrets and authenticator encryption
  root. Provider source configuration can retain an older Git SHA after a local
  CLI upload, so verify the actual deployment identity independently.

## Build and publication procedure

Commit only reviewed changes for this task. Push the current release branch with
the performance hook enabled. The user explicitly requested GitHub publication
and both provider deployments; this does not authorize bypassing main protection.

Vercel builds from the canonical repository root using `npm ci`, then
`npm run build && npm run test:mobile-budget`, with `dist/client` as output.
`BACKEND_URL` must be the existing HTTPS Railway origin for both the build and API
proxy. The build performs a fresh static Expo web export and injects the existing
CSP-compatible recovery/hydration scripts. Preserve `vercel.json`, including its
`bom1` function region, security headers and API proxy routes. `.vercelignore`
excludes backend/legacy frontend, environment files, reports and business assets.

The Vercel connector returned a scope authorization failure during inspection;
the authenticated, explicitly scoped CLI successfully read this same project.
Use that working route:

```sh
vercel deploy --prod --yes --scope team_TNMtYYjniBWtCj1l58NEFSPG
```

Record the full release SHA in deployment metadata and verify the resulting
provider source information. Do not infer success from CLI submission alone.

For Railway, generate a fresh minimal upload context from the reviewed release
source, preserving the `backend/` prefix because the service root is `/backend`.
Include the current Dockerfile, `railway.json`, `.dockerignore`, pinned production
requirements, each Dockerfile COPY source, and required runtime assets/directories.
Exclude real environment files, backups, virtual environments, tests, bytecode,
temporary files and private business data. Retain a SHA-256/size manifest outside
the upload context. Verify copied bytes against the reviewed source before upload;
do not reuse the earlier release's context or manifest as current-source evidence.

The previous release's successful context contained 396 backend files and about
12.8 MB; a larger unrestricted upload had failed snapshot creation. Counts are
historical comparison only, not a required count for this release. `railway up`
publishes fresh source; `railway redeploy` reuses an existing build.

```sh
railway up <fresh-context-root> \
  --project 4d4a8d55-2e5e-43dc-b3a2-298e4455f210 \
  --environment 3ee5a85e-c436-4010-8103-8e8a49186dd1 \
  --service 9683fa61-7c70-4fce-ba6d-210b0cff5267 \
  --detach --json --message 'Verified customer import <full-release-sha>'
```

The authenticated Railway CLI available during this investigation was version
5.66.0. Explicit target IDs avoid relying on a checkout link or changing the
service's existing source settings.

## Import acceptance

The controlled job committed one atomic batch into `buildcon_house` on 14 October
2026. It created six customers and historically dated ordered quotations, nine
brand-grouped purchase orders with all 206 lines at `po_final`, six pending
payment balances, fourteen catalog products and one missing manufacturer brand.
The 279 source units and five interior referral groups reconcile. Four directory
entries were added and one existing interior was reused. Existing catalog
documents were compared against the pre-import snapshot and unchanged.

The user resolved the sole missing offer price and the conflicting workbook date
before apply. Explicit zero-valued lines, blank-discount-as-zero formulas,
manufacturer identity, source SKU spellings and one WC-and-seat package remain
faithful to the reviewed sources. The private manifest preserves the original
cells, formulas, cached values and explicit decisions. No receipt evidence was
provided, so no completed payment was fabricated.

`backend/scripts/import_customer_orders.py` defaults to a read-only plan. Applying
requires the exact manifest hash and production database name, captures a private
backup, validates floor/brand/category identities and source arithmetic, and uses
the application's normal `OrderPlaced` projection inside the batch transaction.
The completed import receipt inventories seventy affected documents; a repeat
dry-run verifies their fingerprints and reports already applied. Modified or
missing imported records, revised workbooks and inconsistent commercial totals
refuse replay. No server bootstrap, migration or outbound message is invoked.

A verified logical backup covers forty-five collections, with an additional
affected-collection backup immediately before the write. Both remain outside Git.
Independent production readback checked every source line against quotation,
catalog, purchase ownership/stage/cost, payment balance, completed event and
activity; actual referral revenue and acquisition aggregation also passed.
Post-import readiness/index/storage and migration dry-run passed.

Validation: the full hermetic backend suite passed 2,389 tests before the final
additional-brand case; all seven focused importer cases then passed, including
real order projections, rollback, source-preserving pricing, zero-valued products,
canonical historical UTC dates, duplicate prevention and replay verification.
The current-source performance audit passed all 48 browser cases, all 159 route
bundle budgets (largest 452 KiB gzip), and its backend/contract checks. The
mandatory pre-push hook will repeat its audit for publication.

## Publication acceptance

GitHub push and provider deployment identities are recorded after completion.

After rollout, run the existing read-only public release verifier:

```sh
node scripts/verify-production-release.mjs https://buildconhouse.in <report-path>
```

Check direct Railway readiness too. Hosted health and browser-emulated acceptance
do not certify physical devices or universal response-time guarantees.
