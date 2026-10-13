# Quotation filters, walk-ins and loading follow-up — 13 October 2026

The quotation builder now uses one brand and one category. Choosing a brand
clears the prior category; choosing the current category keeps it selected.
Finish/Color filter rows and their hidden saved state are removed. Product
variant choices remain available so staff can quote the correct SKU. Older
multi-choice quotations reopen with a single scope, and categories incompatible
with the restored brand are cleared after authoritative categories load.

Failed category requests now expose loading/error/retry in the compact picker
and the desktop brand rail. The rail shares the same reference cache as the
builder, cancels obsolete floor consumers, and discards stale responses.
Selection buttons expose supported browser `aria-pressed` state.

The Vercel API proxy also preserves repeated catalog query keys instead of
discarding every value after the first. The actual proxy regression fails
before the fix with only Grohe forwarded from Grohe/Hansgrohe, then passes with
all requested brand/category/size/source values, exact encoded labels, unchanged
pagination/floor headers and reserved route-key exclusion. Existing download
token, cookie/CSRF/origin and timeout contracts still pass. This aligns Vercel
with native requests and the existing web worker; the quotation builder itself
continues to send single brand/category choices. Independent review verifies
backend bounded-list and authenticated floor checks remain enforced.

The wider audit reproduced a recent Team edit bug: passive initialization could
restore a saved contact after the user immediately cleared it. The form now
commits saved values in the layout phase before interaction. The original
rapid-clearing browser test is unchanged and passes all eight audit projects.
The actual production-hook regression fails with the previous initializer and
passes with the fix, including immediate clears and switching staff documents.

Purchases customer workspaces now use the same actual-order eligibility as the
Customers register: ordered/won quotations, non-deleted tile orders or active
purchase quantities on the selected floor. Walk-in profiles and draft quotations
stay prospective until an actual order exists. Legacy buyers and transferred
owners remain eligible; completion handling and underlying records are
preserved. Independent eligibility/completion reads run concurrently.

The catalog no longer scans every product for each WC configuration or legacy
concealed-part hydration. Lazy candidate indexes retain the existing floor,
brand, category, finish and ambiguity checks, rebuild after product edits, and
survive usage-only updates. The reproducible, exact-output CPU benchmark gives
Vitra 329.738 → 12.372 ms and Grohe 57.409 → 16.960 ms for 60-card first pages.
These measurements exclude DB/network/browser costs. Existing recent fixes for
bounded warmup, parallel analytics, progressive detail loading, immediate
categorical requests, shared reads and bounded cache retention are included in
this release source.

Fresh read-only bathroom catalog verification checks all 146 populated scopes
with zero discrepancies or broken relationships. All 104 configured categories
are accounted for; 63 contain no eligible source products. Five brands expose
3,090 eligible products. No data, prices or images are invented or deleted.
See the fresh catalog matrix, hydration benchmark and follow-up review beside
this report.

## Review and local acceptance

The team reviewed the recent ten-commit range `27f3464f..a8e106e4`, current
quotation/catalog boundaries, purchases eligibility, auth/session revocation,
API cancellation/cache invalidation, login hydration and stale-cookie recovery.
An independent review caught the compact category failure path before release.
This is scoped code review and regression evidence, not a proof that every
possible code path is defect-free.

- Full hermetic backend suite: **2,288 passed**, ten existing warnings.
- Walk-in/customer focused suite: **62 passed**, including disposable Mongo
  conversion, legacy, transfer, floor and record-preservation cases.
- Catalog/analytics/page-performance focused suite: **166 passed**.
- All **42 required frontend commands** pass. TypeScript and zero-warning lint
  pass. Final production web export succeeds.
- Focused final quotation browser run: **8/8 passed** on desktop and phone,
  four cases per profile, zero retries. Team rapid-clear focus passes **8/8**
  across every audit project. Final full suites: route audit **1,667 passed/32
  skips**, responsive **412/15**, device profiles **420/8**, performance **28/0**.
  Combined **2,527 passed, 55 intentional skips, zero failures/flakes/retries**.
  Raw final suite statistics are in the follow-up browser summary. Device/slow-CPU
  cases are desktop emulation with intercepted APIs, not physical-device or
  authenticated production timing acceptance.
