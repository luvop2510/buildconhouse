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
