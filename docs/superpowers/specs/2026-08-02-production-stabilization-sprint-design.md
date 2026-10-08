# Production Stabilization Sprint — Design

**Date:** 2026-08-02
**Status:** Approved (with owner adjustments, 2026-08-02)
**Supersedes:** nothing. Complements `RELEASE_REPORT_2026-08-02.md`.
**Explicitly frozen and out of scope:** Sales Data / Executive OS
(`2026-08-01-executive-operating-system-design.md`). No file under
`backend/services/analytics/`, `backend/routes/sales_data_routes.py`, or
`frontend/app/(admin)/sales-data/` is touched by this sprint.

---

## 1. Mission

Transform BuildCon House into a production-ready application suitable for real
customers and App Store / Play Store submission.

This is a **stabilization** sprint. Every change must reduce launch risk. No
feature work except where an operational gap makes an existing workflow
unusable (Phase 2's tile lifecycle rules are the single sanctioned exception,
approved by the owner because Ground Floor's post-sale workflow is otherwise
manual).

**Not in this sprint:** new modules, redesigns, Sales Data, Executive OS.

---

## 2. Business structure

BuildCon House runs two businesses that must behave as independent companies.

| | **Ground Floor** | **Sanitary Bathroom** |
|---|---|---|
| Business | Tiles | Bathroom Ware |
| `floor_id` | `ground-floor` | `first-floor` |
| Modules | Walk-ins, Customers, Tile Selections, Tile Quotations, Tile Orders, Follow-ups, Payments, Sales Data | Walk-ins, Customers, Quotations, Purchases, Follow-ups, Payments, Sales Data |
| Absent | Purchases, Sanitary Quotations | Tile Orders, Tile Quotations, Tile Selections |

Nothing leaks. Nothing mixes.

Note the `floor_id` values are historical and do not match the display names:
Sanitary Bathroom is `first-floor`. Renaming is a data migration with no
launch-risk benefit and is **not** in scope. Code refers to them through
`SANITARY_FLOOR_ID` / `TILES_FLOOR_ID` constants, never string literals.

---

## 3. Platform rule — Business-Unit Ownership

> **Every workflow artifact in BuildCon House belongs to exactly one business
> unit, unless it is explicitly declared shared. A shared artifact still
> remains scoped to the business unit it originated in.**

This is an architectural invariant, not a per-module fix. It governs
Follow-ups, Notifications, Activity feed, Purchases, Tile Orders, Dispatch,
Inventory, and Payments. It will govern Reports and Sales Data when those
unfreeze.

### 3.1 Mechanics

1. **Storage.** Every collection carrying workflow data has a `floor_id`.
   Models must not declare a constant default that silently files a record
   under the wrong business (`TileCustomerOrder`, `TileReadyBatch`, and
   `TileDispatch` currently default to `"first-floor"` — wrong, fixed in
   Phase 1).
2. **Write.** Floor is derived from the source document via `floor_inherit()`,
   never from a constant and never from ambient request state alone.
3. **Read.** Every query scopes through `floor_query()` /
   `tiles_floor_query()`.
4. **Declaration.** Every rule, producer, or generator that creates workflow
   artifacts declares which business units it may produce for.
5. **Enforcement.** The persist path rejects any artifact whose derived
   `floor_id` falls outside its producer's declaration. A misdeclared producer
   fails loudly rather than leaking silently.
6. **Coverage.** A test asserts every producer has a declaration. Adding a new
   producer without declaring its unit fails the suite.

Points 4–6 are what make this structural rather than a patch: a future
developer cannot add a cross-unit workflow by accident.

### 3.2 Unit-specific vs shared

**Unit-specific** — belongs to one business, must never execute for the other:
tile selections, tile quotations, tile releases, tile dispatch, purchase
lifecycle, supplier workflow.

**Shared** — executes for every business that supports it, each row scoped to
its originating unit: payment overdue, partial payment, walk-ins, customer
inactivity.

"Customer communication" and "reminder notifications" are not follow-up rules —
they are the notification and activity surfaces. They are governed by the same
platform rule (§3.1) and audited in Phase 1, but they do not appear in the
follow-up registry.

**Not implemented anywhere:** an installation / service workflow. It appears in
no model, route, or screen in this codebase. It is named here only to record
that it was considered and is out of scope; it is not a gap this sprint closes.

Payment collection is a business function, not a product category. Ground Floor
and Sanitary both generate payment follow-ups; the source document decides
which unit owns each one.

---

## 4. Phases

