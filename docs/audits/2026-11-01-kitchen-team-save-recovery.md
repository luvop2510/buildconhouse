# Kitchen save recovery and Team section permissions

## Confirmed causes and fixes

- Same-phone lead intake discarded the submitted address when reusing an older
  customer, then rejected that customer's blank address. Intake now fills only a
  missing address, with the existing customer reservation and an observed-address
  compare-and-set. Existing addresses and contact names remain authoritative.
  Explicit Existing customer intake offers the same missing-address field.
- Customer editing sent blank email as null. Mongo's sparse unique email index
  indexes explicit null, so editing a second no-email customer could return 500.
  Clearing now unsets the field; genuine duplicate-email races return 409.
- Lead response enrichment ran after the durable insert. A failed read could
  report failure after creation. The same bounded reads now complete before the
  final insert; unchanged actor-bound receipts retain safe explicit retries.
- The supplied browser video shows an approved Design viewed by a Kitchen
  worker, a refresh/account check and the restored Design form. The blanket
  approved-record UI lock also disabled the first company handoff. That first
  handoff now uses the existing staff-authorized design_handoff command;
  corrections to approved details remain owner-only. A separate React crash was
  not reproduced from that clip.

## Team and access behavior

The owner can grant Lead, Visit, CAD, Design, Quotation, Order, Production,
Installation and Completed independently in staff creation and editing. The
existing whole-workspace grant retains its scope. Lists, search, dashboard,
project reads, command domains, customer editing and private files enforce the
same stage boundary on the server. Out-of-scope history and financial data are
redacted while necessary downstream basis metadata is preserved. Navigation and
landing routes follow the same grants. An authorized workflow handoff returns
only a minimal acknowledgement if the destination is not granted; its explicit
receipt replay does not authorize destination reads.

The owner staff directory has explicit Edit and Show/Hide password actions.
Reveal uses the existing audited owner-only endpoint, clears local display on
editing/account/list changes and ignores obsolete responses. Passwords remain
absent from ordinary list responses, exports and persistent browser storage.
Older hash-only passwords cannot be recovered and use the existing reset flow.

## Evidence and release status

Focused tests cover missing/blank addresses, canonical identity preservation,
concurrent contact edits, receipt compatibility, first-response serialization,
multiple no-email customer edits, per-stage authorization and Design handoff.
Validation before publication: all 4,104 hermetic backend unit tests passed;
140 affected and real Kitchen HTTP/Mongo cases passed; the final role-worker
stage-isolation and receipt suite passed 2/2, exercising all nine sections.
TypeScript, zero-warning ESLint, Team delegation/contact, Kitchen commercial,
PDF and draft/autosave contract checks passed. Browser evidence is kept in the
local output/playwright directory; publication identities and the final release
gate result are recorded separately after publication.

No business data migration, production customer edits or password reset was
performed during diagnosis. Read-only live checks found nine Kitchen customers
with blank addresses and confirmed the existing sparse unique email index.
No physical Windows/browser-device certificate is claimed by emulated tests.
