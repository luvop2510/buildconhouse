# Ground Floor completion — 30 October 2026

## Behavior and design

This pass starts at remote main 1377ba69, also verified as the canonical live
Vercel source. Unrelated customer/PDF/image/keyboard edits in the local checkout
are preserved in the named Git stash `preserve pre-existing local edits before
ground-floor main sync 2026-10-30`; additional image source files are copied to
the private parent workspace evidence folder. They are not part of this release.

Ground retains the established direct Selection → Quotation → Place Order flow.
Approval is already retired for new tile documents; historical approvals remain
readable and show Approved rather than Draft. Completed includes approved and
ordered documents and excludes Lost. Sanitary keeps its existing approval and
supplier-admission rules. Approval never fabricates an order.

Named saved Ground selections and quotations now produce follow-ups even before
products are added. Approved unplaced quotations also remain eligible. A Lost
action on a linked Ground/Sanitary follow-up records the quotation outcome and
closes its sibling reminders atomically, preserving commercial/document history.
An ordered/won quotation cannot become Lost through this path; stale follow-up
snapshots fail explicitly. A Lost/closed quotation cannot place an order.
Unlinked manual leads do not rewrite every quotation for that customer.

Tile and Sanitary lists use 30 summary records plus a next-page sentinel, with
server search over all matching saved documents. Failed pages retain their
existing rows and retry the same offset; obsolete lifecycle/search/account reads
cannot publish. Ground's two document types still start independently. Standard
quotation rows have less empty spacing and show explicitly loaded-record totals,
avoiding presenting a page subtotal as the entire pipeline.

The design uses the shared system font, neutral surfaces and blue action tokens;
no separate palette or appearance switch is introduced. Primary #1D1D1F,
secondary #545458 and action #0066CC on white retain the canonical approximately
16.8:1, 7.6:1 and 5.57:1 contrast. The studio judgment is a quiet showroom
worksheet: product identity and editable quantities take priority over photos.

Compact layout:

```text
320px                         390px
[customer details]            [customer details]
[88px photo | product]        [88px photo | product]
[area / room          ]       [area / room          ]
[size                 ]       [size       ][rate    ]
[rate                 ]       [box rate   ][quantity]
```

Measured same-fixture row heights on Chromium:

| Row | 320px before → after | 390px before → after |
| --- | --- | --- |
| Selection | 516 → 397px | 560 → 318px |
| Quotation | 880 → 761px | 924 → 534px |

The 390px quotation row is 42% shorter and selection 43% shorter. The change
reduces photo/empty layout space while keeping 16px inputs, 12px metadata and
44px controls. At enlarged native text scale, short fields return to one column.
Customer phone/name and area fields retain full width. Shared keyboard/dock fixes
from 1377ba69 stay intact; new tests exercise actual quantity/rate fields as well
as address, with the same focused node/value and anchored document scroll.

Apple principles are translated to React Native/Web, not native-platform
certification. References read by the UI reviewer include `layout.md › Visual
hierarchy`, `typography.md › Ensuring legibility`, `accessibility.md › Mobility`,
`virtual-keyboards.md › Mobile`, plus the skill's cross-platform guidance.
The existing single scroll owner and progressively disclosed filters/details are
retained. No new motion or dependency is needed. Shared dark appearance is not
implemented or claimed by this change.

## API, cache, migration and security

[The API audit](2026-10-30-ground-api-performance.md) records the complete focused
findings, query-plan fixture and cache/configuration boundaries. List summary
JSON falls 155,457 → 8,393 bytes (94.6% less) for identical 31 synthetic records.
The exact stable-order index fixture reduces 2,400 examined documents to 62;
migration 0042 adds only that nonunique index. These are local measurements,
not promised production response times. Existing Tile Orders pagination,
Ground's bounded navigation cache, invalidation and account/floor boundaries
were verified; no extra long-lived financial or permission cache was added.