| # | Phase | Ships |
|---|---|---|
| 0 | Trustworthy baseline | Verified + committed working tree |
| 1 | Floor isolation, re-audited | Platform rule enforced across all modules |
| 2 | Follow-up rule ownership | Registry + 13 rules assigned + 4 tile lifecycle rules |
| 3 | Purchases → Sanitary only | Ground Floor purchase entry points removed |
| 4 | Launch-ready permission layer | Per-employee CRUD permissions, API-enforced |
| 5 | Production hardening | Crash/state/offline/a11y/responsive audit |
| 6 | Release Candidate Audit | Classified defect list + GO/NO-GO |

Deferred to their own specs, by owner decision: **full RBAC** (custom
templates, fine-grained action permissions, inheritance, advanced editor) and
the **design-system rollout** across all 51 screens.

**This spec is too large for a single implementation plan.** Each phase gets
its own plan, written just-in-time against the state the previous phase
actually left behind — not all seven up front, which would encode assumptions
that Phase 0's re-audit is specifically designed to invalidate. Phases run in
order; Phase 6 cannot start until 0–5 close.

---

### Phase 0 — Trustworthy baseline

26 files sit uncommitted from the previous session (floor isolation, migration
`0014`, 5 test files, `RELEASE_REPORT_2026-08-02.md`). The brief says not to
trust previous fixes.

- Re-verify each claim in `RELEASE_REPORT_2026-08-02.md` against live Mongo and
  the running app, not against the report's own assertions.
- Fix what fails.
- Run the full backend suite and `tsc --noEmit`.
- Commit as a clean baseline.

**Exit:** working tree clean, suite green, every claim in the report either
re-verified or corrected.

---

### Phase 1 — Floor isolation, re-audited from first principles

Do not trust prior isolation work, including Phase 0's. Re-derive.

- Enumerate every collection with a `floor_id`; every read path; every write
  path; every id-addressed mutation (the class of bug where an object is
  fetched by id without a floor predicate, allowing cross-unit writes).
- Audit navigation, queries, services, caching, mutations, timelines,
  notifications, downloads, search, follow-ups, activity, history, permissions.
- Remove the `"first-floor"` defaults from the three tile models.
- Resolve the known `floor_query()` / `floor_for_write()` asymmetry: an
  all-floors caller with no active floor reads unrestricted but writes to a
  single floor. Unreachable from the product today, reachable by direct API
  call. This is its own reviewed change because its blast radius is every
  module.

**Verification:** extend `scratchpad/probe_isolation.py` to cover write paths
as well as reads. For each endpoint, mint a real session and exercise it three
ways — no `X-Floor-Id`, Sanitary, Ground — asserting the `floor_id` set of
everything returned or written. This catches ambient-state leaks that clicking
through the UI hides.

**Exit:** no endpoint returns or writes data outside the requested unit under
any of the three header conditions.

---

### Phase 2 — Follow-up rule ownership

#### 2.1 Why the obvious implementation does not work

`reconcile_followups()` is a single global reconciler that rebuilds every
follow-up for every unit on each invocation, fired fire-and-forget from 15
mutation routes. There is no "active business unit" at reconcile time — it runs
as a background task with no request context.

So "only evaluate rules for the active business unit" cannot be implemented
literally. The equivalent that holds: **each rule declares its owning units,
and the persist path rejects any row whose derived `floor_id` falls outside
that declaration.**

#### 2.2 Registry

New `backend/services/followup_rules.py`:

```python
@dataclass(frozen=True)
class RuleSpec:
    rule_type: str
    units: frozenset[str]              # units allowed to own rows from this rule
    kind: Literal["unit", "shared"]
```

Four enforcement layers:

1. **Registry** — one entry per `rule_type`, single source of truth.
2. **Producer gate** — each producer receives only its units' source documents.
3. **Persist assertion** — `_persist_desired_followups()` raises on any row
   whose `floor_id` ∉ its rule's `units`, and on any unknown `rule_type`.
4. **Coverage test** — an AST check that every `rule_type` literal emitted
   anywhere in the engine has a registry entry, mirroring the existing
   `test_quotation_ordered_at.py` guard.

#### 2.3 Assignment of the 13 existing rules

