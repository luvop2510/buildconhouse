# Ground tile rate units — 6 November 2026

The Ground catalogue contained 1,720 square-foot supplier products without an
explicit `specs.price_unit` or `specs.rate_unit`. The newer per-piece default
therefore mislabeled those products and selected the wrong quotation pricing
basis. Their original supplier files explicitly provide rates per square foot;
the older adapters retained `sqft_per_box` and sometimes `rate_per_sqft` but
omitted the unit.

| Supplier | Affected products | Example source rate |
| --- | ---: | --- |
| Dimore | 256 | `360 PER SQFT` |
| Donato | 128 | `110 PER SQFT` |
| Modulo | 73 | `100 PER SQFT` |
| Nexion | 761 | `350 PER SQFT` |
| Qutone | 466 | `225 PER SQFT` |
| Renite | 36 | `85 PER SQFT` |
| **Total** | **1,720** | |

The read-only live catalogue inspection covered all 2,773 Ground products:
1,720 legacy rows, 214 existing explicit square-foot rows and 839 explicit
per-piece rows. The corrected resolution is 1,934 square-foot and 839 per-piece
products. Supplier names are stored as brand entities even for per-piece
products, so brand IDs alone cannot determine the pricing basis.

Catalogue normalization now exposes `price_unit: sqft` for Ground rows with
legacy square-foot metadata and no explicit unit. Existing `price_unit` or
`rate_unit` values take precedence, including the customer-confirmed per-piece
Panda RIABITA OCRA correction. Missing units without square-foot evidence retain
the showroom's per-piece default. Family grouping and variant/detail responses
use the same resolution. Frontend source-unit resolution also handles cached
legacy payloads.

All six dedicated square-foot import adapters now write an explicit
`price_unit: sqft`, preventing the omission on future imports. No database
records, stored supplier rates, or saved quotation amounts were rewritten.

## Verification

The new backend regression suite reproduced nine failures before the fix.
After the fix, the following focused suite passed **94 tests**. Run from
`backend/` with the existing Python environment and isolated test settings:

```sh
PYTHON_DOTENV_DISABLED=1 \
MONGO_URL=mongodb://localhost:27017 DB_NAME=forge_ci_unit_tests \
JWT_SECRET=ci-unit-test-secret-not-a-real-secret-32chars \
MEDIA_STORAGE_DRIVER=supabase SUPABASE_URL=https://ci-placeholder.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=ci-placeholder-not-real \
SUPABASE_ANON_KEY=ci-placeholder-not-real \
SUPABASE_PUBLIC_BUCKET=forge-products SUPABASE_PRIVATE_BUCKET=forge-private \
FORGE_ALLOW_DEMO_SEED=false ENVIRONMENT=production \
python -m pytest \
  tests/unit/test_catalog_tile_price_units.py \
  tests/unit/test_catalog_size_variants.py \
  tests/unit/test_catalog_family_browse.py \
  tests/unit/test_catalog_family_page_work.py \
  tests/unit/test_catalog_hydration_performance.py \
  tests/unit/test_catalog_refresh_resilience.py \
  tests/unit/test_dimore_adapter.py \
  tests/unit/test_donato_adapter.py \
  tests/unit/test_qutone_adapter.py \
  tests/unit/test_renite_adapter.py -q
```

Frontend regression command from the repository root:

```sh
node scripts/test-tile-quantity-unit.mjs
```

Pre-audit scans were skipped as requested.
