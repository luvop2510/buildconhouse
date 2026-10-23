# Kitchen audit and review preview — 23 October 2026

## Scope and source

The owner’s latest clarification expands table/layout design-system improvements to Kitchen, Sanitary Bathroom, Ground and Furniture and authorizes live publication after verification. PDF comparison and assignment/next-action removal remain Kitchen-only. Other floors retain existing workflow features. The source is a separate working checkout at `kitchen-audit`, based on `b0d5be69`, which already contains the recent customer-editor, panel-scrolling and catalog-memory repairs. Earlier working copies and their uncommitted changes remain intact.

The nine-page Kitchen specification was verified at `/Users/yashvardhansinhjhala/Buildcon_House_Kitchen_Department_Specification.pdf`, SHA-256 `6fd721959e40840415c362cad2f94c39c2efdb9ddd9b6dc1aeb1fd3bf827b551`. The owner’s current removal instructions supersede the PDF’s older Assigned To / Next Action / next-action deadline requirements. The Visit stage records a showroom visit; actual site visits remain in Installation.

## Corrections

| Finding | Result |
| --- | --- |
| Stage assignments also controlled server visibility and update access. Simply hiding the controls would strand staff projects. | Kitchen project access now follows current floor/action/expiry grants, with no assignment prerequisite. Owner-only launch restrictions and selected-manager approvals remain. New assignment writes are rejected; historical data remains intact. |
| Next-action fields existed in Visit, planning, cards, filters, sorts and overdue calculations. | Removed from Kitchen controls, new writes and overdue calculation. Old bookmarked assignee/next-action filters normalize safely. Target completion and real business-stage dates remain. |
| Showroom and actual site visit dates required manual entry. | Fresh visit forms use the current India business date, remain editable, and persist the chosen value. Existing saved dates and unknown legacy dates remain unchanged. Midnight, year and leap-day boundaries are tested. |
| A delayed Reload response could replace a newer saved project and cause a false version conflict. | Provider accepts only the same project at an equal or newer version for reads, commands and file updates. Regression delays a real API response behind a real persisted command. |
| An unsaved Installation site-visit draft did not block the stage handoff. | Current-task dirty checks include site-visit drafts; stage progression waits for deliberate save/discard. |
| Duplicate-review bookmarks were discarded from queue API requests. | The actual pending-review filter reaches the server and survives return navigation; Clear removes it. |
| Workflow task assignment and manager configuration used the same staff-picker endpoint. | Workflow selectors are gone; owner-only eligible manager choices remain available for required approvals. |

## Design review

**Thesis:** one permanent project dossier, with a clear current task and preserved commercial history. This is a working showroom tool, so hierarchy and reliable entry matter more than decorative panels.

Kitchen now has a scoped palette and type scale, one scrolling header/content frame, aligned content widths, 44-pixel minimum buttons, 48-pixel input rows, explicit keyboard focus, grouped enquiry fields and a nine-stage progress indicator with a textual stage label. Controls wrap rather than compressing essential labels. Focus changes retain input geometry. Documents, history, completion dates and owner exceptions remain secondary tools; prior-stage records remain accessible.

Exact palette pairs: primary content `#17232E` on white 15.95:1; secondary `#53616F` on white 6.35:1 and `#F6F7F9` 5.92:1; action blue `#0066CC` on white 5.57:1. These are measured token pairs, not a claim that every possible rendered composition has been certified. The shared table primitives now enforce column geometry, text wrapping and contained horizontal scrolling across floors. Other-floor workflow fields and token palettes are preserved.

The reusable contract is documented in `docs/design/shared-workspace-system.md`. Table minimum widths include all columns, gaps, gutters and borders. Fixed columns cannot shrink into neighbouring cells; flexible columns use a consistent zero basis. Long identifiers wrap within their actual cell. Kitchen uses the shared table directly instead of nesting horizontal scroll regions. Furniture's separate currency ledger also retains fixed columns and wraps long descriptions. Populated browser checks inspect text ranges and header/body alignment, not merely a clipped page boundary. A dedicated CI step retains these checks across seven Chromium widths and two Safari widths.

Reference basis: Apple `layout.md › Visual hierarchy` recommends grouping related content and progressive disclosure; `layout.md › Adaptability` requires familiar layouts across widths. `entering-data.md › Best practices` supports obtaining system data and editable reasonable defaults. `accessibility.md › Mobility` and `buttons.md › Best practices` support comfortable controls and press feedback. These foundations apply to the web ERP; native macOS menu-bar conventions are not imposed. UI/UX Pro’s responsive flexbox, labels, form feedback and navigation checks were applied.

## PDF workflow traceability