| Kind | Rule | Units | Change needed |
|---|---|---|---|
| unit | `selection_waiting` | Ground | none — already doc_type-gated |
| unit | `quotation_tiles_waiting` | Ground | none — already doc_type-gated |
| unit | `quotation_followup` | Sanitary | none — only rule with a tiles exclusion |
| unit | `quotation_expiring` | Sanitary | **add tiles exclusion** |
| unit | `quotation_expired` | Sanitary | **add tiles exclusion** |
| unit | `purchase_dispatched` | Sanitary | declare |
| unit | `purchase_delivered` | Sanitary | declare |
| unit | `shortage_reorder` | Sanitary | declare |
| unit | `order_confirmed_ops` | Ground | **restrict to Ground** |
| shared | `payment_overdue` | both | declare shared |
| shared | `payment_partial` | both | declare shared |
| shared | `walk_in_new` | both | **fix null `floor_id`** |
| shared | `customer_inactive` | both | **re-key per unit** |

Four rules — `quotation_expiring`, `quotation_expired`, `payment_overdue`,
`payment_partial` — live in the same `for q in quotations` loop as
`quotation_followup` but lack its tiles exclusion. The two quotation rules
become Sanitary-only. The two payment rules stay shared, per the platform rule.

`order_confirmed_ops` keys on `boxes_ready`, a field only tile POs populate. On
Sanitary it fires for every ordered quotation and never auto-resolves. It
becomes Ground-only. If Sanitary later needs an operational-confirmation rule,
it gets its own, rather than sharing this one.

**`customer_inactive` is a genuine cross-unit defect.** Its dedupe key is
`customer_inactive:{customer_id}` — one card per customer — and it selects
`max(updated_at)` across all of that customer's quotations regardless of unit.
For any customer buying from both businesses, one unit's activity suppresses
the other unit's card, and the card's `floor_id` flips between businesses as
data changes. It survived every prior isolation pass because the row is always
*stamped* with a valid floor. Re-key to
`customer_inactive:{customer_id}:{floor_id}`, computed from that unit's
quotations only. A migration retires the old single-key rows.

`walk_in_new` reads `w.get("floor_id")`, which is `None` for any unstamped
walk-in, producing a null-floor card invisible to every unit. Backfill and
require the field.

#### 2.4 Four new Ground Floor lifecycle rules

Ground Floor's workflow runs enquiry → fulfilment: Walk-in → Selection →
Quotation → Approval → Tile Order → Material Release → Dispatch → Delivery →
Outstanding Payment → Completion. Rules exist for the first three and the
payment stage. The middle is manual.

Keyed on real fields in `models_tile_orders.py`
(`Pending → Ready → Partially Dispatched → Dispatched → Delivered`):

| Stage | Rule | Fires on |
|---|---|---|
| Approval | `tiles_approved_not_ordered` | tiles_quotation approved, no `TileCustomerOrder`, aging |
| Material Release | `tile_release_pending` | order `Pending`, `boxes_ready == 0`, aging |
| Dispatch | `tile_ready_not_dispatched` | `TileReadyBatch.remaining_qty > 0`, aging |
| Delivery | `tile_dispatch_undelivered` | `TileDispatch` with null `delivered_at`, aging |

All four are `units={GROUND}`. Completion needs no rule — `overall_status ==
"Delivered"` auto-resolves the chain through the existing reconciler.

**Thresholds are not hardcoded.** All four read offsets from the existing
`services/automation_rules.get_offsets()` mechanism, so operations can tune
them in Settings without a deployment — the same path `selection` and
`quotation_tiles` already use.

**Exit:** no cross-unit follow-up is producible; every rule declares its units;
a Ground Floor order runs quotation → completion with no manual reminder gap;
backend tests and live verification prove the separation.

---

### Phase 3 — Purchases → Sanitary only

Purchases is **retained for Sanitary** — it is in Sanitary's module list. It is
removed from Ground Floor, where Tile Orders replaces it.

- Add `floors: [SANITARY_FLOOR_ID]` to the nav definitions at
  `frontend/app/(admin)/_layout.tsx:43` (PRIMARY), `:371` (MORE_ITEMS), and any
  other entry point.
- Gate the route itself with `useRequireFloorAccess(SANITARY_FLOOR_ID)` so a
  direct URL, bookmark, or deep link cannot reach it from Ground Floor.
- Sweep for and remove dead purchase entry points, routes, permissions, menu
  items, and API calls left behind by the Tile Orders migration.

**Exit:** no purchase entry point is reachable from Ground Floor by navigation,
URL, or API; Sanitary's Purchases module is unaffected.

---

### Phase 4 — Launch-ready permission layer

The current model is 8 flat roles with a numeric hierarchy, enforced at 148
route guards that collapse into 10 distinct shapes. It cannot express "this
employee may view customers but not delete them."

**In scope (launch):** module visibility, page permissions, CRUD permissions,
floor access, hidden unauthorized navigation, API enforcement.

