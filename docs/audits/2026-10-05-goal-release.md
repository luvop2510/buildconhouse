# Application repair and release evidence — 5–6 October 2026

This release implements the verified application fixes and recovery tooling.
The full requested acceptance goal remains open. Missing exact product assets,
unpatched npm advisories, physical-device evidence and operator publication
facts are not represented as complete.

## Application changes

- Payments selects the quotation's owning floor before routing to its editor.
  Late persisted floor reads cannot overwrite a newer selection, and the
  sanitary builder waits for the correct floor before mounting.
- Inter is the shared native/web text family, with explicit weight selection
  and preserved icon fonts. Application icons use public Feather entrypoints.
- Shared product-image frames occupy their designated bounds without extra
  padding; source proportions are preserved across Purchases and quotations.
- Godown explicitly includes exhausted lots in its history view, disables
  unavailable transfers, and ignores requests and mutation completions that
  belong to a previous floor or unmounted screen. Builders use transferable
  quantity. Stock searches treat user input as literal text.
- Catalog, variant and quotation hydration agree on the exact product's
  selected photo, quality, legacy image and seat-cover fallback. Floor, brand,
  category and SKU identity prevent sibling/finish substitutions.

Four exact official Hansgrohe Vivenis photos and eleven exact supplied Vitra
photos/references were recovered in the live catalog with hash, ownership,
display and unchanged-product checks. Vitra originals retain their actual
low-resolution quality labels. Three additional exact supplied Oyster photos
were restored, and two wrong finish assignments were corrected on 6 October.
The Oyster adapter now follows unambiguous displayed row bounds and rejects
conflicting anchor ownership. The coverage audit still identifies 124 known
usable-photo gaps; see the per-SKU requirements and final byte-scan findings in
[the media audit](2026-10-05-product-media-backend-audit.md).

## Validation

- Final backend unit suite: **1,552 passed**, six existing deprecation warnings.
  The byte-audit evidence preserves its earlier 1,539-case verification; ten
  subsequent redacted recovery-diagnostic cases raised the total to 1,549; three
  Oyster boundary/ambiguity regressions raised it to 1,552.
- TypeScript and Expo lint with zero warnings passed; Expo Doctor passed 18/18.
  A clean isolated npm installation and Expo dependency compatibility passed.
- Earlier full browser run: 880 passed, 20 intentional skips, no failures or
  flakes. After final typography/legal updates: 113 passed, 15 intentional
  tablet skips. After the last Godown race fixes: 64 passed across eight browser
  profiles, no skips, failures or flakes. These are browser tests using
  intercepted API fixtures; they do not establish physical-device acceptance.
- Seven actual-screen deferred-hook stock race regressions pass; removing the
  guards makes four cases fail. Text, icon, legal, native permission, health and
  audit-gate regressions pass. Final JavaScript route budgets pass.
- iOS, Android and web JavaScript/Hermes exports passed. Expo plugin
  introspection confirms camera/microphone permission removal. Signed native
  binaries and hardware behavior remain unverified.
- Final changed/new-file credential-pattern review and `git diff --check`
  passed. No backup snapshots, environment files or customer-data artifacts
  are included in the Git release.

Durable local evidence is under ignored `output/playwright/` and
`output/operations/`; source-level audit reports are committed here. Hosted
checks are distinguished from local fixture-based tests below.

## Hosted release verification — 6 October

Commit `19b9bd971cf706ee260f48d87194dbf867390320` was pushed to GitHub main.
Vercel deployment `dpl_HcCL46ZFHEfb15MBL6pLRBBjFSFe` reached READY and
the canonical `https://buildcon-house-nine.vercel.app` alias was verified.
Railway deployment `618d8245-7296-49e1-850b-c7eac0cf0640` reached SUCCESS
with the same exact source commit. Read-only canonical and immutable-URL
checks each passed all 16 route/asset, header, cache, health and authorization
checks. Thirty hosted backend probes passed; these are host measurements,
not verified regional acceptance.

Hosted floor and tile-image journeys initially passed 78 of 80 cases; two
Firefox cases timed out navigating to the page. All ten Firefox cases passed
on a serial recheck with the same timeout and source, without retries. The
initial failures remain recorded; the exact cause was not established.