| Stage | Preserved requirements checked |
| --- | --- |
| Lead | Customer identity/phone/site, enquiry fields, status/lost reason, duplicate review, conversion without duplicate customer creation. |
| Visit | Showroom date/model/requirements/budget/notes/status/interest; date is editable and automatically filled for fresh records. |
| CAD File | Receipt, 0–100 progress, status and notes; no premature company quotation handoff. |
| Design | Presentation document/link, sharing, customer response, customer-requested revision count, approved-version company handoff, preserved versions. |
| Quotation | Company receipt, exact INR amount, file/link, sharing date and customer response; versioned revisions. |
| Order | Current quotation confirmation, date/final amount, optional confirmation file, actual advance, owner hold/cancel behavior. |
| Production | Explicit selected-manager gate, current approved commerce/advance, start/completion dates and status. |
| Installation | Start/completion dates, actual site-visit counts/dates, protected drafts, selected-manager closure. |
| Completed | Automatic eligible closure, exact saved amounts/dates/counters and truthful unavailable legacy values. |

## Verification

| Check | Result |
| --- | --- |
| Hermetic backend unit suite | 3,080 passed; three existing Pydantic deprecation warnings. |
| Owned Mongo / real HTTP Kitchen integration | 48 passed, including denied view-only/floor/export cases and manager-choice compatibility. |
| Frontend CI contracts | 43 existing commands passed after correcting the scoped input import to use the app text/focus wrapper; new Kitchen date boundary command also passes. |
| TypeScript and official Expo zero-warning lint | Passed. |
| Reload/save race regression | 4 passed on desktop Chrome, Android Chrome, iPhone Safari and iPad Safari, using delayed real responses. |
| Read-only production-configured readiness | Mongo connectivity, required indexes and R2 bucket checks pass; no writes or startup workers. |
| Full Kitchen lifecycle/route matrix | 124 passed; includes all nine stages and the responsive route matrix. Subsequent focused final-source checks passed 16 scenarios, including the reload race, enlarged text and keyboard focus geometry. |
| Nearby payment, quotation and tablet regression audit | 82 passed, 20 viewport-specific skips, 10 failures (nine Firefox, one WebKit); timeouts include browser page setup, customer selection and PDF actions. These failures remain unresolved and prevent an all-green release claim. |
| Populated all-floor table browser matrix | Final immutable-export run: 36 passed, zero skips/retries/flakes. Seven Chromium widths (320–1920 px) and Safari at 390/834 px cover all four floors. Initial 36 had 27 passes: seven Furniture failures came from checking an off-screen ledger and were corrected in the test setup (all nine Furniture cases then passed); two Kitchen desktop failures exposed the real keyboard defect, now fixed. |
| Fresh final-source performance/stability gate | Pending after browser audit to avoid competing test/build load. |

Results are recorded in `output/review-2026-10-23/` and the repository’s `output/playwright/` reports. Tests use synthetic sessions, owned loopback Mongo instances and private test files; no production customer records are changed.

## Hosted findings and release boundary

Read-only probes of the older convenience site `https://buildcon-house-nine.vercel.app` returned 200 for `/api/health` and `/api/health/ready`, but 404 for `/api/kitchen-projects/configuration`. The previously staged October 22 candidate returned 401 for that protected endpoint, which shows the route exists there. Fresh authenticated Vercel alias reads establish `buildconhouse.in` as the actual canonical domain, mapped to the newer 90709 candidate; the older convenience domain points to a different baseline. Health on that older domain alone does not establish canonical Kitchen behavior. Canonical and direct Render probes timed out during observation. Direct Render-domain requests timed out during the same observation; this does not alone establish a persistent outage. The existing backend memory fix is included in this source baseline; deployed memory behavior is not qualified by local tests.

The fresh npm scan reports 22 high / 0 moderate advisories. The previously reported `sprintf-js` moderate advisory was withdrawn upstream on October 22. The remaining high findings trace to `braces` and `node-forge`; official advisories currently list no patched version, and the installed SDK 55 dependency chain already uses their latest published releases. Suggested broad Expo/React Native replacements include incompatible major changes or a downgrade; they are not applied as an incidental UI repair. No advisory suppression, branch-protection bypass or claim of an all-green security gate is made.

The owner subsequently authorized live publication after all-floor layout/design-system verification. Required source checks, review and runtime deployment qualification still apply; the previous October 21–22 exception has expired. No database migration or production customer write is needed for this repair. Physical devices, native share sheets, full screen-reader testing, full dark appearance and production provider/storage/load acceptance remain unverified. Browser coverage is bounded evidence, not a guarantee of zero possible defects.