**Out of scope (post-launch):** custom permission templates, fine-grained
action permissions, inheritance, advanced permission editor.

#### 4.1 Model

A flat permission vocabulary, `module.action`:

```
customers.view|create|edit|delete
quotations.view|create|edit|approve
tile_orders.view|create|release|dispatch
purchases.view|create|receive
payments.view|edit
catalog.view|import
followups.view|complete
walkins.view|create
exports.pdf
team.manage
settings.manage
```

Storage: `Staff.permissions: list[str] | None`. `None` means "derive from the
role template" — so existing staff need no data change. Role templates are a
`ROLE_PERMISSIONS` mapping over the 8 existing roles.

Floor access continues to work as today (`Staff.floor_ids`), unchanged. A
permission grants an action; floor access decides which business's data that
action reaches. The two are orthogonal and both are enforced.

#### 4.2 Migration safety — the point that makes this a stabilization change

Rewriting 148 guards is the largest risk in this sprint. It is made safe by
deriving the initial mapping *from the existing guards* rather than from
judgement:

1. Mechanically extract what each of the 8 roles can currently reach, per route.
2. Generate `ROLE_PERMISSIONS` so that mapping is reproduced exactly.
3. Replace `require_min_role(...)` / `require_roles(...)` with
   `require_permission("module.action")`.
4. **Assert equivalence:** a generated test walks all 8 roles × 148 routes and
   asserts `old_guard_allows == new_guard_allows`.

Day-one behavior is provably identical. Per-employee overrides then layer on
top of a known-good baseline. Any intentional permission change is a separate,
reviewed diff against a green equivalence test — never entangled with the
migration.

**Conflict with the Sales Data freeze.** 15 of the 148 guards are
`require_roles(*_ANALYTICS_ROLES)` in `routes/sales_data_routes.py`, which is
frozen. Rewriting them would touch frozen code; leaving them creates two
permission mechanisms in one codebase.

Resolution: **the analytics guards are left untouched.** The freeze outranks
consistency, and a permission model is not a place to take liberties with a
module nobody is allowed to re-verify. `require_permission` and
`require_roles` coexist; the equivalence test covers the 133 migrated routes
and asserts the 15 analytics routes are unchanged. Unifying them is the first
task of the post-launch RBAC spec, once Sales Data unfreezes.

#### 4.3 Frontend

`useModuleAccess` extends to a `usePermission("module.action")` hook. Nav items
and action buttons the user lacks permission for are hidden, not merely
disabled. Team management gains a per-employee permission editor: checkboxes
grouped by module, defaulting to the role template.

**API enforcement is the boundary.** Hidden UI is a usability affordance, never
the security control. Every permission is enforced server-side regardless of
what the client renders.

**Exit:** every route permission-guarded; equivalence test green; unauthorized
navigation hidden; permission matrix verified across all 5 roles × 2 units.

---

### Phase 5 — Production hardening

Apps feel unfinished for reasons unrelated to business logic. This phase is a
dedicated audit-and-fix pass over exactly those reasons:

crash audit · loading states · offline handling · retry behaviour · API timeout
handling · permission-denied handling · empty states · image loading · PDF
generation · upload recovery · session expiration · memory usage · tablet
layouts · accessibility · font scaling · dark mode consistency

Plus the general production sweep: authentication, authorization, uploads,
downloads, printing, navigation, error handling, dead code, unused routes,
duplicate components, duplicate services, slow queries.

**Boundary:** this phase fixes states that are broken, missing, or inconsistent.
It does **not** introduce a new design language — that is the deferred
design-system spec. If a screen has no empty state, it gets one. If a screen's
empty state is merely ugly, it is logged, not redesigned.

Known input: the app-wide accessibility finding that nav items, tab-bar
destinations, and list rows render as unlabeled `generic` roles with no
accessible name — VoiceOver/TalkBack announce them as anonymous tappable
regions. Highest-leverage a11y fix available.

**Exit:** no crash path, no dead navigation, no unhandled error state, no
unlabeled interactive element on primary flows.

---

### Phase 6 — Production Release Candidate Audit

**No feature work is permitted in this phase.** Nothing new is built.

Only: bug fixes, consistency improvements, performance profiling, security
review, regression testing, production data verification, store compliance
checklist, release sign-off.

Every issue discovered is classified:

- **Must Fix** — blocks release.
- **Should Fix** — ships as a known limitation, scheduled.
- **Can Ship** — logged, no action.

Store-review criteria specifically: crashes, broken links, incomplete flows,
placeholder content, missing privacy/support links, authentication flows,
permissions, polished UI, stability. **Store assets are not generated** — only
the application itself is made ready for review.

