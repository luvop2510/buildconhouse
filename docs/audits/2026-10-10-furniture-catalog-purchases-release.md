# Furniture, catalog and Purchases release verification

The release adds deterministic company CSV/XLSX catalog updates, preserved
finalized quotation prices and explicit draft price decisions at PO creation.
Large catalogs switch from a bounded warm cache to indexed database paging.
Product identity remains floor/company/SKU; verified media is content addressed,
price-only updates retain it, and unchanged imports avoid extra writes/history.
See [catalog details](2026-10-10-company-catalog-revisions.md).

Furniture's exact RMB charge/deposit ledger follows the supplied photograph.
INR receipts divide by INR per RMB; USD receipts multiply by RMB per USD.
Every entry stores its rate and edit dates. Finalized charges lock. The
unbranded PDF preserves the seven columns, customer heading and colored totals.
Direct WhatsApp sends use private media upload, stable request IDs and signed,
monotonic provider receipts. Timeouts remain unconfirmed instead of causing
automatic duplicate sends. Production has no WhatsApp sender credentials;
sending remains disabled until the operator configures the Business sender and
webhook described in [delivery setup](../deployment/whatsapp-document-delivery.md).
No real customer message was sent by tests or rollout checks.

Kitchen (`second-floor`) and Furniture (`third-floor`) share Catalog, Customers,
Purchases, completed customers, Payments and Fully paid orders with floor guards.
The RMB ledger is Furniture only. Kitchen's quotation/payment design remains
pending the user's supplied layout. See [shared infrastructure](../deployment/furniture-kitchen-infrastructure.md).

Purchases uses PO final, Order in company, Company billing, Inbox and Dispatched.
Per the owner, dispatched means delivered. The customer filter composes with
brand and stage filters and displays scoped counts. Completed customers reuse
the Purchases workspace and qualify only after every active product quantity
has been dispatched. Atomic splits and quantity/Chalan compare-and-set guards
prevent intermediate false completion or loss of active stock. Supplier receipts
alone remain Inbox. See [completion audit](2026-10-10-purchases-completion.md).

## Local acceptance

- Full hermetic backend unit suite: 1,874 passed; six third-party deprecation warnings.
- Disposable Mongo integration suite: 20 passed, including a 10,004-product
  catalog, cache/database endpoint parity, source placements, exact media,
  late pages, strict customer completion, atomic splits, seven competing mutations,
  unique send guards and early/replayed signed receipts.
- Responsive acceptance covers widths 320, 390, 768, 1024, 1280 and 1440 with
  two workers and no retries. Furniture, filters, completed workspace, both
  price decisions, shared floor navigation and return-aware purchase-order
  movement passed all 78 cases on the final rebuilt bundle, with no failures
  or skips.
- TypeScript, zero-warning ESLint, required frontend contracts, tile workflow
  contract, exact RMB arithmetic, font assets and initial-JavaScript budgets pass.
- Expo Doctor: 20/20. Backend compile and CI's Pyflakes error gate pass.

Screenshots and JSON results are retained locally under
`../outputs/release-2026-10-10` in the parent workspace. The PDF preview is
`../outputs/Furniture-RMB-reference.pdf`. These are local evidence, not public
business data or Git/deployment inputs. Browser tests use fixtures and are not
physical-device acceptance or proof of a live WhatsApp provider send.

## Database rollout and limits

The production read-only inventory found 6,565 active products and zero orders
with legacy transit/delivered stages. Controlled migrations 0027–0029 were
applied on 10 October 2026: unique furniture/send indexes, TTL receipt events,
history-preserving stage normalization and catalog query indexes. Subsequent
dry-run reports no pending migrations. Mongo ping, required indexes and
authenticated Supabase bucket readiness pass. No catalog products, customer
records or image objects were deleted by these migrations.

The current dependency audit retains 30 preexisting findings: 22 high and eight
moderate. Its independent GitHub security job remains failing; findings and
artifact-upload quota failures have not been suppressed. No overall green CI
claim is made. Docker is unavailable on the local host; the Railway production
Docker build performs its existing hermetic ASGI import and readiness checks.
Import admission/file/document budgets and explicit oversized-response errors
remain in force; unlimited storage or throughput is not promised.
