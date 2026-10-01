# Quotation, follow-up and payment stability review — 2026-10-02

## Resulting behavior

- Quotation PDFs omit the dimensions column when dimensions are disabled or no included product has a dimension diagram. The remaining columns use the freed space.
- MRP headers, currency amounts and totals stay on one line in quotation PDFs, tile PDFs and quotation views. Rendered PDF samples include large amounts and portrait/landscape diagrams.
- Human changes to existing follow-ups require a nonblank note before any mutation. This includes dashboard Done, completion, snooze, assignment, dismissal, deletion, contact, call outcomes and notebook edits/conversion/outcomes. Notes are retained in activity history; cancel and failed saves preserve the item and entered note.
- Payment sheets and long ledgers scroll within their available height. Customer switching, Previous pagination and slow filter responses remain usable on desktop, tablet and phone.
- Payments preserve paise, reject malformed amounts/overpayment, and retain retry keys after failed responses. Transaction retries serialize competing collectors through their shared order. Additional costs have independent retry protection and omit null payment idempotency keys so multiple costs can coexist with the unique sparse index.
- API writes invalidate both cached and in-flight reads; older responses cannot replace refreshed cached data. Modal background isolation survives saving/retry transitions.

## Verification

| Check | Result |
| --- | --- |
| Final backend unit suite | 1,407 passed; six existing dependency deprecation warnings |
| Broad route/workflow browser audit | 651 passed |
| Final focused release browser audit | 192 passed across eight profiles |
| TypeScript and Expo lint | Passed |
| Frontend contract scripts, including 16 API response-order race scenarios | Passed |
| Expo Doctor | 18/18 checks passed |
| Production Expo export | Passed |
| Mobile initial JavaScript budget | All checked routes below 576 KiB gzip; observed 520–544 KiB |
| Backend static analysis and compile check | Passed |
| Production Python dependency audit | No known vulnerabilities |
| Configured npm dependency gate | Passed; existing Expo 54 build-tool `image-size` advisory remains tracked |
| Migration preflight | Read-only dry run found no pending migrations |

The browser runs use the actual production export and synthetic intercepted API responses. The audit server cannot proxy writes to production. Backend tests use isolated/fake database fixtures. These checks cover the listed routes and cases; they do not claim exhaustive load testing or native-device certification. No customer payments or follow-ups were changed for testing.

PyJWT, pypdf, undici and brace-expansion received compatible security updates. Vercel now installs with `npm ci` and builds with `npm run build` to use the committed npm lockfile consistently. The remaining `image-size` issue belongs to the Expo 54 build toolchain and requires a separately tested toolchain migration; the existing audit policy was not broadened.

Local evidence is in `output/pdf/2026-10-02-quotation-layout/` and `output/playwright/` (ignored generated artifacts).

The previous GitHub CI run passed every test but failed only because GitHub artifact storage was full. Evidence upload now reports that failure as a visible warning and step summary while preserving all test/build failure gates. Artifact retention is three days with maximum compression. Existing artifacts were not deleted.
