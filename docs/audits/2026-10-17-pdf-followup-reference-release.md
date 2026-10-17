# PDF sharing, required assignment and referral identity — 17 October 2026

Quotation and Ground selection sharing now offer actual PDF attachments. New
sharing actions no longer create public document URLs or WhatsApp link drafts.
File sharing works without a Business sender; optional direct WhatsApp delivery
uses the existing private media upload, revision checks and idempotent delivery
receipts. Furniture also offers the file-sharing fallback. Existing expiring
capabilities remain readable for compatibility with historical customer links.

The Follow-ups owner chips have a bounded horizontal scroll container. Sales
is removed from new type choices and saved-filter restoration. New manual,
customer and legacy notebook follow-ups require a selected eligible employee on
each interested floor. Human-created callback/pending successors preserve and
revalidate a valid existing assignment, requiring selection otherwise. Missing,
inactive, owner and wrong-floor employees are rejected before business writes;
existing grant, retry and destination-stage checks remain in force.

Architect/interior directory UUIDs have stable ARC-/INT- display codes. Customers,
quotation builders/detail/PDFs, furniture quotations and follow-ups show the
reference identity. Customer/detail, directory pickers and follow-ups expose
floor-scoped acquisition counts, deduplicating people across customer, walk-in,
follow-up, ordinary quotation and furniture sources. Count lookups use exact IDs
without the dashboard leaderboard limit. Printed PDFs show the identity snapshot;
current counts remain available in the associated customer/directory view.
Legacy architect names, including NTS, are recovered from the customer or linked
same-floor records without rewriting history or inventing a directory identity.
Structured existing IDs remain stable; no data migration is needed.

## Verification

- Full hermetic backend unit run: 2,975 passed at integration; focused floor,
  assignment, retry, direct-PDF and extracted-PDF identity regressions also pass.
- TypeScript, zero-warning lint, production web export and relevant frontend
  contracts are checked against the integrated source. Browser sharing tests
  inspect actual PDF file bytes and assert no URL is shared.
- Publication requires the existing fresh-export performance/stability pre-push
  audit, then provider identity and authenticated deployment checks. Detailed run
  logs and receipts are kept under `output/2026-10-17-workflow-release/`.
- Read-only production preflight passed MongoDB connectivity, required indexes
  and R2 bucket access; migration dry-run found no pending migrations.

## Configuration and release limits

Railway variable inspection confirms no WhatsApp Business sender or document
template is configured. The file attachment flow is available; automatic Business
delivery requires provider credentials configured privately in Railway. No real
customer messages are sent by acceptance tests.

The unchanged dependency audit reports 22 high/five moderate findings. Protected
main review/security/performance gates are preserved. Branch publication and a
guarded production deployment do not imply a protected-main merge. Browser
emulation does not certify physical devices or signed native builds.
