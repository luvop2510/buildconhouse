# Ground Floor final workflow repair — 27 October 2026

Source is isolated in `codex/ground-floor-final-2026-10-27`, based on the
current deployed shared workflow release `9b6f35ea`.

## Confirmed causes and changes

Tile automatic draft writes required a complete quotation address. The editor
also held unsaved data only in memory. Incomplete tile documents now keep durable,
account/document/type-scoped device drafts; named valid drafts save remotely
without an address requirement. Address remains required for quotation PDF/order.
Customer, product, quantity, photo and reference edits use the same recovery and
revocation registry as sanitary drafts. Interrupted saves preserve newer typing;
server-version conflicts require recovery review rather than overwriting newer
records. Stable actor/floor-bound creation keys prevent duplicate first saves
following a lost HTTP response, retaining receipts after deletion.

Tile selection and quotation workflows required separate submission/approval
steps. The only selection progression is Move to Quotation; quotation ordering
remains an explicit Place Order. Retired approval mutations reject attempts and
legacy editable statuses remain usable. Print is removed from both tile editors;
individual Download PDF and Share PDF remain.

The shared order review unnecessarily requested the Sanitary-only `/suppliers`
endpoint together with the valid tile preview. Ground order review now avoids
that request and its irrelevant supplier controls, preserving the explicit order
commit and existing tile purchase automation. Duplicate taps and obsolete
preview/order responses cannot publish into another quotation.

The product picker awaited optional prior-customer prices for up to the full
API timeout before adding a tile. Optional history now has a 500 ms consumer
budget; unavailable history uses current catalog values. Duplicate selection,
close, customer-change and late-size responses are guarded. Catalog reads remain
bounded and floor-scoped. Initial quotation product validation no longer performs
serial network round trips for every line.

Tile PDFs use fixed landscape A4 pages (297 × 210 mm), including multi-page
selections. Metadata rows grow with wrapped customer/reference text. The editor
also gives the architect/interior reference its own spaced section.

Tile document lists show both selections and quotations by default, keep one
simple type filter and retain scoped deletion. Purchases uses compact tabs and
removes the unbounded customer/brand chip lists. Ground walk-in detail follows
the shared simple actions/assignment flow, retaining Schedule Selection.

## Verification and publication

Focused verification: 65 quotation/tile/PDF/floor tests pass, plus seven
real loopback Mongo/admission checks. The Mongo test uses real transactions and
verifies concurrent first-create replay, CAS conflicts, delete protections and
cancellation before late creation. Thirty-two editor/list recovery regressions,
four durable storage cases, five reset cases, nine picker cases and five order
review cases pass. TypeScript, changed-file zero-warning lint and production web
export pass. All 21 focused browser cases passed across desktop, phone Chrome
and phone Safari: 18 on the first run and three quotation reload cases after
fixing a mock URL to include its query string. No application change was needed
for that fixture error. Both long-name/reference PDFs were visually inspected;
all pages are landscape A4.

Independent review found three interruption risks: replay over a newer server
record, saved-to-new identity reuse and uncertain-create discard. Each now has
a targeted passing regression. Key-based discard also receives the same
exclusive mutation admission as ordinary document deletion.

Publication identities and the required full audit are recorded after push. Synthetic browser fixtures intercept business writes. Live
preflight confirmed Mongo connectivity, private bucket access and no pending
migrations on the existing Railway deployment. No production data repair,
quantity change, migration or customer message is part of this release.

GitHub source push, Vercel candidate readiness, production alias promotion and
Railway runtime identity are separate outcomes and must be reported separately.
