# BuildCon showroom UI

`src/design` owns shared visual tokens and interaction boundaries. Keep the Expo / React Native Web implementation and the existing Feather family. Use real product images and existing document values; keep business calculations in their current modules.

- `tokens.ts`: porcelain canvas, graphite text, action blue, semantic colors, system/Inter typography, spacing, geometry and elevation. `brass*` exports are compatibility aliases for blue; use `accent*` or `action*` in new code.
- `responsive.ts`: 768 / 1024 / 1366 breakpoints and quotation **container** calculations. Do not substitute window width for the quotation workspace's measured width.
- `PageHeader.tsx`, `Screen.tsx`: adaptive page hierarchy. Titles wrap; tablet actions take their own row. Keep one vertical scroll owner per page.
- `controls.tsx`, `forms.tsx`: buttons and labelled fields. Inputs use readable 16px text, associated helper/errors and explicit disabled states; interactive targets are at least 44px.
- `Overlay.tsx`, `useOverlayFocus.ts`: shared modal boundary, focus entry/containment/restoration, Escape, nested-modal background isolation, safe areas and reduced motion. Short phone tasks use sheets; long editors can request fullscreen. `scroll={false}` gives the child ownership of scrolling inside a bounded overlay.
- `NavigationTabs.tsx`, `navigationControls.tsx`: selected semantics, keyboard tabs and menus. Use `navigation.ts` for route labels and destinations; access checks remain in the existing permission helpers.
- `Disclosure.tsx`: optional summaries and secondary form details. Keep field state in the parent so collapsing a section cannot lose input.
- `feedback.tsx`, `ConnectionStatus.tsx`: reduced-motion feedback and connection status. Reconnection never replays mutations.
- `typography.tsx`, `surfaces.tsx`: text, currency, surfaces and status treatments.

`components.tsx` is a public barrel. Existing `src/components/ui.tsx`, `ds.tsx`, `BottomSheet.tsx` and tile layout exports adapt older contracts to these foundations. Migrate callers incrementally without changing their business contracts.

Loading is not empty. A failed request must expose retry; an empty result may offer creation; a filtered-empty result should offer changing filters. Preserve usable sections and entered values during partial failures. Financial and order mutations require an explicit user retry. Do not convert unavailable values to zero.

Use subtle motion and existing reduced-motion hooks. Resting surfaces have borders rather than prominent shadows; elevation is reserved for overlays and raised controls. Existing legacy page styles remain where they carry layout or operational behavior; remove them only with confirmed call-site coverage.