[CI run 37358805293](https://github.com/yashvardhansinh2510-max/forge2.0/actions/runs/37358805293)
passed backend checks, including 1,549 tests, Python dependency audit and
Docker build. Its browser audit passed 903 cases, skipped 20 intentional
cases and failed one WebKit tile supplier-photo assertion. Expo Image retained
both the old blob and current image during a crossfade, making an unqualified
`img` locator ambiguous. The corrected assertion selects the exact current
source, checks visibility and full frame bounds, and permits the legitimate
transition. It passed all 16 tile-image cases across eight profiles locally
and all 16 on the hosted release, without skips or flakes. TypeScript and
diff checks passed. The independent npm security job remains failing.

## Security and operations

The 5 October scan decreased from 38 to 27 findings. The fresh 6 October
scan indexed additional advisories and found 34 before two compatible patch
updates. The current count is **32 (23 high, nine moderate)**. The supported
dependency graph still contains unpatched or incompatible-upgrade transitive
roots. Functional frontend CI runs independently; the security job continues
to block high/critical findings. Overall CI cannot be certified green. See
[the dependency review](../deployment/security-dependency-review.md) for exact
advisories and the supported-SDK experiment. Production Python dependency
auditing reported no known vulnerabilities.

Monitoring now excludes request/user/customer data, raw exception messages,
database spans and local variables; offline real-SDK envelopes were reviewed.
No production Sentry DSN or continuous alert destination is configured.

Recovery CLI failures now preserve safe numeric provider codes/status and an
allowlisted command phase, without raw messages, credentials or document
values. Generic MongoDB code 8000 alone does not imply quota failure; explicit
provider storage-quota evidence is required. Malformed provider details also
fail safely without a chained traceback. All eighteen focused recovery cases
and the final full backend suite pass.

A real read-only logical backup captured 41 collections and 40,245 records at
2026-10-05T12:43:47Z. Private-bucket metadata, bounded chunk uploads, every-byte
readback, checksums and local verification passed. It predates this pass's
fifteen photo repairs. Snapshots are excluded from Git and Docker context.
An actual isolated cloud restore failed after 158.760 seconds under shared
storage quota pressure, with 12 partial/complete collections and 16,401 records.
The original `OperationFailure` code was not retained; a subsequent
duplicate-ID insert attempt confirmed the gateway's code `8000` shared-quota rejection,
without inserting a diagnostic record. Only the newly created failed target
was rolled back; its absence and source database health were verified, with
all 42 source counts/index contracts/collection options matching the baseline.
No source write occurred and the backup remains intact. See the
[cloud drill evidence](2026-10-06-cloud-restore-drill.json).

The actual [local standalone restore retry](2026-10-06-local-restore-drill.json)
passed all 41 collections, 40,245 canonical BSON records/identities, collection
options and 176 index contracts in **11.339 seconds**. The first local attempt
had a transient `AutoReconnect` failure after 11 collections; its exact cause
was not established or reproduced on the fresh retry. The local MongoDB
process was stopped afterward. This establishes logical restore correctness;
it does not certify a complete cloud restore, Atlas/PITR recovery or cloud RTO.

[Recovery and regional procedures](../deployment/recovery-and-regional-acceptance.md)
cover logical backup limits, private media, restore, deployment rollback,
alerting and regional measurements. Proposed RPO/RTO and schedules need an
operator owner. The backend is currently in `iad`; host-based probes do not
establish India or other regional performance acceptance.

## Remaining acceptance requirements

The 119 missing exact SKU/finish photographs and five unavailable displayed
objects must be resolved before claiming every product has a usable image. Security CI must
pass supported dependency remediation. Physical iPhone, iPad, Android phone
and tablet testing requires devices and signed builds; browser viewports are
not hardware evidence.

Legal/privacy components and listing/reviewer-access worksheets are prepared,
but verified entity/address/contact/retention/jurisdiction facts, actual store
forms and minimally privileged reviewer accounts remain pending. Public pages
truthfully retain the draft state while required facts are absent. See
[store and device acceptance](../deployment/store-submission-and-device-acceptance.md).
An owned alert destination, approved retention/RPO/RTO, a complete cloud
restore into adequately sized isolated capacity and verified regional
probes/load testing are also outstanding. The local restore drill is complete;
the current shared cluster could not accommodate the cloud drill alongside
production.

## Oyster and dependency follow-up — 6 October

The supplied basin-mixer workbook mapped 53 of 56 photos before the fix and
all 56 afterward. Comparing all 132 rows in the three available Oyster
workbooks changed only the five reviewed exact image assignments; SKUs,
finish fields, pricing and family identity remained unchanged. The fourth
Shower workbook is absent locally, so its actual-file mapping is not certified.
Three previously missing originals and two wrong-finish corrections were
verified by stored bytes and selected hero, with unchanged product documents
and retained previous media. See the supplied-recovery and finish-correction
manifests. Native source quality is retained; these are not fresh web assets.

The scoped post-recovery integrity check completed 21 of 21 rows, combining
the full 8,479-row baseline with all affected reference/recovery IDs. Current
media rows total 8,489; 119 absent photos and five missing selected objects
leave 124 gaps. The gate remains failing on those five confirmed missing
objects. No unchanged healthy baseline object was downloaded again.

Compression 1.8.2 and source-map-js 1.2.2 were installed from the compatible
existing version ranges. Clean npm installation, TypeScript, lint, Expo
compatibility, production web export, route budgets and affected security/UI
contracts passed. This does not clear the remaining dependency advisories.