Known open items entering this phase, from prior sessions:
- `owner@forge.app` is back on the git-tracked demo password `[legacy password removed; use injected test credentials]`;
  `/api/health` reports `degraded`. **Hard release blocker.**
- The live database contains test fixtures (`Task18`/`Task19`/`TEST_LC4_*`
  orders, 118 synthetic activity events, a `ZZTEST TILES E2E` follow-up ranked
  #1 on the Ground Floor dashboard). No delete endpoints exist for these
  collections.
- No hosted privacy policy or terms URL; `eas.json` `submit.production` empty;
  build pipeline (Emergent vs EAS) still unreconciled; `PrivacyInfo.xcprivacy`
  missing; splash image is a poster in a logo-mark slot.
- Neither an Apple Developer Program nor a Google Play Console account exists.
  Longest lead-time item; owner action required.

**Exit:** every Must Fix resolved, every Should Fix scheduled, release report
recommends GO.

---

## 5. Verification standard

Compilation is not verification. A task is complete only after end-to-end
verification against the real application.

Every reported fix carries: backend verification · frontend verification ·
browser verification · database verification · regression verification.

### 5.1 The matrix

Full coverage is 3 viewports × 5 roles × 2 business units = 30 combinations.
Driving that by hand is slow and unrepeatable, so it splits by what each method
is actually good at:

- **Roles × units (10 combinations) — scripted.** A permission-matrix test
  mints a real session per role, exercises every guarded endpoint under both
  units, and asserts allow/deny plus the `floor_id` of everything returned.
  Exhaustive, runs in CI, catches every future regression.
- **Viewports (phone / tablet / desktop RN-Web) — browser.** Layout, overflow,
  tap targets, and reachability need a human eye and a real renderer. Run
  against the highest-risk screens per phase, not all 51 every time.

Roles covered: Owner, Manager, Sales, Warehouse, Worker. Units: Ground Floor,
Sanitary Bathroom.

**Dependency:** live credentials for manager / sales / warehouse / worker
accounts are required and not currently available to the implementer. Owner
must supply them, or authorize creating `ZZTEST`-prefixed staff accounts for
the pass.

### 5.2 Live data policy

Authorized: restart dev servers, read any collection in live `buildcon_house`,
browser login and full end-to-end testing, automated and regression tests.

Temporary data only when live data cannot exercise a path. When created: prefix
every record `ZZTEST`, keep the set minimal, clean up before the phase ends,
never leave test records in production. Check for sufficient existing live data
first.

### 5.3 Per-phase release report

Each phase ends with: what changed · how it was verified · remaining risks ·
known limitations · production readiness verdict.

---

## 6. Environment notes

Facts that have cost prior sessions real time:

- **Backend on `:8010` does not auto-reload** (no `--reload`). Backend edits
  have zero effect until the process is restarted (~30s to boot; watch for
  "Catalog read model ready" / "Forge API ready"). It is sometimes shared with
  the owner's Emergent agent — confirm before restarting.
- **Metro can silently serve a stale bundle.** Verify by fetching the entry
  bundle and grepping for a string unique to a just-made edit. When a
  previously-working module is reported "reverted," check dev-server staleness
  (backend uptime vs. latest commit, whether Metro is running at all, `dist`
  mtime) *before* investigating code.
- **RN-Web `Pressable` ignores synthetic clicks** from the browser tool.
  Dispatch `pointerdown/mousedown/pointerup/mouseup/click` via JS on the
  element, walking 3–4 ancestors.
- **Screenshot scaling is unreliable** above the Browser pane's ~506px native
  viewport; DOM measurements stay correct. Assert layout via
  `getBoundingClientRect()`, not screenshots.
- **No `pytest-asyncio`** in this repo — `@pytest.mark.asyncio` silently skips.
  Async tests use `asyncio.run` inside sync test functions.
- **Migrations run at every startup** and must be idempotent, including index
  names — a same-key index under a different name raises MongoDB error 85 and
  hard-crashes the runner.

---

## 7. Stop condition

The sprint is complete only when:

- Floor isolation is verified from first principles, not assumed.
- Follow-ups are unit-owned and structurally cannot cross units.
- Purchases is unreachable from Ground Floor.
- The launch permission layer is enforced server-side and proven equivalent-
  or-stricter than today's roles.
- No production blockers remain.
- The app behaves correctly on phone, tablet, and desktop.
- Regression, browser, and Mongo verification all pass.
- The Release Candidate Audit's Must Fix list is empty.
- The release report recommends **GO**.
