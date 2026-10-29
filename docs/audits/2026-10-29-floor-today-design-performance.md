# Floor Today, interface consistency and economical checks — 29 October 2026

## Findings and resulting behavior

Today had been made a host for the complete company sales dashboard. It loaded
analytics, owner operations (twice in the measured browser start), and separate
follow-up, quotation, payment and purchase reads. This combined the wrong job,
wrong information hierarchy and unnecessary work. Saved/custom Sales Data grants
and legacy manager access also contradicted the latest owner-only requirement.
Payments deliberately unioned Ground into Sanitary and history could aggregate
assigned floors; that was an operational scope error under the new instruction.

Today now answers what needs attention on the selected floor. Its primary read
contains safe task identities, departments, dates, recorded status/progress and
complete server counts with a bounded 24-task preview. Sources include follow-ups,
walk-ins/selections, quotations, purchase/dispatch work, actual reorder shortages,
unpaid confirmed orders, stock returns due and Kitchen projects. Missing dates
and progress remain missing. The UI previews 16 tasks and links each permitted
department to its complete queue; supported customer/project/document tasks open
their source. Counts describe the full work queue, independently of the preview.

Departmental accounts receive their granted task lists/progress, with no financial
summary or whole-floor aggregates. Full-floor access means an unrestricted legacy
admin/manager, owner, or current view grants covering every applicable department;
a restricted profile cannot be broadened by grants. Full-floor viewers receive a
separate, independently authorized overview of that floor's workflows and today's
INR receipts. Detailed balances/history remain in the floor's Payments workspace.
Furniture RNB is never represented as INR receipts or combined into an INR ledger.
Every read revalidates scope; previous-floor responses cannot publish on a new one.

Sales Data and its API/export paths are owner-only, even with stale grants or a
saved permission-matrix override. Bookmarked pages redirect non-owners before
analysis reads. Historical grants remain revocable; no business records, documents,
transactions, floor assignments or histories are rewritten. No migration is needed.
Payments list/statistics/history now retain the selected floor; a different-floor
history filter is rejected. Missing operational floor selection fails explicitly.

## Design and prevention

The system font, Feather icons, shared color/type/spacing tokens and existing
controls remain the visual authority. Today uses one divided task-count group and
a large work panel beside a smaller floor overview at useful desktop widths;
phones stack in task order. Neutral sidebar selection and consistent navigation
icons replace the extra selected-edge ornament. Owner analytics uses a grouped
KPI surface and omits a single floor's self-contribution ring/comparison bars.
Exact values, zero baselines, recorded currencies, keyboard chart controls and
accessible data alternatives remain.

The saved Salesly Framer reference informed grouping and alignment. Its old blue
and font choices do not replace the user's current system-font/graphite contract.
Conflicting legacy Kitchen/blue-focus instructions are reconciled. No third-party
font, decorative chart dependency or template runtime was added.

The [interface acceptance checklist](../design/interface-acceptance.md) contains
49 checks, a role/floor viewpoint matrix, every page family, compact/regular bento
wireframes, chart truthfulness, loading/error/retry, accessibility, source scope,
contrast figures and verification requirements. The [design review](../design/review-2026-10-29.md)
identifies evidence and limits. The canonical design README and AGENTS.md preserve
the corrected contract for future page additions.

`npm run check:affected:plan` explains affected development checks;
`npm run check:affected` runs them with compact logs and input-bound success reuse.
The selector follows transitive source references, includes untracked/deleted and
staged/unstaged changes, and falls back conservatively for shared or unknown work.
Failed, obsolete and Python suite results are never reused. An unchanged module
is not repeatedly checked during a narrow edit. Example: a KitchenAutosave-only
change selects seven contracts plus TypeScript rather than all 77 registered
entry points; prose-only edits select none. The baseline-dependent visual drift
comparison stays separately invocable and requires its approved external baseline.
The unchanged full performance/stability gate still runs once on final release
source. Details: [affected checks](../affected-checks.md).

## Verification and performance evidence

- Backend: 3702 unit/HTTP cases passed, then 60 affected cases passed after the
  final missing-floor guard. Real disposable Mongo integration validates actual
  aggregation syntax, India day boundaries, exact complete counts, grant/floor
  isolation, safe task fields, actual unpaid-order accounting and source links.
- Static development batch: 75 executable checks including TypeScript passed.
  The Indian-money VM fixture was repaired to load the actual shared font helper;
  monetary assertions remain unchanged. Selector self-tests cover cache safety.
- Focused exported-browser acceptance: 60 cases passed at 320/390/768/1024/1440,
  with no retries/skips: owner/manager/department viewpoints, direct-link denial,
  immediate completion and rollback, optional totals held pending, terminal first
  error and refresh recovery. An earlier 58-case interaction batch passed with two
  desktop-inapplicable mobile-only cases skipped. Optimistic hook tests: 12 pass,
  including stale responses, double taps, account/floor changes and later reopen.
- Owner analytics: 95 exported-browser cases passed at 320/375/768/1024/1440,
  including monetary wrapping, source navigation, exports and chart keyboard/data controls.
- Production export, TypeScript and focused ESLint pass. Bundle budget checks all
  203 emitted HTML pages; largest initial graph is 484KB gzip within the existing
  576KB ceiling. This is a ceiling, not a universal device-speed claim.
- Hosted baseline used a short-lived run-owned session and blocked business
  writes. Three fresh 390px Chrome contexts issued 12 API requests each on old
  Today; useful analytics appeared in 5074/2436/2905ms. These observations describe
  that network/runtime sample, not a general percentile. The old all-floor sales
  dashboard response was 22,291 bytes and 611–720ms in three API samples.

Final full-gate, analytics-browser and production publication evidence is recorded
in the release handoff after the exact source is published. A successful local
export, push, provider build and actual production publication are separate facts.
Physical-device keyboards, an unimplemented dark theme and every future network
condition are not certified. The checklist and regression gates prevent known
recurrences; no finite check can promise that no future bug will exist.
