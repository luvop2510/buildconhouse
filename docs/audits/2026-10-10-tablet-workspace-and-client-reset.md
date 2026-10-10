# Tablet workspace and client draft reset — 10 October 2026

The tablet shell now uses the same collapsible sidebar as desktop. Expanded navigation includes destination names, workspace name, staff name and role; collapse state persists and keyboard activation retains 44px controls. Phone navigation retains its existing bottom bar. The shared route predicate prevents the Ground Floor Quotations link from also appearing active inside Tile Orders.

Tile Orders tables and toolbars respond to usable container width, including space consumed by the expanded sidebar. Below 900px the table uses labelled records; tablet records retain brand/waiting/progress information and fulfilment counters that phones omit. At 1024px, collapsing the sidebar returns a sufficiently wide table to its column layout; expanding it restores readable records. Search fills the available narrow toolbar, status chips scroll in one row, actions wrap and long section titles/status badges can reflow. Summary badges wrap. Queue-card minimum basis is now 220px, allowing two columns inside the 480px usable workspace at 768px and placing populated orders much higher on the page.

## Local customer-data cleanup

The reset release also removes persisted historical quotation draft data at client startup. `ensureBuilderDraftReset()` enumerates the underlying AsyncStorage store and deletes all `forge.builder.draft.v1.*` keys, including orphan blobs and the registry, plus `forge.builder.snapshot.v4`. It increments the writer epoch and awaits queued writes before deletion. Favourites, account credentials, active workspace and UI preferences are preserved. The `forge.builder.customerResetEpoch.v1` marker is recorded only after deletions succeed, and subsequent launches retain quotations created after this reset. Failed cleanup remains retryable.

Auth hydration and staff/customer login await cleanup before publishing the signed-in identity. Generation checks still reject obsolete hydration/login completions. This is actual blob removal, rather than merely renaming the draft key. Already-open tabs and native clients retain in-memory content until closed/reloaded; backend session revocation and the maintenance/reset procedure must prevent those old editors from recreating cleared workflows. Client disk data is cleared when that client next launches this release.

## Verification

All browser checks use intercepted synthetic identities/catalog/orders and an audit server without a production API proxy. Six exact Chromium profiles: 320×740, 390×844, 768×1024, 1024×768, 1280×800 and 1440×900. External origins are blocked in the new cases.

- Combined inherited responsive interaction/catalog and new workspace checks: **108 passed, six conditional skips, zero failures or retries** (`output/tablet-review-20261010/results.json`, `browser-tests.log`).
- After the final navigation predicate/queue-width and unrelated quotation-action semantics changes, the new suite accepted **22 passed, two phone-only sidebar skips** across the final focused run and the four-case sidebar rerun (`focused-final-results.json`, `sidebar-final-results.json`). These cases overlap the earlier combined run and are not counted as additional distinct cases.
- The intermediate final focused attempt recorded 18 passed, two skips and four failures. All failures were a test assumption that link roles emit `aria-selected`; React Native Web omitted that attribute. The test now directly checks the observed highlighted/transparent navigation backgrounds. The corrected four sidebar cases passed at every tablet/laptop/desktop size without another source change or export, deadlines or retries.
- Client reset source-execution tests: **five passed** (`node scripts/test-customer-draft-reset.mjs`). Covers indexed/orphan/legacy blob removal, preserved preferences, subsequent launches, retryable deletion/enumeration failure and stale/in-flight writer invalidation.
- Auth source-execution races: **44 passed**, including reset-gated identity/login and unmount checks on web and iOS models (`npm run test:auth-provider-races`). The harness now awaits its existing settle helper before resolving login POSTs because startup cleanup intentionally precedes that POST.
- TypeScript, zero-warning focused ESLint, mobile UX contracts, 15 history/lifecycle tests, frontend performance contract and whitespace checks passed. Final tablet queue/sidebar source changes were separately checked by TypeScript and lint.

Final 768px and 1024px screenshots were reviewed. New checks cover displayed staff/navigation names, persisted keyboard collapse, absence of simultaneous Quotations/Tile Orders highlighting, tablet queue-card columns, container table reflow, movement controls/dialogs, fulfilment counters, absence of document-level horizontal overflow and real seeded localStorage blob removal with post-reset draft preservation. The parent release audit covers additional routes and reports its results separately.

Browser sizing and modelled iOS auth races do not certify physical-device rendering, native touch/keyboard behavior or accessibility services. No additional unresolved UI defect was confirmed in the states covered here; existing media, signing, security and operational gates are outside these responsive checks.

## Source changes

- `app/(admin)/_layout.tsx`
- `app/(admin)/tiles/orders/index.tsx`
- `app/(admin)/tiles/orders/[id].tsx`
- `src/components/tiles/TileLayout.tsx`
- `src/components/tiles/TileTable.tsx`
- `src/components/quotation/helpers/draftStorage.ts`
- `src/state/auth.tsx`
- `scripts/test-auth-provider-races.mjs`
- `scripts/test-customer-draft-reset.mjs`
- `e2e/responsive-tablet-workspace.spec.ts`

Inherited 8 October responsive work was preserved and staged separately using the saved pre-edit admin-layout snapshot, then committed by the parent as `445ac4f2`. This review did not modify BuilderShell or the quotation WhatsApp controls. The local evidence directory is ignored by Git; screenshots and browser traces contain synthetic fixtures only.
