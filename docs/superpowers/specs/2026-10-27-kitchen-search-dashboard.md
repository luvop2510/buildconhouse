# Kitchen customer search and dashboard

The user authorized implementation, GitHub publication, and Vercel/Railway updates.
Base: `2d009a33`, preserving the existing Kitchen, shared-flow and Ground Floor work.

## Capabilities and acceptance

1. Universal search uses the existing authorized project directory, without a stage
   restriction, and searches literal customer/contact/location and project identity.
   Results show customer identity and current stage; opening a result reaches the
   existing complete project record, history, documents and authorized editing.
   Search is debounced, paginated and cancels obsolete responses. Failures offer retry.
2. `/kitchen` is the central hub. All nine existing stages appear, including zero
   counts. Stage actions open the matching stage queue. Attention metrics use the
   same server definitions as their drilldowns. Counts respect the caller's access.
   Multiple projects for one customer remain distinct workflow records and are
   labelled honestly, rather than silently deduplicated into misleading stage totals.
3. Database reads remain bounded and floor/permission scoped. Dashboard aggregation
   must avoid transferring full project histories from MongoDB. Mutable customer
   reads must not reuse stale identity/permission cache entries. Index changes, if
   needed, are forward-only and idempotent; no business records are rewritten.
4. Preserve existing compact stage forms, explicit financial/approval actions,
   conflict/draft guards, phone scrolling, private documents and existing permissions.
   Reuse installed components and API transport. No new dependency or separate CRM.

## Verification and publication

Backend tests cover literal search, scope, aggregation/drilldown consistency and
timeouts. Browser tests use synthetic data through the real FastAPI/Mongo harness,
including phone and desktop. Type checking, lint, production export, current full
performance audit and required release/security checks retain their existing limits.
Verify actual provider source/runtime identities; a push or READY preview alone is
not production completion. Report any gate that prevents publication candidly.

Rollback reverts this focused change and republishes the previous accepted source.
No destructive data migration or customer-data export is authorized or necessary.
