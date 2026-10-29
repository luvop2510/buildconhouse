# Tiles responsive workspace — 30 October 2026

Ground Floor staff now reach all six existing order views through one 44px
horizontal stage strip. The selected destination scrolls into view, including
direct links. Search remains immediately available; secondary filters disclose
without losing their selections. Phone records use a compact ledger; tablets
place customer identity beside operational facts; desktop retains its table.
No workflow stage, order, stock quantity or backend authorization is rewritten.

Customer detail uses an Actions menu for timeline, registry and dispatch
navigation. Order/release summaries expand on demand. Shared Tiles spacing and
buttons are smaller, while labels, 16px inputs and 44px targets remain readable.
The remaining admin full-width button instances were reviewed: walk-in intake,
notebook creation, customer editing, password editing and Team actions now use
content-sized buttons. Bounded filter fields and modal choices retain their
existing grouping.

Shared loading controls expose visible spinners and accessible busy/disabled
state on phone, tablet and desktop. Timeline opens immediately with status and
rejects late completion after closing. Current-order refresh preserves mounted
records and inputs. Synchronous release/movement/dispatch admission coalesces
repeated taps. Release failures retain quantities; pending acknowledgements
cannot clear newly entered quantities. Scoped detail reads and post-write
callbacks reject obsolete routes. Dispatch saves retain their record while
refreshing and cannot be dismissed mid-write.

Excel uses the existing authorized workbook endpoint and explicit section data.
All six Tiles queues collect every matching page rather than the visible page.
Order, brand and release details have exports. Walk-ins, Kitchen project/stage
queues and the owner Team directory use the same busy/cancellation control.
Existing reports and analytics keep their section exports. Export progress
reports actual rows read; changed counts, invalid paging and explicit ceilings
fail without a partial download. Limits: 4,999 exported records, the Walk-ins
2,000-record read ceiling, and Team's 200-member ceiling. Existing cell limits
also fail visibly. Team exports whitelist directory fields and exclude secrets.

## Evidence at source freeze

TypeScript, zero-warning focused ESLint, the Tiles workflow contract, mobile UX,
table layout/keyboard contracts, section Excel transport and new export hook/
paging tests pass. The new export hook test runs under the existing CI
`test:section-excel` command. Kitchen commercial, Team contact and Walk-in
intake contracts pass. No dependency or database migration is added.

The immutable populated browser pass has 160 successful cases across desktop,
phone, 320px phone, tablet portrait/boundary/landscape, Firefox and WebKit, with
zero skipped/failed/flaky cases. Fourteen additional tablet-workspace checks
pass across seven widths. A later scoped Dispatch record guard has separate
movement/dispatch verification: 24/24 cases pass across all eight browser
profiles, including undiscarded pending dispatch writes and obsolete reads. The
final release gate rebuilds all source.

Measured customer geometry in the tested fixture:

| Viewport | Row height | Fully visible rows | Stage navigation |
| --- | ---: | ---: | ---: |
| Phone 390 × 844 | 93px | 5 | 44px |
| Phone 320 × 740 | 113px | 3 | 44px |
| Tablet 834 × 1112 | 88px | 8 | 44px |
| Tablet landscape 1024 × 768 | 88px | 4 | 44px |
| Desktop 1440 × 1000 | 60px | 9 | 44px |

The phone Chromium/WebKit and tablet/desktop screenshots were inspected; no
page overflow or clipped customer facts was observed. These are synthetic
browser measurements, not a physical hardware performance certificate.

One old tile-editor retry fixture failed on unchanged main too: it omitted
customer-query interception and waited for autosave while the customer lookup
was still focused. The fixture now completes the edit before asserting a real
failed autosave/retry. Production editor behavior is unchanged.

## Publication evidence

Before publication the canonical Vercel alias is verified at main a087b6c2;
Railway's 324 runtime source hashes match main, Mongo/storage readiness passes,
and no migration is pending. The final main push runs the unchanged mandatory
performance/stability audit. Final GitHub SHA, provider deployments, source
identities, hosted read-only geometry/runtime checks and QA session revocation
are recorded in the parent workspace's
`outputs/tiles-responsive-release-2026-10-30/` receipt after they succeed.
Publication is not claimed solely from this source document.

Physical OnePlus/iPad/low-end Android devices and signed native builds are not
available in this workspace. The existing privacy, floor, permission, stock and
transaction boundaries remain authoritative.
