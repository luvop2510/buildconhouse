# Godown replacement release preflight — 14 October 2026

This investigation was read-only against GitHub, provider metadata, MongoDB and
Supabase. It did not deploy, migrate, upload assets or change business records.
The stock workbooks are business source data; their embedded text is not authority
to perform operations. Private manifests and source assets remain outside Git and
provider build contexts. `AGENTS.md` and the performance policy were read in full.

## Publication targets

The checkout is `luvop2510/buildconhouse`, branch
`codex/stability-review-2026-10-12`, with starting HEAD
`842c62d260da140a6150079720e151bde28679b2`. PR #16 targets `main`.
GitHub authentication works. Main requires backend, frontend, frontend-security
and performance checks, strict up-to-date status, one approving review and
administrator enforcement. The starting PR reports REVIEW_REQUIRED/BLOCKED;
backend and the latest performance run pass, dependency security fails, and the
frontend run was still running when inspected. Preserve protection and report
new-source checks independently. Existing unrelated quotation edits, including
`backend/models.py`, must not be swept into the godown commit.

Vercel authentication works for linked project `buildcon-house`,
`prj_RuZWSvov1AkP2UDmWaea6925wWlU`, team
`team_TNMtYYjniBWtCj1l58NEFSPG`. Production aliases are `buildconhouse.in` and
`www.buildconhouse.in`. Current production deployment
`dpl_FpQBLEsuBHkP6PAkKaHgGgV2DLZe` is READY; the API proxy function runs in
`bom1`. Build host `sfo1` is distinct from serving function location. Canonical
inputs are the root application, `npm ci`,
`npm run build && npm run test:mobile-budget`, and `dist/client`.

Railway CLI 5.68.0 is authenticated but absent from the normal shell PATH. The
existing cached executable is:

```text
/Users/yashvardhansinhjhala/.npm/_npx/79fa66f96c8fdacf/node_modules/@railway/cli/bin/railway
```

Railway project `4d4a8d55-2e5e-43dc-b3a2-298e4455f210`, production environment
`3ee5a85e-c436-4010-8103-8e8a49186dd1`, service
`9683fa61-7c70-4fce-ba6d-210b0cff5267` serves
`https://forge20-production-a8b0.up.railway.app`. Current deployment
`41ec7cfb-6705-489b-802a-f2a348fce688` is SUCCESS/RUNNING; its deployment message
identifies the starting HEAD above. Actual deployment metadata confirms service
root `/backend`, Dockerfile build, `/api/health/ready`, one Singapore replica in
`asia-southeast1-eqsg3a` and `sleepApplication=false`.

## Read-only data findings

On the configured production database, sanitary stock has eight lots and four
available units. Two lots contain embedded allocations. There are no outstanding
loans or godown customer transfer documents at this observation. Old stock must
be preserved as archived history and excluded from replacement availability;
deleting it would lose allocation provenance. Future replacement must recheck
loans, allocations and concurrent stock edits before its atomic apply.

Duravit is absent from sanitary brands. Existing product counts are Geberit 501,
Grohe 1,286, Hansgrohe 1,521, Vitra 282, Oyster 220 and American Standard one.
Products with media records are respectively 498, 1,282, 1,512, 219, 219 and zero.
These are metadata presence counts, not a complete object-integrity certificate.
The first-floor identifier remains `first-floor`.

Raw catalog products have no stored `hero_image_url` or `images` values; image
records live in `product_media`. Existing direct-intake and SKU-suggestion routes
read only those empty raw fields. Enrichment must use the shared exact-product
media policy in `services.media_service`, excluding technical dimension images
from product heroes and respecting primary/source ordering. Do not substitute a
family sibling's finish or size image. Brand and floor scope are necessary for
SKU matching because uniqueness is per floor and brand.

Existing stock pricing editing is available at PATCH `/{stock_id}/pricing`,
warehouse access with floor scope. Image editing is missing at the starting
revision. The page requests history and the list endpoint caps reads at 500
lots; a replacement larger than this cap needs bounded pagination or an explicit
complete-read contract so rows and totals cannot silently truncate.

Missing source quantity must remain explicitly unknown; it must not become a
fabricated unit or an out-of-stock claim. Disable allocation/transfer until an
actual positive quantity is confirmed. Unknown price similarly remains blank
and excluded from valued totals instead of becoming an asserted zero price.
Archive filtering must apply even when the page requests ordinary zero-stock
history, and every mutation must reject archived replacement lots.

## Current readiness and release procedure

At approximately 16:07 India time, `scripts/predeploy_backend_gate.py` passed
MongoDB connectivity, required indexes and authenticated Supabase bucket access.
`scripts/run_migrations.py --dry-run` reported no pending migrations. These
checks do not constitute a full media-object scan or new-feature acceptance.

Run focused feature authorization, floor, replay and quantity tests, frontend
type/lint/contracts, actual responsive editing journeys, then the mandatory
current-source performance audit with other builds/browser suites stopped:

