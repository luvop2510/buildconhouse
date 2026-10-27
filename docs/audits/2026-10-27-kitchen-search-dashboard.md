# Kitchen customer search, dashboard and mobile drilldown

## Scope

Base: `2d009a33`, the Ground Floor refinement source confirmed in Railway's
running deployment metadata. Work is isolated in `codex/kitchen-search-dashboard-2026-10-27`.

The Kitchen landing page is a central hub with all nine stages, including zeros.
Tiles show distinct customers and project subtotals. One customer can have
multiple projects and can appear in several stages. Selecting a tile opens its
stage queue with the customer's identity, contact and stage-specific fields.
Selecting a customer opens expanded contact details and the existing stage editor,
with access to all stage records, documents and history. Existing permissions,
private files, explicit financial actions and draft guards remain in force.

Universal search is available from the hub, stage queues and project pages. It
crosses stage filters and searches current customer names/contact/company/site/
reference fields plus project identity and lead site location. Literal punctuation
is escaped. Results are paginated (20), debounced (250 ms), and keyed so an
obsolete response cannot appear under a new query. Stage queues remain 25 per page.

Canonical customer edits previously left the embedded Kitchen contact snapshot
stale. Current contacts now hydrate in one batch per list, and on detail/command
responses. Search uses current contact IDs; old email/name snapshots do not keep
matching after edits. Historical project/version records are not rewritten.

## Query, cache and migration behavior

Dashboard metrics use one Mongo facet aggregation, retaining the shared attention
definitions and exact decimal order values. It returns counts rather than project
histories. List count/page queries overlap, and update permission is resolved once
for the page rather than once per customer. Mongo work has a 5-second execution
bound; the whole service read has an 8-second bound and fails with an explicit
retryable 503. Cancellation retains its own semantics. These bounds prevent
indefinite waiting; no implementation can promise zero network outages/timeouts.

Mutable Kitchen reads deliberately use `cacheMs: 0` and `Cache-Control: no-store`.
Customer graph removals and contact edits need to appear immediately; an additional
response cache without complete invalidation would make those operations stale.
The dashboard revalidates on focus/refresh. Existing static asset caching and
session/floor transport guards remain. No new dependency or cloud service.

Migration 0039 adds `(floor_id, updated_at desc, id asc)` to support global page
ordering and registers it in bootstrap readiness. It is additive/idempotent and
accepts only equivalent existing indexes. Tests explain the query and reject an
in-memory SORT. No business record backfill or destructive migration.
Substring contact searches require narrowing if more than 1,000 customers match;
this explicit 413 prevents silently incomplete results or an unbounded ID payload.

## Mobile design contract

The primary question is "Which Kitchen stage holds this customer, and what is
happening there?" The product's signature is its ordered nine-stage flow. The
existing BuildCon logo, type and blue accent remain; stage data and touchable
queues provide the hierarchy. No charts, ornamental imagery, or new design system.

Applied the user-requested ui-ux-pro-max, frontend-ui-engineering, apple-design
and design-taste-frontend workflows. The app style draw offered framed-sheet and
accent-ladder; accent-ladder fits the existing brand and navigation. Palette/type
were retained. Source design lint: zero failures/warnings.
The rendered inspector passed at 1440/768/390px with `font-count` allowed:
it counts Inter's three existing weight files and the Feather icon font as four
typefaces, although the interface uses one text family. No other measurement was
waived. The initial redundant uppercase overline was removed. Screenshots were
reviewed at all three sizes; phone title/refresh share one compact row and stage
tiles remain large touch targets. Accent-ladder draw seed: `1143396310`.

Phone tiles use two columns where usable width permits; wider containers use
three. The compact attention list avoids a second grid of oversized summary cards.
Stage queues show labelled workflow fields and current contact information. A
disclosure chevron means deeper navigation. Expanded details, rather than duplicate
editable forms, provide the complete customer identity. Headers and rows share one
scroll owner, and controls remain reachable above reserved phone chrome.

Design references read: Apple `layout.md` (size changes/safe areas),
`search-fields.md` (broad scope/type-to-search), `lists-and-tables.md`
(readable rows/disclosure navigation), `accessibility.md`, `typography.md`,
`color.md`, `designing-for-ios.md`, and the React Native cross-platform guide.
These inform mobile web behavior; browser emulation cannot certify a physical
software keyboard, VoiceOver or a signed native app.

## Verification and release

Final full backend unit suite plus the four current Kitchen Mongo integration
files: 3,464 passed with six dependency deprecation warnings. This includes
customer freshness in detail, list and command responses, migration replay/index
compatibility, exact amounts, scope and dashboard drilldown agreement.
Initial feature browser acceptance passed 12/12 across Chromium desktop/Android
and WebKit iPhone/iPad, including real customer edit/save/reload/search. Mobile
review added 320px, portrait/landscape, larger text and every-stage details:
16/16 cases passed. The subsequent compact phone header/text refinement is part
of the full 296-case Kitchen run; its final result is recorded separately.

TypeScript, zero-warning lint, production export, API/navigation contracts,
Kitchen draft/financial/date checks have passed during implementation. Release
qualification requires the full current performance audit and final browser
results. Intermediate reports do not certify later source changes.

Production preflight found one always-running Singapore Railway replica and
successful public readiness. Existing npm audit still reports six high findings
through Expo/Sentry/node-forge/Zod; node-forge has no published patched version.
The required frontend-security check is retained. Protected main requires current
backend/frontend/security/performance checks and an independent approval. No
historical release waiver is reused or production promotion claimed here.

Rollback: revert this focused change and use the normal verified deployment
procedure; leave the additive global-page index in place. Before promotion, retain
the preceding Vercel alias and Railway deployment identities and verify actual
packaged source, migration readiness and authenticated journeys.

The first broad Kitchen browser run was stopped after exposing a return-navigation
gap. Its strict query-order assertion also assumed `returnTo` was the first query
parameter, before the new `details=1`. Return-path validation now accepts the
Kitchen dashboard and queue links preserve legacy query parameters for Back.
Tests verify the actual path/parameters, expanded details and exact list restoration;
external/unrelated return paths still use the safe fallback. That interrupted run
and failures after stopping its owned API are superseded, not passing evidence.
