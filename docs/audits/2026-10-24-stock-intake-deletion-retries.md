# Stock intake and customer deletion retry recovery

## Direct stock intake

Previously, every direct-intake POST inserted a fresh lot. A lost response after insertion followed by manual retry could add the quantity twice. The current browser/native screen sends one UUID per submitted payload and retains it when the same mounted form is retried. A synchronous pending guard rejects another submit while the first is active. Requests explicitly carry the captured floor. Confirmed success clears the command so a subsequent intentional intake gets a new identity.

The server hashes actor, request floor and command key into a unique Mongo `_id`. The lot and its request fingerprint are inserted together as one atomic document. A repeated command returns the recorded lot's current balance without restoring consumed units. Concurrent insertion collisions resolve through that same receipt. A changed payload using the same key returns 409. Archived lots retain the receipt and cannot be recreated by replay. Private receipt metadata is excluded from public stock views. Quantity and price reject non-finite inputs.

No new collection/index or migration is required: this uses Mongo's existing unique `_id`. Legacy clients may omit the optional key during rollout and retain their old behavior. Protection requires the updated client/backend pair. The client currently retains pending commands in memory, so this does not claim restoration of a pending form across full reload, closing the application or a different device. Server replay remains durable when the original key is supplied. Activity logging remains the existing best-effort timeline path; the atomic lot receipt records the business result even if the response or later timeline log is lost.

The intake toggle now has an explicit accessible label. The first new browser check could not locate its exact name because the decorative icon had been included in it. The failed run is retained outside the repository; it is not publication acceptance. One surrounding case also ran while export artifacts were being rebuilt. The final 33-case run used a completed fresh export throughout and passed without retries or increased deadlines.

## Customer deletion

The backend already stores a transactional deletion receipt. The dialog previously discarded its confirmation on every failure, including timeout and network errors. After a committed deletion with a lost response, a replacement preview could only find a missing customer.

The dialog now preserves its exact reviewed confirmation and selected Furniture identities on transport/408/server failures. It explains that completion is unknown and offers “Retry confirmed deletion”. Furniture selections are disabled during deletion and while the result is uncertain, keeping the original reviewed command intact. The retry invokes the existing receipt-aware backend and can either resolve a committed result or execute the still-authorized original deletion. Authoritative rejection/conflict still clears the preview and requires a new explicit review. Owner authorization and graph-deletion transaction semantics are unchanged.

This is recovery while the dialog is mounted. Cross-reload restoration/status lookup remains outside this change. No real customer deletion was performed in testing.

## Verification

- 90 focused backend cases pass for direct intake, purchase-to-stock intake, stock details, customer stock transfers and workbook replacement.
- 28 customer cleanup unit cases pass. All backend cases use explicit hermetic CI settings, current `kitchen-audit` source and the existing `forge2.0/backend/.venv/bin/python` interpreter.
- Backend tests cover repeated/concurrent command insertion, changed payload, actor/floor separation, uncertain insertion response, consumed balance preservation, archived receipts and finite quantities/prices. These tests use fake collections; no real Mongo failover or cluster concurrency drill is claimed.
- All 33 stock editor and customer deletion browser cases pass at desktop/tablet/phone widths with two workers and zero retries. New cases prove identical intake keys on retry, a fresh key after confirmed success, exact deletion confirmation reuse after lost response and fresh confirmation after conflict. Existing price/image upload, large-list search, unknown quantity, quotation handoff and linked Furniture deletion cases pass.
- Nine stock hook recovery/race cases and three purchase floor-race cases pass.
- TypeScript, focused ESLint, fresh web export and all 187 unchanged route bundle budgets pass. The largest page remains 480 KiB gzip under the 576 KiB limit. These checks do not substitute for the complete publication performance audit or live all-floor measurements.

The audit server rejects unintercepted API calls. The local package uses `https://audit.invalid` as its worker upstream and must not be deployed. No production imports, customer changes, data migrations or deployment were performed.

## Remaining goal scope

Purchase stage movements subsequently received local replay protection and disposable-Mongo/browser verification; see `2026-10-24-purchase-movement-retries.md`. Purchase-to-godown intake and other operational mutations still need review. Stock list/history transport still needs paging and performance measurement. Quantity correction and workbook reconciliation await unit/as-of definitions and confirmed counts for missing quantities. Image ownership review and complete photo coverage remain unresolved. The broader stock redesign and live acceptance are not complete.
