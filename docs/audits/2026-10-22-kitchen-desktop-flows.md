# Kitchen desktop, tablet and phone repairs — 22 October 2026

Kitchen is an Expo/React Native Web workspace for moving customer projects through nine stages. This repair retains the existing visual tokens and stage navigation. Apple layout, accessibility and data-entry foundations apply; native macOS menu conventions do not apply to the website.

## Reproduced causes

- **Customer editing:** `FloorAccessGate` classified every non-Kitchen business URL as retired on Kitchen floor. `/customers/:id/edit` therefore redirected to Lead before rendering, despite valid owner credentials and a valid customer. The new actual API/Mongo browser regression reproduced this redirect. The exact existing customer-editor route is now allowed; other retired business routes, concrete floor checks, custom-access routing and backend permissions remain enforced. Projects expose Edit customer to owners and staff with an explicit customer-update grant. No role/grant or backend authorization was broadened.
- **Kitchen panels:** the shared `Sheet` wrapper unconditionally forced `scroll=false`, even when callers requested scrolling. Filters and secondary project panels rendered controls flush to the edges and could clip their final actions. Sheet now honors an explicit scroll prop. Add Lead, settings, filters, documents, attachment choices, history, assignment, owner actions and workflow use Overlay's one padded scrolling body. Existing screens with their own scrolling body retain their default behavior.
- **Payments:** the desktop/tablet heading and tabs were outside the padded collection scroll, leaving the title at the workspace edge. The heading now uses the existing responsive gutter (24 px on tablets, 32 px on desktop), with vertical spacing. Phone heading scroll ownership remains unchanged.
- **Customer order picker:** Open purchase orders had the same unpadded Sheet body. Its actual button-to-panel gap reproduced as 0 px; it now opts into the shared padded scrolling body.

`layout.md > Adaptability`: “Design a layout that adapts gracefully and consistently.” `sheets.md > Desktop (macOS)`: “Present a sheet in a reasonable default size.” These principles support the bounded panel, responsive gutters and reachable controls; the specific React Native implementation is engineering judgment.

## Verification and limits

The Add Lead regression checks real input geometry, the actual Overlay body padding, and a real desktop wheel gesture at 1440 × 600. It verifies that scrollTop increases and Create lead becomes visible within the panel. The existing real create/submit/persistence journey remains. The customer-edit regression drives Kitchen project → Edit customer → PATCH → independent Mongo-backed GET → hard reload on desktop Chrome, Android Chrome, iPhone Safari and iPad Safari.

TypeScript, focused zero-warning ESLint and mobile interaction contracts pass. The focused final eight-case Kitchen panel/customer suite and all 48 final shared-page cases pass. The full Kitchen run adds 1920 and 2560 px desktop profiles to the existing 320–1440 px/landscape/Firefox matrix; full workflow results are recorded with the coordinated release when settled. Superseded runs were stopped after source changes and are not acceptance evidence. One shared-page run was invalidated by a concurrent export replacing its files; its error page explicitly requested a release rebuild. The final shared suite ran against the stable export.

The isolated harness binds customer activity logging to its disposable database, preserving real logging without contacting the deliberately unreachable default database. No production business data was changed for testing. The user later authorized the existing owner login for read-only hosted checks. The staged candidate passes the real Kitchen project → customer editor journey on desktop Chrome and iPad Safari; no Save was clicked and each run-owned session was revoked. Broader hosted release acceptance remains unqualified because of intermittent quotation/navigation failures and the subsequently confirmed backend OOM. Physical devices and assistive-technology acceptance remain separate.

## Publication

This branch builds on the coordinated Add Lead/Expo/pypdf release at `f9fece11`. The other authorized release chat owns the final combined push, required pre-push performance audit, Vercel candidate/promotion and Render deployment observation. Actual deployed source identities and final checks must be recorded before calling publication complete. Existing GitHub protections remain in force.

## Render memory investigation (2026-10-22)

Render reported an OOM kill at 14:31:19 UTC on its 512 MiB instance. The catalog uses 19,491,825 bytes of source BSON (6,597 products and 8,497 media rows); a read-only local profile of that same database identity retained about 122 MB of Python heap. Rebuilding identical sources while retaining the old snapshot raised the measured peak to 244,496,809 bytes. This is an avoidable contributor, not proof that all possible memory growth has been eliminated.

Warm refreshes now stream bounded source fingerprints and reuse the complete cached objects when every source is unchanged. In-process invalidation still rebuilds directly; offline source changes are detected and rebuilt. Byte and row limits, database fallback, cursor cancellation, concurrent-write generation checks and existing catalog responses remain intact. Abandoned builds release their decoded rows before retrying.

With the change, two consecutive unchanged refreshes peaked at 136,780,250 traced bytes (44% lower), retaining the same full source counts and memory mode. macOS peak process RSS was 257,425,408 bytes versus 429,293,568 before; these local measurements include tracing overhead and do not certify the running Render container. All 164 catalog unit checks pass, including new unchanged-source, offline-change, warm budget and concurrent-write cases. Seven disposable Mongo integration checks also pass, including an unchanged refresh reusing complete objects followed by an offline Mongo edit that rebuilds and returns the updated price. Deployed memory/health still need final recording.

The author-only release commit `90709e44` produced a READY Vercel candidate using the authorized Gmail identity, resolving the author-permission block. Its exclusive local audit passed 624 stability checks but failed 11 of 60 timing checks during a period of host memory pressure. Those failures are preserved; budgets and tests have not been relaxed. Publication remains pending the final combined source, required checks and guarded promotion.
