# Follow-up, Kitchen and release-source repair — 27 October 2026

## Reproduced causes

The canonical live Vercel alias was deployment
`dpl_DHdjbnMrvBq2JLJTdNoYvoytPSdg`, source
`66ca3a3d84e16f4c1a5aee0a3c37835551cede81`. The project Git integration still
selected main, whose tip was `828f86b3` from 12 October. The current local release
history contains 144 later commits. A build of main could therefore omit recent
live fixes. Multiple older dirty worktrees compound the risk when their complete
trees are used as release inputs. This establishes source divergence; it does not
prove that every reported failure was a rollback or a database loss.

The new integration branch starts at `0128faf6`, which contains the exact live
runtime plus its release records. No old checkout was reset or overwritten.
Completed Ground, Sanitary and Kitchen branch tips are ancestors of this baseline.
Remaining divergent/incomplete work is preserved rather than blindly merged.

At a 320px viewport the follow-up bulk bar's Complete action extended to x405
while its card ended at x308. Wrapping fixes the 97px overflow. The taller dock
also covered 99px of the final card after scrolling; list padding now follows the
measured dock height. Shared menus constrain width, height and label shrinking,
including 220x280 CSS viewports. Opening actions did not reproduce simultaneous
customer-detail navigation, so event propagation was not changed speculatively.

The catalog-floor salesperson filter explicitly added Mine for owner accounts,
despite its assignee endpoint excluding owners. It now offers Mine only to staff
and normalizes saved views that could restore a hidden owner selection. This is
filter cleanup, not a change to underlying historical ownership or permissions.

Kitchen date controls were present in the live source. Native browser calendar
affordances varied, and WorkForm substituted today into rendered empty values,
preventing clear/edit and bypassing draft initialization. The shared date input
now has an explicit accessible opener; actual editable draft state initializes
India today. Historical/disabled dates and status-based submission remain intact.
List queues omit repeated stage navigation; hub totals and detail stages remain.
Phone titles get their own row and detail stage labels do not shrink/wrap.

Payments imposed 220ms before an empty initial/floor search. It now starts
immediately; typed searches retain debounce. The existing two-second list cache
now covers equivalent shared lists across concrete floors. Details, identity,
Kitchen workflow/dashboard data, writes and permission reads remain fresh.
Mutation, refresh, account and floor invalidation are preserved. These controlled
changes do not establish a universal production latency reduction.

## Prevention and test status

Both promotion tools require the current remote-main commit to include the live
frontend ancestry and recheck the canonical alias immediately before promotion.
Production Vercel builds reject non-main sources. Real temporary Git repositories
exercise valid, divergent, stale and unavailable history; provider adapter tests
exercise missing source and concurrent alias changes. Existing checks are retained.

A fresh npm ci with scoped Expo CLI Zod 4.6.7 and node-forge 1.4.1 overrides
reports zero vulnerabilities. The actual Expo schema consumers are exercised by
an additional compatibility test; no SDK upgrade or audit suppression is used.
The hermetic backend unit suite passed 3,421 tests with six dependency warnings.
TypeScript, focused contract/layout/date/autosave/client and promotion tests pass.
Production export succeeds. Final broad/browser/CI/merge/deployment outcomes must
be appended after they complete; no publication or green full-suite claim is
implied by this initial ledger.

Initial browser attempts were invalidated when dependency installation or an
export rebuild replaced files under running workers. Those attempts are retained
in local logs and do not count as acceptance. Final runners use immutable export
copies. Physical Android/iPhone keyboard and OS date-picker UI remain outside
desktop browser emulation.

## Verification update

The isolated actual-API/disposable-Mongo Chromium date/header run passed six
cases across desktop and Android: automatic defaults before interaction for
every Kitchen date entry point, editable choices, reload persistence, both work
dates and nine detail stage headers. Nine final Chromium phone cases passed
for menus/dock geometry, salesperson choices, summaries and quotation gutters.
Two payment-filter cases passed on desktop/phone. TypeScript and changed-runtime
zero-warning lint passed. The broad desktop exploration had 416 passes, 15 failures
and nine existing intentional skips; it is not full acceptance. Subsequent focused
corrections cover retired selectors, compact gutters, cache reuse and the locked
transfer sheet, preserving their business assertions. A loaded multi-run Kitchen
matrix included timeouts and invalidated early assertions; no full matrix pass is
claimed. Physical OS keyboard/calendar behavior remains unverified.

The first complete performance attempt was interrupted after 447 passes because
known failing stale assertions had been corrected during its run. Its reports
remain local and are not used as release evidence. The final mandatory push hook
will rebuild and rerun current-source checks. Main's enforced independent human
approval and required GitHub checks remain unchanged.

Promotion no longer hard-codes an old browser-case count: it validates the actual
current route/scenario registry directly, including new follow-up overflow tests.
This prevents a newly added route or a renamed regression from silently invalidating
the release contract. The current runner discovers 848 cases; no number alone
is accepted as evidence that the required cases passed.