The decoder is pinned to the published 0.5.1 patch for
[GHSA-qr28-fpjm-wq7f](https://github.com/SamVerschueren/decode-uri-component/security/advisories/GHSA-qr28-fpjm-wq7f).
The regression includes the maintainer's full 32,000-distinct-run malformed input
behind a five-second child-process deadline and exercises the actual Router
consumer. Query Unicode/repeated-value/malformed-input compatibility passes.
Clean npm installation succeeds; audit reports eight low findings and zero
moderate/high/critical. No credential values are logged, changed or committed.
Existing production Mongo, index and R2 access preflight passes using Railway's
exact project/service/environment variables; 0042 awaits the controlled runner.

## Verification and release ledger

- TypeScript and zero-warning Expo lint pass.
- Full hermetic backend unit suite: 4,005 passed, one existing Starlette warning.
- Run-owned Mongo replica: three integration cases pass, including actual HTTP
  summary projection/search/page ties, Lost classification, rollback after an
  injected mid-transaction failure, draft recovery and repeated order placement
  producing one quotation/order/payment chain.
- Frontend hook regressions: three Sanitary paging races and 44 Ground list/draft
  cases pass; the broader page-loading command passes 58 cases.
- UI reviewer: 16 density/keyboard cases pass in Chromium/WebKit. Draft/tablet
  focused checks pass eight relevant cases, with four existing tablet-only skips
  in that auxiliary run; these skips are not full release acceptance.
- The first full audit stopped before scenarios because port 8099 was already
  occupied by another process. An intermediate run passed 155 scenarios before
  deliberate interruption for the final account/read guard. The final pre-push
  gate uses free ports and the unchanged complete suite, concurrency, deadlines
  and zero retries; it remains pending.
- Focused browser review caught the competing automatic/manual paging trigger on
  Safari; the automatic trigger was removed so the visible load-more control
  remains a stable action. Final rebuilt regression passes all 48 cases on desktop Chromium, phone Chromium and phone WebKit, including 320px/390px density, quantity/address focus and paging past record 100.
- Backend pip-audit reports no known vulnerabilities.

At source freeze, publication has not yet been claimed. Final provider/runtime evidence is retained in the parent workspace `outputs/ground-floor-2026-10-30/` release receipt. GitHub push, controlled index application,
Vercel canonical alias and Railway runtime/source verification are separate
outcomes, to be recorded only after they succeed. Retain rollback deployments
Vercel dpl_beJ32M9Hd5Gp8x9Eh2H8f2BppCxx and Railway
08f15898-1189-4ce8-b2c6-e23af5ee202a. Physical Android/iOS keyboards and signed
native rebuilds remain outside the available browser/device evidence.

## Safari CI compatibility follow-up

Release 14b2b82c passed the complete local gate and was published to both
providers, with 18 public, 20 authenticated, six Ground browser and 12 API checks.
The independent Linux timing job then failed 12 WebKit cases solely on the
browser diagnostic `Viewport argument key "interactive-widget" not recognized
and ignored.` Its 48 remaining cases passed. This was not a timing-budget failure.
The original CI report and logs are preserved in the parent release evidence.

Static viewport HTML now contains only the shared supported policy. The existing
blocking bootstrap adds `interactive-widget=resizes-content` only when the
VirtualKeyboard API and dynamic viewport units are both present. Chromium's
layout-resize policy and dynamic units shipped in
[Chrome 108](https://developer.chrome.com/blog/new-in-chrome-108); its
[keyboard viewport behavior](https://developer.chrome.com/blog/viewport-resize-behavior/)
explains the opt-in. Older Safari retains the existing visual-viewport hook, with
no unsupported initial HTML directive. Native Android resize is unchanged.

Executable bootstrap cases cover supported Chromium, older Chromium, Safari and
an explicit existing viewport policy. The existing startup browser case now
asserts the actual capability-dependent policy and zero console errors. No
console filters, deadlines, retries or timing assertions were relaxed. Backend
source and migration are unchanged by this compatibility correction.
