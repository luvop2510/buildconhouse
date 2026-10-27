# Kitchen and keyboard reliability — 27 October 2026

## Scope and source

The current worktree is based on `4152caef44d8e35d6256fbe54015e79e1a828b9c`,
the live Kitchen release. The earlier isolated performance branch began at
`2d009a33`; production changed during its investigation. Its focused patches
were copied onto the newer source without merging branches or including another
editor's work. This supersedes the release-source section in the earlier shared
performance audit. No production publication from this branch is claimed.

The user's subsequent instructions explicitly change the prior compact-layout
contract: keep the phone web view intact during typing; remove the Kitchen
Details fields and filters/attention summaries, keep nine stages and adjacent
stage controls, keep Actions at the top, and remove Original terms and documents
from Order. These instructions supersede older hidden-header and full-contact
Details assertions. Names/phones, saved history, document access from Actions,
permissions, monetary calculations, approval commands and database records remain.

## Keyboard cause and repair

A read-only live browser observation on Chromium Android and WebKit iPhone
profiles measured a hidden 56px header and a hidden 63px navigation band after
focusing a field (119px wasted). Hiding controls with opacity/visibility retained
their flex geometry inside an already reduced visual viewport.

The web header now stays visible. Hidden bottom navigation remains mounted but
sits outside the flex layout, giving the form its space back. The existing
pointer-settlement guard still delays restoration until a blur-triggering press
finishes. Fields and drafts are never remounted. The shared viewport hook scrolls
only overflowing form containers by the clipped distance, respects nested
clipping, and never calls document/root scrollIntoView. Visible typing and tall
fields do not alternate between viewport edges. Pinch zoom retains browser pan.
Native installed-app layout is unchanged; the user identified mobile web.

Six focused browser regressions passed on Android Chromium and iPhone WebKit:
lower customer address/save, nested staff sheet and growing/capped Kitchen notes.
They assert retained DOM/focus/drafts, intersection with actual scrollports and
the visual viewport, no document pan, keyboard dismissal and exactly one save.
Four no-gap cases plus customer/modal/search viewport cases are in the full
four-profile stability gate. Synthetic geometry does not open an OS keyboard;
physical iPhone/Android acceptance remains unverified.

## Kitchen connection evidence and repair

The reported failure was opening Quotation or using Next from Quotation, Order
or Production, approximately twenty minutes before the user's 09:00 IST message.
The bounded Vercel 03:00–03:20 UTC retrieval returned 50 Kitchen responses, all
200, including eight stage commands. The corresponding bounded Railway sample
also returned successful stage commands (maximum 595ms) and no Kitchen 5xx. These
are sampled observations, not proof that the user's connection succeeded.

Thirty-two live reads through Vercel/direct Railway returned 200. Through Vercel,
five-sample median configuration/dashboard/list times were 221/285/436ms;
one detail sample was 622ms. Direct configuration transit varied up to 3,810ms
while server work was 69ms, separating transit from application execution.
No 20-second timeout was reproduced in this read workload.

A controlled real-ASGI regression does reproduce a concrete stage failure:
the service commits move_stage, then awaits authoritative customer hydration for
the response. A database stall can therefore leave a committed Next action looking
failed. Response reads now finish under the existing eight-second read budget
before the optimistic-concurrency replace commits. Three regressions cover
Quotation→Order, Order→Production and Production→Installation: a stalled read
returns 503 with unchanged stage/version/receipts and released admission; explicit
retry/replay produces exactly one version/receipt and current customer identity.
The exact-token admission release and financial/approval semantics are unchanged.
An admission-release or transport outage can still fail; no universal zero-outage
claim is made.

The actual native/web clients now recover one TypeError transport failure for a
Kitchen GET after a 150ms pause within the original 30-second deadline. HTTP
errors, timeouts, canceled requests and writes are not automatically retried.
Tests cover persistent failure, cancellation during backoff and unchanged deadline.
Six browser scenarios passed for Quotation/Order/Production on both engines:
a deliberately dropped read recovers; a lost committed Next response requires
explicit retry with the identical receipt/body and does not advance twice.