- All **157 generated HTML pages** remain within the 576 KiB initial-JavaScript
  budget; largest is 449 KiB gzip. Eleven required route budgets also pass.
- Exact-literal scan of **248 export artifacts** finds no configured private
  JWT/Mongo/Supabase service-role/Vercel token values. Encoded-secret detection
  and physical-device/native acceptance are outside this check.

The proxy correction changes the separately deployed API function, not the Expo
release assets under test. Its actual-handler regressions and changed-file lint
pass against the final API source; the existing worker contracts also pass.

Two preliminary focused browser runs are preserved separately. The first used
unscoped duplicate picker controls and counted the Add room control as a product
add button. Corrected fixtures use the active dialog and exact supplier-SKU
controls. The second passed 24 cases but failed eight unsupported
`aria-selected` assertions on button roles. The product now exposes
`aria-pressed`; exact filtered product identities and previous-choice clearing
remain asserted. No retries, larger deadlines or weaker product checks were
used. Raw local reports/artifacts remain under `output/playwright/followup-first`
and `followup-second`; compact summaries are committed alongside this report.

The first wider run observed 1,482 passes and one Team rapid-clear failure before
it was stopped to rebuild the corrected source. That incomplete run is preserved
as diagnostic evidence, not final acceptance. The final four suites restart
against the updated export with the configured worker counts (audit three;
responsive/devices two; performance one), unchanged deadlines and no retries.
Original failure screenshots are under `output/playwright/followup-broad-first`;
the compact abandoned-run summary is committed.

## Publication and operational evidence

GitHub publication uses the existing review branch and PR #16 in
`luvop2510/buildconhouse`. The user's explicit instruction authorizes direct
deployment of the tested source to the existing Vercel and Railway projects.
Required main protection is preserved. The fresh npm gate still reports
**22 high/five moderate** findings; no suppression or protection bypass is
applied, and protected-main merge is not claimed.

Read-only Mongo/index/Supabase predeploy checks pass and the migration dry-run
reports no pending changes. No schema or production-business mutation is
required. Previous successful Railway deployment:
`ac7dfc21-929b-4457-922a-00c94f3eb216`; previous Vercel production deployment:
`dpl_GMG76hYvtuH3U3egdBkBqvRJYZ4w`.

Vercel input inspection found the local `.env` public backend URL in its upload
manifest. Local environment files are now explicitly excluded; the template is
retained and production uses linked-project variables. The private OIDC file
was already excluded. No credential value is recorded in this evidence.

Publication and hosted acceptance are recorded below. Local
fixture timing does not establish authenticated production latency. Three
pre-release readiness samples from this India host were 809–1,212 ms through
Vercel and 707–900 ms direct to Railway; those reads include remote Mongo access.
The current regions remain Vercel `iad1` and Railway `sfo`.


### Verified deployment outcome

Runtime source `0d30cf84a326cd5e018d95873fcccd7937a26df7` is pushed to
GitHub PR #16. Railway deployment `7c96f99c-19e7-4c62-a8bf-2ba5dd62a4f1`
is successful; the live backend contract passes and customer-workspaces OpenAPI
exposes the confirmed-buyer eligibility description.

The first Vercel deployment was blocked by the provider's commit-author access
check. The user requested another deployment. The normal CLI production retry
(with force rebuild) succeeded without changing author identity, memberships or
Git metadata. Deployment `dpl_GS3rtExZ96v986S5RPRdnbq5hqrm` is READY and its
provider metadata confirms the source commit above. Production aliases are
https://buildconhouse.in and https://www.buildconhouse.in; deployment URL is
https://buildcon-house-hn2o4ky16-yug19.vercel.app.

Read-only hosted release verification passes all 19 route/asset checks, including
security/cache headers, missing-asset handling and API health/auth. The quotation
regressions pass all eight desktop/phone cases against the deployed frontend.
Their APIs are intercepted with fixtures, so they verify hosted assets and UI
behavior without writing production business records.

Final local acceptance totals: 2,288 backend tests; 2,527 browser tests with 55
intentional skips and no failures/flakes. Protected-main merge remains blocked
by the documented dependency-security gate; deployment does not waive that gate.
