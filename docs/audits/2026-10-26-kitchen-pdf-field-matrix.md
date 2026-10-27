# Kitchen PDF field coverage — 26 October 2026

Source: the supplied Buildcon House Kitchen Department Specification (2).pdf. The user's current instructions override the document: compact lists replace table/board views; CAD status derives from percentage; no quotation HTTPS control; Next/Previous remain unrestricted; do not add Next Action, Budget Discussion or Visit Requirements to Visit. These exclusions are intentional, not missing work.

| PDF section | Fields and their implemented location |
| --- | --- |
| Lead | Permanent Lead/Project ID, customer name and phone in project header/customer record; site, source, kitchen type, budget, notes, lead date and status in LeadFields; owner-selected Assigned To at intake and current stage. No automatic fixed employee. |
| Visit | Carried Project ID/customer header, editable visit date, selected employee, display/model, notes and visit status. Requirements, budget discussion and next action remain excluded by the user's explicit correction. |
| CAD File | CAD received, 0–100 progress, automatically derived status, notes. No company quotation handoff here. |
| Design | Optional private presentation document, customer approval, read-only customer revision total, sent-to-company status/date and notes. First/internal presentations do not increment customer revision count. Earlier files/versions remain in Documents/History. |
| Quotation | Received state/date, amount, private uploaded document selection, sent-to-customer state/date, response and notes. Earlier quotation versions remain in History. No HTTPS input or quotation-link button. |
| Order | Confirmation state, date, final amount, editable private confirmation document, advance received state/amount and notes; saved order status appears on the page and owner status changes use Project actions. Owner-authorized changed amounts require explicit customer approval and preserve original terms. Date/notes corrections and document replacement retain history. Advance fields are visible before confirmation but cannot save a payment until an order exists. |
| Production | Not Started/In Production/Completed status, start/completion dates and notes. |
| Installation | Not Started/In Progress/Completed status, start/completion dates, automatically counted actual site visits and notes; scheduled visits do not increment the total. |
| Completed | Permanent Project ID, customer, final order amount, completion date, total design revisions, total actual site visits, complete project/history access, customer search, completion-date filtering and export. |

Assigned To is optional, selected by the owner, and can differ by stage. Reusing the same employee for several stages is supported. Assignment changes retain the existing version/replay/floor/capability checks and history. Selecting a person does not grant access or change the project's permissions.

Cross-stage navigation stays manual as explicitly selected by the user. Business actions still validate their own approvals, commercial amounts, dates, files and permissions. Earlier records are not fabricated when advancing without completed tasks.

Completed projects retain assignment metadata read-only; employee-filtered completed exports use the same filter as the visible list.
