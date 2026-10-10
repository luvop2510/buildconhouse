# Customer reset and quotation release — 10 October 2026

The owner authorized deleting customers and transaction records on every floor while retaining all products, images, suppliers, staff accounts and operational configuration. The Emergent address was deferred; this release updates the verified GitHub/Vercel/Railway application and documents the later Emergent handoff.

## Active data reset

The Railway project was verified in the owner's signed-in Brave Work profile. Its production runtime created the one-time `customer-reset-20261010` receipt in `buildcon_house`, establishing that the inspected database is the deployment's actual source. Maintenance was deployed first; business API requests returned 503 and background customer writers paused. The reset transaction then removed 180 customers, 161 quotations, 26 customer orders, 110 walk-ins, 680 follow-ups, 83 payments, 106 customer purchase orders, 42 ready batches, 47 dispatches, 47 chalans, 167 material movements, three shortages, nine purchase transfers and four customer stock transfers. Customer outbox events and 2,210 customer activity records were removed. Existing sessions were closed while staff accounts and credentials remained intact.

Residual review identified one historical stock notification containing a customer attribution and balance. Its writer was positively identified from the stock-transfer source; the notification was removed in a guarded transaction and the receipt updated to 93 notifications deleted. The reset now recognizes customer stock notice sources even when the original contact has already been deleted or its company/alias differs from its name; a regression preserves unrelated stock alerts.

All 13 customer workflow collections are empty. Customer-linked purchase orders and movements, stock customer references and notifications are also absent. Seven warehouse stock records remain; six customer provenance snapshots were anonymized. The remaining 9,505 activity records were classified against staff/product writer patterns, and nested operational/reference scans found no further customer snapshots. No new customer backup was made. Historical private backup retention is a separate procedure; offline client drafts are removed on their next launch of the updated client.

All **20 protected collections match their pre-reset BSON SHA-256 fingerprints and counts exactly**, excluding the new count-only reset receipt from settings. This includes 6,565 products, 8,489 media entries, catalog image bytes/import history, brands, categories, suppliers, staff, floors, counters, settings and operational reference data. Public catalog storage was never mutated. The read-only verification needed a smaller cursor batch after a large-batch timeout; that was a verification transport issue, not a database reset failure.

The reset release succeeded as Railway deployment `fcfc31ed-305b-4ab0-9b44-08f4a032a1a8`. The reset request is cleared and maintenance disabled for normal operation. The final production deployment identifiers and post-startup counts are captured in the local release evidence, without customer identities or secrets.

## Quotation and viewport behavior

Tablet navigation uses a labelled, persistent collapsible sidebar with staff/workspace information. Tile Orders uses usable content width for readable record/table layouts, wrapped controls and compact queues. Final review corrected duplicate navigation highlighting and oversized portrait-tablet builder thumbnails; the latter stay at 144 × 90px beside editable fields when sufficient workspace is available.

Quotation detail and sanitary/tiles builders expose **WhatsApp draft**. The editable greeting defaults to “Hey [Customer Name], here is your quotation.” It uses the current stored contact phone and a private PDF snapshot link with a 24-hour lifetime and explicit revocation. Preparing/opening a draft does not mark the document sent. WhatsApp deep links cannot attach binary files or confirm delivery; the sheet also offers PDF download for manual attachment. Automatic document delivery and delivery webhooks require a separate WhatsApp Business integration.

Sanitary, second-floor, tiles quotation and selection PDFs embed a pale RGB diagonal watermark on every page, including covers and continuation pages. It uses printable image content rather than alpha/background effects. Synthetic multi-page PDFs and grayscale rendering were checked; physical printer/device acceptance remains an operator check.

## Verification

- Backend full unit suite: **1,795 passed** before the final historical-stock-notice regression; the final reset suite then passed **9/9**. No unit test connected to production.
- Broad final-export UI review: **513 passed, 13 conditional skips**, with two portrait-tablet image-size findings. Those findings were fixed in source and the unchanged targeted suite passed **18 cases with six conditional skips** across six sizes. Its tile WhatsApp cases passed all six sizes; unrelated routes were not needlessly repeated.
- WhatsApp acceptance: **30 passed** across 320, 390, 768, 1024, 1280 and 1440px. Tablet workspace/client cleanup acceptance and the final navigation correction are documented in the adjacent tablet audit.
- Five actual-source draft cleanup tests, 44 auth race/lifecycle tests, TypeScript, zero-warning Expo lint, API proxy/WhatsApp/mobile UX/performance contracts, production web export and route budgets passed. Print watermark/PDF checks passed 93 targeted tests.

The previous responsive pass was retained in its own honestly labelled commit. Current dependency/security, historical media gaps, signed native builds and physical devices remain separate findings; local functional acceptance does not certify those gates or claim that all GitHub jobs are green.

See [the Emergent migration procedure](../deployment/customer-reset-and-emergent-migration.md) for API routing, secrets/MFA, Atlas access/transactions/indexes, storage migration, driver migration and cutover/rollback requirements. The destination URL and database identity must be verified when the owner supplies them.
