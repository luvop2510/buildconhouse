# Compact Tiles operations

30 October 2026. Audience: showroom and warehouse staff processing Ground Floor
orders on phones, tablets and desktop browsers. The screen's job is to find a
customer and perform the next recorded material movement. Its distinguishing
element is a compact customer ledger with the same six operational destinations.

## Review and design contract

The previous phone stage grid, stacked history buttons, expanded summaries and
20–32px container spacing displaced customer/product data. This was a hierarchy
and disclosure problem; reducing touch targets would not solve it accessibly.

Reuse the existing system face, Feather icons and semantic roles. On white:
primary #1D1D1F has 16.8:1 contrast, secondary #545458 7.5:1, muted #626267
6.1:1, and action #0066CC 5.6:1. Canvas is #F5F5F7. The app's existing light
theme stays authoritative. Do not introduce an incomplete, Tiles-only dark theme.
Titles use the shared dense 20/28 scale; record names use 15px; supporting
facts 12–13px; labels at least 11px. Inputs stay 16px and touch controls 44px.

Compact and regular views preserve every existing operation:

```text
Phone                          Tablet                         Desktop
Tiles Orders       Excel       Tiles Orders           Excel   Tiles Orders       Excel
[Orders Release Dispatch →]    [All six stage destinations]   [All six destinations]
[search          ][filters]    [search        ][filters]      [search / filters]
Customer · Order →             Customer · order · status →    Customer | Qty | Status
Brand · Products · Qty         three facts across              aligned ledger rows
Status / further details       next record                     next row
```

Order detail keeps customer identity and one Actions menu, with an optional
summary and the brand products beneath it. Release detail uses the same
disclosure and retains the quantity form through acknowledgements. Tablet
records use a three-column fact grid where the actual pane fits; narrow windows
and enlarged type fall back. A phone's page owns vertical scrolling; stage
navigation alone scrolls horizontally. The chosen compact ledger belongs to
this task: no additional dashboard, decorative card or synthetic progress.

## Feedback, export and reliability

Shared busy controls show a spinner and explicit busy/disabled state on every
viewport. Section loading describes the actual operation. Timeline opens
immediately while loading; closing it invalidates late completion. Same-order
refresh retains acknowledged records and fields. Release/movement submission
uses synchronous admission to coalesce repeated taps. Quantity editing waits
for an in-flight release, preventing acknowledgements from clearing newer edits.

Every Tiles stage exports all matching pages, with progress, explicit row limits,
cancellation and existing server export authorization. Detail workbooks contain
the actual section rows. No current-page-only list export is labelled complete.
No new dependency, backend workflow, database migration or stock state is added.

Apple references read: accessibility, layout, typography, color, designing for
iOS, buttons, lists and tables, loading, progress indicators, split views, and
cross-platform translation. `layout.md › Visual hierarchy`: “Order content by
relative importance.” `loading.md › Best practices`: “Show something as soon as
possible.” The React Native disclosure, grid density and spacing choices are
product design judgments. Web and Android retain their own platform behavior.

## Acceptance

Check populated six-stage navigation, compact record visibility, actions,
full filtered export, quantity failure/retry, repeated submission, late timeline
completion, rotation, 320px layout, keyboard focus and zero page overflow. Keep
the existing full performance/stability gate and deployment source checks.
Browser emulation cannot certify a physical OnePlus tablet, iPad or low-end phone.
