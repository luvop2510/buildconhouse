# Customer reset and Emergent handoff — 10 October 2026

The owner explicitly authorized deleting customers and their transaction records across all floors, while keeping the entire catalog (product details and images), suppliers, staff and operational configuration. This is a customer reset, not an empty database or a catalog reset.

## Controlled reset

`services/customer_data_reset.py` is a one-time operator procedure, separate from schema migrations and disabled by default. It requires the exact request `customer-reset-20261010` and maintenance mode. A durable receipt in `settings` prevents replay from deleting newly entered customers.

1. Deploy the reviewed code with `FORGE_CUSTOMER_RESET_MAINTENANCE=true` and no reset request. Verify the new deployment is settled and `/api/customers` returns the maintenance 503. Health/readiness remain available. Outbox dispatch and follow-up reconciliation are paused. Wait for all prior deployments/writers to stop; an independent Emergent writer must also be paused if it shares the database.
2. Set `FORGE_CUSTOMER_RESET_REQUEST=customer-reset-20261010` and deploy again. Startup clears customer workflows in one MongoDB snapshot transaction with majority writes. Customer-linked purchase orders are removed; unrelated replenishment orders are preserved. Warehouse stock retains products, images and numeric accounting while customer provenance is removed. Existing sessions and relevant download tokens are revoked by deletion; staff accounts, passwords and MFA enrollment remain intact. Staff sign in again with the updated client so stale open editors cannot re-save removed customer snapshots. Queued customer events are deleted so automation cannot recreate the records.
3. Private purchase attachments and quotation-share PDF snapshots are deleted after the MongoDB commit. The receipt stores pending keys until cleanup succeeds, making a failed storage cleanup retryable. Public catalog storage is never mutated. Private historical backup retention is separate from active application data; existing backups are not silently erased or newly created by this reset.
4. Verify all customer workflow collections are empty, inspect residual customer references, and compare protected collection fingerprints/counts. Catalog objects, staff, suppliers, settings and reference data must remain intact. Receipts contain counts, not customer names, phones or addresses. Do not log the pending storage keys.
The updated client also clears indexed and orphan quotation draft blobs, including the legacy snapshot, once per device at startup. Favourites, sidebar preferences and credentials are preserved. Offline devices clear these blobs when they next load the updated app; server deletion cannot erase offline device storage remotely.

5. Clear the reset request and set maintenance to false, deploy, and verify readiness plus restored API availability. Do not leave a reset request active when maintenance is false. Check once more after startup reconciliation has finished.

A reset requires a brief service maintenance window. The one-time receipt is not a backup and cannot restore deleted data. Never change the request ID to rerun the procedure casually. This implementation only manages this application's verified runtime; separate writers must be identified before reusing it elsewhere.

## Emergent handoff

The checked-out application already uses FastAPI, MongoDB Atlas and Supabase. The root Expo application is the maintained frontend; the ignored `frontend/` directory is historical. The verified GitHub main branch feeds Railway (`/backend`) and Vercel (`.`). The owner has deferred providing the Emergent URL, so no Emergent deployment or database equivalence is claimed.

Before the Emergent cutover:

- Provide its frontend/backend URLs and identify which database and storage buckets it uses. Decide whether Emergent will serve both frontend and API or continue using the existing Railway API. Keep only one authoritative production writer during cutover.
- Import the exact reviewed GitHub revision. Build from the root Expo app and preserve the same-origin `/api` proxy, cookie/session and CSRF behavior. Native clients have a separate `EXPO_PUBLIC_BACKEND_URL` setting. Configure `BACKEND_URL` server-side for the web proxy; never expose MongoDB or service-role credentials in the client.
- Configure deployment secrets outside preview `.env` files: Mongo URI/database, JWT secret, stable MFA encryption key, production mode/demo-seed disabled, Supabase URL/keys/buckets. Preserve staff credentials and MFA enrollment. Verify Atlas network access and compatible runtime/system font/PDF dependencies.
- If changing MongoDB, provision all required collections/indexes and run the migration dry-run, controlled migrations and read-only predeploy gate before routing traffic. Preserve string identifiers, floor IDs, Decimal/money conventions, BSON dates and indexes. Do not replace IDs with ObjectIds without changing API contracts.
- MongoDB transactions require a replica set or supported cluster. A standalone local MongoDB instance is insufficient for transactional orders/transfers and the reset. Keep pool/timeouts bounded and verify every floor's authorization against the new runtime.
- Keep public product media and private customer documents/backups in separate buckets. Preserving DB image URLs alone does not migrate file bytes. Verify representative image downloads and private document links after cutover, including CORS and expiry. The current application explicitly requires the Supabase driver; another storage service needs a driver implementation and tests.
- Run browser acceptance at phone/tablet/desktop sizes, API/floor/role regressions, multi-page quotation printing and WhatsApp drafts against isolated synthetic data. Physical iOS/Android sharing and printer behavior need device/operator verification.
- Record Git revision, immutable deployment IDs, readiness, source identity, recovery ownership and rollback target. Roll back application routing without replaying customer-deletion requests or restoring removed customer data unintentionally.

See `backend/OPERATOR_CHECKLIST.md` for runtime/migration procedures and `docs/deployment/recovery-and-regional-acceptance.md` for operational recovery. Existing dependency/security and device-signing findings remain separate release concerns; this handoff does not claim they are resolved.

MongoDB's official [PyMongo Async migration guide](https://www.mongodb.com/docs/languages/python/pymongo-driver/current/reference/migration/) recommends moving from Motor to `AsyncMongoClient`. Plan that as a separately tested dependency/API migration: session creation and cursor behaviors differ, and this release intentionally retains the working driver. Emergent's [deployment troubleshooting](https://help.emergent.sh/deployment-issues) describes checking production environment variables and adding the platform's current outbound addresses to an Atlas allowlist. Use its current [secrets guidance](https://help.emergent.sh/secrets-env-variables) when configuring the destination project, then republish and verify the actual production configuration.
