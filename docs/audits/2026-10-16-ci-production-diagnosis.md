# GitHub production delivery diagnosis — 16 October 2026

The latest remote application push is `4710f545ccf677513721ca2b5241e93d729622d7`
on `codex/stability-review-2026-10-12`. At inspection, local commits `38efdd4e`
and `501b5622` had not been pushed. [PR #16](https://github.com/luvop2510/buildconhouse/pull/16)
remains open, blocked and review required. Remote main is `828f86b3`.
GitHub's successful Vercel status belongs to a preview deployment and does not
establish promotion of the customer-facing domain.

## Exact remote failures

[CI run 38780018885](https://github.com/luvop2510/buildconhouse/actions/runs/38780018885)
passed backend unit tests, dependency audit and Docker build. Frontend types,
Expo Doctor, contracts, lint, export and bundle checks passed. Its browser suites
failed with these retained counts: audit 2,155 passed / nine failed / 39 skipped;
responsive 550 passed / two failed / 15 skipped; devices 609 passed / three failed /
16 skipped. Zero flakes were reported and artifact upload succeeded.

Failures were the sanitary list's phone-only 20-pixel gutter assertion applied
at desktop/tablet widths (five cases); downward drag insertion geometry (tablet);
mobile Review button asserted at a desktop builder breakpoint (tablet landscape);
Firefox password validation after a fixture telephone link opened an external
dialer; command palette return focus (WebKit/iPhone); sidebar Space collapse
(two widths); and team drawer return focus (Android/iPhone).
The two newer local commits already contain focused source/harness repairs.
This diagnosis did not remove assertions, expand deadlines or add retries.
The associated [Performance run](https://github.com/luvop2510/buildconhouse/actions/runs/38780018866)
passed for remote source `4710f545`.

The [manual pre-deployment gate](https://github.com/luvop2510/buildconhouse/actions/runs/38716682126)
stopped at the same npm security gate before browser/live storage checks. Missing
browser artifacts were a consequence of that earlier failure, not a storage quota
failure in Actions. The [05:12 IST uptime run](https://github.com/luvop2510/buildconhouse/actions/runs/38825136223)
failed readiness at both origins; see the later R2 recovery audit for the distinct
storage incident and recovered deployment. An old failed uptime run does not
establish present availability.

## Security remains blocking

A fresh current-source `node scripts/check-npm-audit.mjs` still exits one with
22 high / five moderate findings. Fresh GitHub advisory API responses confirm
[braces GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
and [node-forge GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv)
remain active high advisories with no `first_patched_version`. Registry latest
versions are still 3.0.3 and 1.4.0 respectively, both in the affected ranges.
These are inherited through Expo/Metro/Jest tooling. Supported patch upgrades
cannot currently clear these two roots. No waiver, package removal, local fork,
audit suppression or framework major upgrade was made. See the existing
`docs/deployment/security-dependency-review.md` for dependency paths and the
compatibility investigation.

Main's actual protection requires backend, frontend, frontend-security and
performance, strict current-base status, one approving review and administrator
enforcement. PR #16 has no approving reviews. All requirements remain intact.
A deployment candidate or successful preview must not be described as all-green
protected-main acceptance.

## Production workflow repair

Pre-deployment and private backup workflows still selected Supabase after the
production R2 cutover. They now require an explicit production environment
`MEDIA_STORAGE_DRIVER` variable (`supabase` or `r2`) and pass the selected R2
configuration only into the live checks/export steps. Missing/unsupported driver
selection fails before a live operation. Existing hermetic backend tests retain
their inert Supabase fixture configuration.

The private backup source verification now receives the same driver, R2 account
identity and public/private buckets as the exporter. It continues requiring the
independently verified source fingerprint before export and private readback
verification afterward. Full media integrity scans remain required and may report
unrecovered historical files; this change does not waive those failures.
Operations checkouts also disable persisted GitHub credentials. Earlier uncommitted
workflow permissions and canonical-domain probe changes were preserved.

At inspection, GitHub repository secret names, production environment secret names
and production environment variable names all returned empty lists. Therefore these
manual workflows need protected production configuration before their live steps
can run: `MONGO_URL`, `DB_NAME`, `JWT_SECRET`, the chosen storage credentials, and
`MEDIA_STORAGE_DRIVER`; R2 additionally uses `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_API_TOKEN` secrets and `R2_PUBLIC_URL` environment
variable. No credential values were printed and no remote configuration was changed.

## Verification boundaries

All six workflow files parse as YAML. Executable assertions verify live storage
selection, R2 field forwarding, identical fingerprint/export identity, continued
full integrity/readback gates and isolated unit-test storage. Service-health and
uptime failure/redaction contracts pass. `git diff --check` passes.

A focused local regression run against the pre-existing export passed 32 cases
across all eight audit profiles for the gutter, downward drag, palette focus and
password validation failures. The two prior responsive sidebar failures and eight palette/drawer focus cases
across Android Chrome, iPhone/iPad Safari and desktop Firefox also pass (42 total).
These are diagnostic checks of the available export; the final integrated source
still requires its fresh export and complete release acceptance. The security gate
continues to fail honestly.

Independent integration review identified and repaired two migration-tool safety
gaps. Reference planning now enumerates the same ten application collections as
the actual recovery cutover, excluding audit/import/session history. Apply and
rollback validate every journal collection before any mutation. Migration binding
now includes a credential-free fingerprint of Mongo cluster/database plus target
R2 identity; credential rotation preserves identity, while a different cluster or
legacy unbound plan fails before writes. Existing plans are not silently upgraded.
The eight new regression cases failed before the repair and pass afterward;
combined R2 storage/source-binding verification passes 49 hermetic tests. No live
migration command was executed during this review.

The R2 public Worker contract and Ground Floor loading contract (seven cases) are
now included in CI frontend and pre-deployment checks. Both local commands pass;
this does not claim a remote CI rerun.


The independent review also reproduced a password-reset race introduced by
asynchronous login proof: a completed reset could revoke existing sessions while
bcrypt verification was suspended, followed by issuance of a new session from the
old proof. Staff/customer login now inserts its session before a final exact
identity/password-hash read. Stale proof revokes only that new session and issues
no token; a subsequent reset sees the inserted session in normal revocation.
Current active/deleted status, customer portal/expiry and staff MFA settings are
rechecked, and successful responses use current role/floor permissions. Nine
held-proof/MFA regression cases failed before repair and pass afterward; 202
focused auth/MFA/portal/login tests pass. One existing username test now explicitly
requires the final credential-bound read. No session/credential mutations were
performed against production for this validation.

Production promotion additionally requires `scripts/verify-quotation-release.mjs`
after the existing authenticated browser verifier and before invoking Vercel
promotion. It receives the same candidate origin and reviewed full source SHA,
with separate `-quotations.json` evidence when an output base is supplied. It uses
the existing run-owned QA session and optional same-origin preview bypass;
verification must remain read-only. Any failed quotation verification stops
promotion. Guard tests prove verifier ordering, origin/SHA/report forwarding and
fail-closed behavior at every stage. The complete `npm run test:api-proxy`
security/runtime/promotion/cookie contract passes. No live verifier or promotion
was invoked while making this guard change.
