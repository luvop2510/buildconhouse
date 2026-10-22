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

The isolated harness binds customer activity logging to its disposable database, preserving real logging without contacting the deliberately unreachable default database. No production business data was changed for testing. The user elected to continue without a QA login, so authenticated hosted UI behavior is not certified by these local tests. Physical devices and assistive-technology acceptance remain separate.

## Publication

This branch builds on the coordinated Add Lead/Expo/pypdf release at `f9fece11`. The other authorized release chat owns the final combined push, required pre-push performance audit, Vercel candidate/promotion and Render deployment observation. Actual deployed source identities and final checks must be recorded before calling publication complete. Existing GitHub protections remain in force.
