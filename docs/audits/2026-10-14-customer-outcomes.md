# Historical customer outcomes — 14 October 2026

The ten supplied source workbooks retain ten standard quotations and eight
customer identities: the first three source customers are Lost and the remaining
five customer identities retain seven Won quotations. Separate brand workbooks
stay separate quotations. The user explicitly confirmed one shared-phone source
as a separate customer; no existing profile was merged or renamed.

`customer_outcome` records historical Won/Lost independently of the quotation's
commercial workflow status. These imports do not assert a new financial order,
supplier purchase or received payment. Closed follow-ups group each customer's
brand quotations, retain source dates/references/total values, and belong to the
import actor. Lost reasons accurately record the owner's classification without
inventing a detailed reason. Ordinary edits preserve outcomes, Duplicate starts
a fresh unclassified draft, and PDF generation and reconciliation do not reopen
historical leads. Place Order requires a fresh quotation.

Quotation lists and the builder expose **Lost Customer** and **Won Customer**
views. Their floor-scoped compact queries include historical outcomes and
ordinary committed orders where applicable. The pending query excludes terminal
historical outcomes. Builder tabs load bounded summaries, handle retry, and discard
obsolete responses after floor or tab changes.

The source audit covers all 263 commercial lines. Numeric source offer rates,
worksheet dates, room/area ordering, descriptions, contacts, source references,
original cells/formulas and cover differences remain preserved. One invalid
Excel offer remains explicitly rate pending. Seven exact reviewed SKU aliases
retain existing catalog identities. Two absent source products use their original
workbook photos, with byte-identical storage readback: a manufacturer-verified
urinal and a drain with unspecified manufacturer. No manufacturer is guessed.

The reviewed importer defaults to a read-only plan and requires the exact source
and manifest hashes plus production database identity to apply. Fixed recorded
outcome timestamps make dry-run/apply fingerprints stable. Existing same-phone
conflicts require exact reviewed conflicting identities and a recorded decision.
Apply backs up affected collections and commits quotation/customer/follow-up/
media/activity/receipt documents atomically. Receipt replay verifies original
document fingerprints and refuses changed or missing records. Private source,
contact, price, backup and reconciliation artifacts stay outside Git and build
contexts.

Validation: 2,446 hermetic backend unit tests pass; the final focused importer/
outcome/filter suite passes all 65 cases. TypeScript, scoped zero-warning lint
and quotation contracts pass. The final quotation browser suite passes all
64 cases across eight viewport/browser projects, with no skips, failures or
flakes. The mandatory pre-push audit rebuilt the isolated release source and
passed all 48 performance cases and all 159 page bundle budgets without retries
or relaxed limits. Mongo/index/storage readiness passes, with no pending
migrations.

The atomic production import completed and verified its 57-document receipt.
GitHub contains runtime commit `54b4feacdd1938a08fed8e6da02492062bded7dc`.
Railway deployment `2e187639-f2a5-41bd-afa1-97a3480053e2` is SUCCESS and
returns HTTP 200 readiness. Its 299-file upload was checked byte for byte against
that commit; provider metadata confirms one always-running Singapore replica.
The frontend publishing step initially exposed a configured Git author email
that differs from the authenticated publishing account. This documentation
commit uses that account's verified identity, preserving code history and
project permissions. Existing required security findings and protected-main
review remain independent of these passing functional checks.
