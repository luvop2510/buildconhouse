# Mobile workspace headers and navigation — version 1.0.3

The v1.0.2 release was already present on `buildconhouse.in`; users still saw
pinned page titles because shared `AdminPage` and several custom workspaces put
their content header outside the scrolling list. The compact app header was the
only header intended to remain fixed. Filter controls were live and interactive,
but Payments opens with a selected-order detail, hiding the customer queue and
its filters until “Choose customer” is selected.

Version 1.0.3 moves phone page titles and actions into the relevant content
scroll area across shared `AdminPage` pages and custom Customers, Walk-ins,
Payments, Follow-ups, and fully paid orders layouts. The compact app header
remains fixed. Shared layouts retain their breakpoint-specific frame behavior.
Payments and Payment History filter groups retain selections when collapsed.
Summary cards select their corresponding records. Existing removal of the
unneeded Spending and Completed Today summaries remains in effect.

## Verification

- `npx tsc --noEmit` and `npm run lint` passed.
- `npm run test:mobile-ux` passed.
- Payments summary/filter browser cases passed across the configured viewports.
- `test:e2e:stability` executed 560 cases across Android Chrome, iPhone Safari,
  iPad Safari and desktop Chrome. The release coverage verifier accepted all
  560 passes with zero skips, flakes or failures.
- `npm run test:e2e:performance` passed 52/52 cases across Android Chrome,
  iPhone Safari, iPad Safari, and desktop Chrome. The bundle audit covers all
  159 routes at 450 KiB gzip maximum against the 576 KiB limit.

This release changes frontend layout and interactions only; it adds no API,
database or migration changes.