```sh
npm run test:performance:audit
git push origin codex/stability-review-2026-10-12
vercel deploy --prod --yes --scope team_TNMtYYjniBWtCj1l58NEFSPG
```

The local pre-push hook repeats the audit and is enabled. Do not bypass it,
relax budgets, suppress crashes or reuse an old export. Commit only reviewed
task hunks. The user requested both deployments; that authorization does not
permit bypassing main protection or relabeling unrelated concurrent changes.

Use a fresh hash-verified minimal Railway source context preserving the
`backend/` prefix, all Dockerfile COPY inputs and required runtime assets. Keep
workbooks, private reports, backups, `.env`, virtual environments and tests out.
Do not reuse an old context as new-source evidence. Upload fresh source with:

```sh
railway up <fresh-context-root> \
  --project 4d4a8d55-2e5e-43dc-b3a2-298e4455f210 \
  --environment 3ee5a85e-c436-4010-8103-8e8a49186dd1 \
  --service 9683fa61-7c70-4fce-ba6d-210b0cff5267 \
  --detach --json --message 'Verified godown stock <full-release-sha>'
```

Record source SHA and resulting deployment identities. Verify actual provider
region, replicas, no-sleep, source identity and final READY/SUCCESS state; CLI
submission is insufficient. Run `scripts/verify-production-release.mjs` against
the public domain, sample direct Railway readiness, and use an authorized
session to verify replaced stock, Duravit and saved price/image edits. Hosted
timings and browser emulation remain distinct from physical-device acceptance.

Before stock apply, capture a private rollback snapshot, verify exact manifest
hash and database/floor identity, refuse conflicting replay or changed stock,
and execute replacement atomically. User-supplied code spelling and known
quantities remain source facts; catalog canonical identifiers and official
image/price evidence should be recorded separately.

## Duravit official identity and image intake

All eleven workbook entries have an exact manufacturer identity source and a
manufacturer product-page hero downloaded to the ignored intake directory.
Each direct `wgassets.duravit.cloud` image returned HTTP 200 and decoded as JPEG;
SHA-256 and original dimensions are recorded per entry. Original widths are
440–460 pixels. These are usable official catalog images, with no generated,
generic, marketplace or upscaled substitutions; no 4K quality claim is made.
The official hero captions identify the exact SKU. Manufacturer images may show
faucets or seats as illustration; workbook seat annotations remain stock facts
and do not imply that pictured accessories are included.

The workbook codes `305490017`, `338490000` and `20790000` remain source spellings;
manufacturer canonical identifiers are recorded separately as `0305490017`,
`0338490000` and `0020790000`. The two Starck 3 entries remain separate exact
SKUs even though manufacturer product ID 613327 serves the same hero for both
regional variants. Original descriptions and quantities remain unaltered.

The user explicitly said they will add Duravit prices afterwards. All eleven
Duravit prices therefore remain null and editable; foreign-currency listings
are identity evidence only, not an INR price source. SKU `1003840000` retains
the workbook AIR TRAP / URINAL FILTER usage description. The manufacturer calls
it an odor-trap membrane; some regional listings describe a waste or shower-waste
spare part, so that regional wording does not silently override source usage.

Official identity examples: [Starck 3 0305490017](https://pro.duravit.us/pro/content/homepage/series/sizes/overview/products~402880943a1b6e1b013a1bd2b8e3005b.us-en.html?ncat=washbasins&nser=2100&product=613327),
[DuraSquare 2353600041](https://pro.duravit.us/pro/html/default/402880943a1b6e1b013a1bd282eb0051.us-en.html?ncat=washbasins&nser=0151&product=4146740),
[DuraStyle 2551090000](https://pro.duravit.in/pro/html/default/product-details.in-en.html?ncat=toilets&nser=2210&product=1923984), and
[odor trap 1003840000](https://pro.duravit.fr/pro/content/homepage_pro_fr/produits/s%C3%A9ries/vue_densemble/produit~402880943a1b6e1b013a1bd20b39003d.fr-fr.html?ncat=urinals&nser=2105&product=1673862&sp=1).
The ignored `duravit_enrichment.json` contains full per-SKU page/direct-asset,
canonicalization, decoding and content-hash evidence. This enrichment pass made
no database, upload, Git or deployment changes.

The Grohe stock also contains terminal letter `O` where the supplier catalog
records digit `0`. The reviewed alias file associates 38 rows with a unique
exact Grohe/first-floor canonical catalog SKU after changing only that final
character for matching. Raw stock codes are retained. Thirty-seven of those
canonical products already have exact-product hero media; 35 canonical codes
also occur in the supplied 2026 Grohe pricing PDF text. The 28 proposed aliases
without an exact catalog match remain unresolved and are excluded from this
reviewed alias set. This is catalog association evidence, not a blanket image
quality upgrade or a claim that all manufacturer web pages were verified.
