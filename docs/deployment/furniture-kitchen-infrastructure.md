# Furniture and Kitchen infrastructure

Floor IDs remain stable: `first-floor` is Sanitary Bathroom, `ground-floor` is
Tiles, `second-floor` is Kitchen, and `third-floor` is Furniture. Never rename
the persisted IDs. Staff access, active-floor headers and backend floor guards
apply to each module and mutation.

Kitchen and Furniture share Catalog/imports, Customers, Purchases (including
the completed customer workspace), Payments and Fully paid orders. Each
request uses the selected business floor. Their existing Walk-ins and
Quotation Follow-up registers continue to use the shared notebook component.
Kitchen's quotation/payment document design has not been supplied; the RMB
ledger and its export/send flow are restricted to Furniture.

Furniture's RMB quotations use `/notebook/furniture-quotations` and the backend
`/api/furniture-quotations` resource. This is a charge/deposit ledger matching
the provided seven-column reference. Decimal strings preserve exact currency
values; INR receipts divide by INR per RMB, USD receipts multiply by RMB per
USD, and RMB receipts use rate 1. Each receipt saves its own rate and dates.
The current rates are entered by the operator, never fetched from a live FX
service. Finalized charges and customer details lock while receipts may be
updated. PDF output contains the customer heading, table, yellow totals and
orange balance without Buildcon branding.

Company catalog imports update product records by floor/company/SKU and keep
stable IDs. A draft quotation keeps its original prices until PO creation
explicitly chooses original or current catalog prices; finalized documents
remain snapshots. Furniture ledger charges are operator-entered RMB charges,
so catalog changes do not automatically rewrite them.

Purchases has five selectable stages: PO final, Order in company, Company
billing, Inbox and Dispatched. Per the owner's clarification, dispatched is
customer delivered. A customer enters the 100% list only when every active
ordered quantity is dispatched. Supplier receipts alone never qualify.
Historical stage events and dates remain available after stage normalization.

Direct WhatsApp delivery setup and receipt semantics are documented in
[whatsapp-document-delivery.md](whatsapp-document-delivery.md). Apply migrations
0027–0029 before promoting this release; the new startup constraints require
the furniture, receipt and catalog indexes. Migrations add indexes and preserve
historical records; they do not import any new supplier data or invent images.