The shared auth coalescing/activity deadline/canceled-GET fixes are retained from
the measured performance work. Five-sample synthetic auth median is
82.72→41.52ms, reads 24→2 and last-seen writes 12→1. Eight abandoned search
transports now all abort after their last consumer leaves, preserving others.

## Database and deployment path

The running service's read-only Mongo hello reports AWS AP_SOUTH_1 (Mumbai).
Vercel functions are bom1; Railway is one always-running Singapore replica,
backend root /backend, one uvicorn worker and a shared Motor pool. Mongo is not
connected per request. Current read-only executionStats for Kitchen list/stage
shapes show IXSCAN, zero examined documents with ID projection, 0–5 examined keys
and 0–4ms server execution on the current small dataset. There is no blocking
SORT or evidence to justify a new index, pool increase or hosting-region change.
No database/index/configuration change or production business mutation was made.

Rollback baseline: Vercel `dpl_4LJjcrZ79S3XWtoDi6EdLkqBUbT2`, Railway
`fcd498b6-7b0f-448e-8ece-44a0b674ca91`, source `4152caef`. Refresh provider
identity immediately before any deployment because other releases are active.
The earlier source's protected-main/security requirements remain in force.
Current dependency auditing reports six high findings; no old release exception
is reused, checks are not disabled, and production promotion requires the existing
complete reviewed package. A READY preview is not proof of release.

## Validation ledger

The final hermetic backend suite passed 3,421 tests with six existing dependency
deprecation warnings. Targeted Kitchen HTTP/service tests passed 70 cases. Actual
client contracts, simplified Kitchen UI, commercial/version/date tests,
TypeScript and changed-source zero-warning lint passed. The production web export
passed; all exported route bundles remain below the 576KiB ceiling.

The initial Kitchen persistence/browser run passed 29/32. Two obsolete immediate
header-restoration assertions needed to wait for actual navigation restoration;
the corrected blur scenario passed both engines. Concurrent harnesses also shared
a trace output path, deleting one run's trace files; the final harness uses unique
report/trace directories. Failed/interrupted runs remain recorded and do not count
as acceptance. Complete final Kitchen and every-route/timing results are appended
only after their live handles finish.


## Follow-up: field focus shape

The global focus-visible outline was applied to the inner rectangular input,
ignoring the rounded composite field boundary. Shared TextField/SearchField,
KitchenTextField and design Input now identify their web outer shell. The shell
paints its focus shadow using its own border radius; the inner duplicate outline
is removed. Raw inputs retain their own shape's focus shadow, other controls keep
their existing focus outlines, and forced-colors mode retains an explicit outline.
Eight Chromium/WebKit cases passed for text, multiline, search and Kitchen inputs,
including computed outer radius/ring, no inner outline, retained focus/value and
high-contrast fallback. Screenshots were inspected. No native styling changed.

Final focused Kitchen persistence acceptance passed 32/32 cases with zero skips,
retries or flakes using the actual FastAPI router and disposable loopback Mongo.
The initial trace-output conflict was a harness error, resolved with independent
output directories; the two blur cases now wait for actual navigation restoration
rather than the header, which intentionally remains visible throughout editing.
The six dropped-read/lost-response browser cases and six long-field/modal/keyboard
cases also passed. The complete final audit is recorded separately once finished.

## Final stage-response reconciliation

For an uncertain move_stage response (408/502/503/504), the client makes one
fresh floor-scoped authoritative read, bounded to three seconds. An exact project
with a newer version at the requested stage may continue without another POST.
Otherwise the original error and receipt remain for explicit retry. Payments,
approval commands and authorization failures never enter this recovery path.
This confirms current state, not which actor performed the move. Backend review
accepted the provider pending/version guards and unchanged write semantics.
Unit scenarios cover all eligible statuses, stale/wrong project/stage, stalled or
failed reads, authorization failure and excluded financial/approval commands.
The browser matrix now covers both automatic confirmation and explicit identical
receipt retry for Quotation, Order and Production on each browser profile.

