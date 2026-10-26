# Purchase stage movement retry safety

## Failure and resulting behavior

A partial movement splits the original PO item and leaves its remainder at the original stage. Previously, replaying a completed “move 3 of 10” request could split three more units from the remaining seven. Optimistic-concurrency retry alone did not identify an already-applied command. A failure during the later PO status refresh could also report failure after the quantity update had committed.

The shared movement sheet now sends an idempotency key and retains it when an unchanged mounted form is retried. It synchronously prevents duplicate submits, keeps drafts across same-item refreshes, ignores old async completion when the active command changes, and prevents manual dialog dismissal during submission. A pending original command may still be resolved if a refresh shows a lower remaining quantity. The server remains the authority for all new movement validation.

The move API stores a receipt in the parent purchase order in the same atomic document update as the full move or partial split. Receipt keys bind actor, item and command identity, and lookup remains floor scoped. A compare-and-set condition also requires that receipt to be absent. Concurrent repeated requests therefore resolve to one movement and one child item. Different details using the same command are rejected. Even a no-change command records its result, so replay cannot move a later changed item back to an earlier stage.

Receipt replay preserves the original result and repairs post-write PO status synchronization without splitting or moving again. Existing loan replenishment processing remains guarded by its own reservation counters and current In Box state. The stock mutation and receipt do not require a new collection, index or migration.

The error now appears as a persistent alert inside the movement dialog. The first screenshot review showed that the former toast could render behind the modal scrim, hiding the reason an action appeared not to work. The inline alert keeps the quantity, stage and retry control visible. Existing application tokens and dialog composition are retained; no visual direction redraw or broad redesign is claimed.

## Verification

- 35 existing unit cases pass for purchase movement concurrency, bulk movement, completion stages and warehouse permissions.
- All 20 disposable local MongoDB integration cases pass in `test_purchase_completion_mongo.py`. Four new cases prove real Mongo single-document receipt/split atomicity, concurrent full/partial replay, changed-payload rejection, foreign-floor exclusion, recovery after a post-write status failure, and no-change replay after later item movement. The concurrent cases call the actual route function with its parsed MoveBody.
- The first integration attempt passed the two concurrent cases but failed the other two because their fixtures created a new randomly identified actor on each retry. Those fixtures now retain one actor, matching the real signed-in retry contract. A targeted rerun passes all four, followed by the complete 20-case run. The route-wiring refinement also passes all four targeted cases.
- All 30 final browser checks pass across desktop, tablet and phone, with two workers, zero retries and unchanged timeouts. They include partial-move timeout/retry, current customer-rail refresh, purchase/customer/quotation completion views and standard/tile saved-editor completion. The new case verifies identical command bodies/keys after a lost response, retained quantity and the visible inline error.
- Final screenshots for all three widths were opened after the inline-error change. The alert is visible above the product/quantity; the primary action stays reachable. Synthetic stage labels in fixtures are not production content. Broader visual inspection/scoring is not claimed.
- TypeScript, focused ESLint and purchase API/mobile contracts pass. All 187 current web routes satisfy the unchanged 576 KiB gzip budget; the largest is 483 KiB. The web export is a local fixture package with `https://audit.invalid` worker upstream and must not be deployed.

Mongo tests launch an isolated local process and use disposable databases. All backend settings are explicit hermetic CI values. No production purchase, stock, customer or deployment changes were made. These tests do not establish real-device or hosted-network performance.

## Boundaries and remaining work

The new key is optional for compatibility with older clients. Only keyed requests have this replay guarantee. The updated UI retains its retry identity while mounted; full-reload or cross-device pending-command restoration remains open. Timeline logging remains best effort, while the movement receipt and existing stage history establish the committed business result.

This repair covers purchase stage movements. Purchase-to-godown intake, other operational mutations and their recovery semantics still need review. Stock pagination/history loading, all-floor live timing, quantity correction, physical/source reconciliation, complete verified image coverage and publication acceptance remain open.
