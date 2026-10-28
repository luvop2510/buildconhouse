# Kitchen final design and quotation PDFs

The Kitchen lead, design and quotation workflow uses the existing project,
version and private attachment records. Keep all historical records and existing
access, optimistic concurrency, idempotency and production locks.

## Acceptance

- Lead intake and queue show Architect / Interior instead of Reference. Remove
  Lead source and Budget from these screens; preserve their historical data.
- Each uploaded design PDF creates one numbered Design version automatically. There is no fixed design-count limit and no separate Create Design action. Select one design version as final. Upload and
  final selection are required when creating/saving the new workflow. Remove
  requirements, budget discussion and company notes from the form. Company
  handoff offers Yes / No. Existing approval controls remain.
- Quotation admission requires an approved current-cycle design, a final uploaded
  PDF, and company handoff Yes. Missing design guidance opens Design directly.
- Quotations accept PDFs tagged GI, SS or Mix. Any subset of types may be uploaded.
  Exactly one uploaded PDF is final, and its type becomes the customer's selected
  kitchen type. Confirming without this selection is rejected by the server.
- The quotation starts with its related finalized design PDF. All PDFs support
  authenticated open/download in the browser. New Kitchen PDFs have a 10 MB
  (10,000,000 byte) upload limit, enforced before staging and against actual bytes.
  Existing larger historical files retain their download support.
  Server attachment upload timestamps determine
  read-only India upload dates and the selected quotation receipt date.
- Quotation shows the latest quotation without Saved quotation or Related design
  selectors. New quotation uses the current finalized design automatically;
  existing quotations retain their recorded link. Returning from Design preserves
  an unsaved quotation's PDFs and dates while using the current finalized design.
- Design keeps version selection without repeated Design headings. PDF controls
  use direct choose/upload only; omit existing-upload selectors and empty
  “Choose a PDF to add” instructions for Design, GI, SS and Mix.
- Remove manual quotation amount/received-date inputs. No monetary amount is
  inferred from arbitrary PDF contents; the explicit final order amount remains.
- Changing viewed versions does not mutate business records. Old already placed
  orders retain their explicit quotation/design links and historical amounts.

## Storage and rollout

Each new design version binds exactly one PDF. Persist final_design_version_id separately from the viewed version. Add quotation PDF/type options/final ID. Retain the existing attachment_id alias for selected-document compatibility.
Validate every ID belongs to this project and has verified PDF upload metadata.
No destructive backfill or new index is needed. Existing historical records remain
readable; explicit new confirmations must satisfy the new workflow.

## Verification and release

Cover final selection, multiple types, missing/foreign/non-PDF IDs, server dates,
company handoff gating, private file access, stale drafts and existing version
locks. Update obsolete UI expectations while keeping the existing full stability
and performance gate unchanged. Publish verified main to GitHub, Vercel and
Railway; verify actual source/deployment identities and retain rollback targets.