Candidate 4200ca0f (`dpl_3enH12oaNY83yS9nuAgDT6CF3wDr`) settled READY despite
a CLI observation read ETIMEDOUT. It is unpromoted and predates this reconciliation
follow-up. Its CLI error was not a deployment failure. A new candidate is required
for the final source. Production remains unchanged by this run.

## Immediate-publication instruction and custom focus coverage

The user explicitly instructed publication to the live site without further delay
after the six existing high security findings and unpromoted candidate status were
disclosed. This is fresh authority for this release; no historical exception is
reused, and repository security checks/branch protections are not changed.
The final full audit of 52daf55b was intentionally interrupted at 624 passed cases
when the remaining custom focus wrappers were identified; it is not a full pass.
The previous timing phase passed all 60 cases. Final low-impact changes add the
existing web-only field-shell marker to 14 custom single-field controls, including
purchase/catalog searches, quotation fields/quantities and tile searches. Native
behavior, shapes and values are unchanged. Changed-file lint and TypeScript pass.
Final publication uses focused current-source build/browser checks and preserves
the incomplete broad-audit status rather than manufacturing a green result.

## Observed live release — 27 October 2026

Published source `66ca3a3d84e16f4c1a5aee0a3c37835551cede81` to buildconhouse.in:
Vercel `dpl_DHdjbnMrvBq2JLJTdNoYvoytPSdg` is READY and the public alias points
to it; Railway `4f72bbac-d2ea-4aed-88dc-d68407b8def7` is SUCCESS. A fresh
running-container probe matched all 308 reviewed runtime files, pinged Mongo,
verified private storage access and found no pending migrations. The backend
runtime is unchanged from the fully tested backend patch; no data migration ran.

The initial Railway archive upload timed out and its snapshot failed before any
build. A minimal Docker-input package (same 308 runtime hashes and required assets)
excluded tracked temp/tests and succeeded. Vercel CLI observation timed out, but
exact provider inspection established READY before explicit promotion.

Current-source final build, TypeScript and changed-file zero-warning lint passed.
12 focus-shape cases (including custom purchases/catalog) and 12 stage-response
recovery cases passed with Chromium/WebKit and no retries. Hosted candidate and
public-site checks passed all 18 public route/asset/header/health checks and both
authenticated browser profiles: nine stages, top Actions, removed details/filters,
zero reserved bottom gap and rounded outer focus; zero business writes/page errors.
All 32 sampled post-release Kitchen reads were 200. Public-site five-sample
configuration/dashboard/list medians were 314/315/449ms, maxima 704/384/666ms.
These network samples do not demonstrate a latency reduction against the earlier
221/285/436ms baseline. The reproducible improvements are bounded stalled save
work, fewer concurrent identity reads, canceled abandoned requests, safe recovery
of dropped reads/lost stage responses, and removal of 119px hidden-chrome gaps.
The user's precise earlier timeout was not reproduced; universal elimination of
network failures and physical Android/iPhone keyboard acceptance are not claimed.

Rollback remains source `4152caef`, Vercel `dpl_4LJjcrZ79S3XWtoDi6EdLkqBUbT2`,
Railway `fcd498b6-7b0f-448e-8ece-44a0b674ca91`; an exact Git archive was preserved
and all 308 baseline runtime hashes verified. Six existing high dependency
findings remain recorded. Full broad audit was intentionally interrupted for
remaining custom-field fixes and immediate publication per the user's final
instruction; it is not reported as green. Protected-main/security settings and
pre-push hooks remain unchanged, and this branch has not been merged or pushed.
