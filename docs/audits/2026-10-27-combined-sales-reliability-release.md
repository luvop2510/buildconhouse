# Combined Sales Data and reliability release

The user requested publication of the simplified Sales Data experience and three
previously local fixes: stale customer-edit callbacks, truthful Tiles save
acknowledgements, and settled empty/error customer-chooser reads with Retry.

Sales Data is covered by the three-view contract and its dedicated audit. Before
the added reliability slice, the mandatory pre-push audit passed 960 stability
scenarios and 60 timing scenarios over four browser profiles; the 187-page bundle
budget stayed at a maximum 499 KiB gzip under its unchanged 576 KiB ceiling.

Only the three requested local source deltas and their regression tests were
transferred from the original checkout. Three-way conflicts were resolved against
the newer release source. Customer editing retains the current owner-only Manage
customer data workflow; the older checkout's retired direct-delete handler was
not restored. Tiles retains local draft recovery and its distinction between
device-local and server-saved changes. The chooser retains the current web focus
shell while settling an empty or failed source request until a deliberate retry.
Other unfinished edits in the original checkout were preserved.

The combined focused checks passed: 13 customer-edit lifecycle cases, 35 Tiles
save/draft/recovery cases and eight chooser lifecycle cases, plus TypeScript,
zero-warning Expo lint, mobile UX and frontend/page-loading performance contracts.
The new lifecycle cases join the existing page-loading CI command. The full
mandatory pre-push audit runs again for the combined commit; its actual result
belongs in the pull request after completion.

Release target remains the existing Vercel project buildcon-house and domain
buildconhouse.in, backed by the existing Railway service. The observed live
frontend source was 5873a9c023081af18d137d7d699bfb8b10d5cd82, deployment
dpl_382tZRxtYNSHHnRQQfU725VBUwox. The branch preserves that ancestry. GitHub
requires one independent approval plus backend, frontend, frontend-security and
performance checks. Auto-merge uses a merge commit to retain the live ancestry;
it does not waive those requirements. Publication and hosted verification are
pending until the protected-main process completes. No production data writes or
migrations were performed by this work.
