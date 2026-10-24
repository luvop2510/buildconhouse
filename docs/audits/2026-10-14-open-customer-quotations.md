# Open customer quotations imported — 14 October 2026

Fourteen supplied workbooks were imported into The Sanitary Bathroom quotation
workspace as standard draft quotations. The batch contains twelve customer
identities, 370 quantified product lines and 730 source units. Eleven profiles
were created; one existing profile was reused through an explicitly reviewed
same-phone identity. Two customers each retain their separate brand quotations.
The five source-referred quotations share three interior-designer directory
entries, as confirmed by the user.

The user explicitly instructed the import to retain whatever data is present in
the Excel files. Numeric source offer rates remain authoritative, including
offers above MRP. Six missing or invalid offer rates are represented by zero
pending rates with explicit line and quotation notes. These are not confirmed
free items. Three broken line totals are calculated from an intact source
quantity and numeric offer. Conflicting cover offers remain visible notes;
no additional discount was invented. Ten selections without quantities or
prices remain in the quotation notes and original source metadata. Source
dates, room/area order, contact/reference snapshots, original descriptions,
commercial terms, cell values/formulas and cached values are preserved.

Three missing catalog products were added with verified exact source photos:
a supplied V-Care package, an AXOR One Brushed Bronze porter variant and an
S20 urinal. Four storage objects were uploaded and their bytes read back before
the atomic import registered media metadata. Existing exact and reviewed regional
SKU aliases retain their real catalog IDs. Source SKU spellings remain in line
snapshots. The package's uncertain component spelling was not silently corrected.
No existing catalog product was edited or given a substituted finish photograph.

`backend/scripts/import_customer_quotations.py` defaults to a read-only plan.
Apply requires the reviewed source/manifest hashes and exact production database
identity, captures private affected-collection backups, and commits a single
transaction with deterministic document IDs and a verified receipt. It never
places orders, creates purchase/payment records, closes follow-ups, sends
messages or applies migrations. A repeat dry-run verifies every receipt document
and reports already applied. Business data and private extraction/backup/source
artifacts remain outside Git and provider build contexts.

Independent production readback verified all fourteen quotation/source hashes,
all 370 rows and original snapshots, customer/phone/date/interior attribution,
room/area order, quantities, MRPs, effective offer rates, pending-rate notes,
cover conflicts and independently calculated totals. It checked all ten
unquantified notes, all three added products and four public media checksums,
and hydrated product-photo binding. All 3,808 existing Sanitary catalog documents
and existing quotations remain unchanged. Full pre-import purchase, payment and
customer-order documents and counts remain unchanged. Every imported quotation
is returned by the application's actual standard/pending/completion-active
Open Customers query. All fourteen were also visible in the hosted quotation
list after reopening the browser tab.

Validation: 2,416 hermetic backend unit tests passed, and all 34 focused tests
covering the final quotation importer and prior order importer passed. Read-only
Mongo/index/Supabase preflight passed; migration dry-run found no pending changes.

The first performance audit passed 46 of 48 browser cases, failing two iPad
checks. Preserved traces show mocked 200 ms identity reads taking about 2.7–3.2
seconds in one failure and a 4.7-second builder sample in the other. A fresh full
current-source audit passed all 48 cases, zero failures/flakes/skips, with the
original limits and zero test retries. All 159 exported page budgets passed;
the largest initial JavaScript was 452 KiB gzip against the 576 KiB limit.
No deadline, error suppression or branch-protection exception was used.
The hosted builder reopened the source package and pending-rate line with the
saved commercial quantities/rates and unchanged total. Existing dependency
security findings remain independent of this import's acceptance.

Publication evidence and final performance/deployment acceptance are recorded
after the current-source audit, hook-protected push and Railway rollout complete.
