# Godown Stock Build Prompt

Build a **Sanitary Bathroom (first-floor) Godown Stock** module for BuildCon
House. It is separate from Ground Floor tile logistics.

Use FastAPI, MongoDB and Expo/React Native Web. Create an append-only,
auditable stock-lot workflow for products a customer cancels or declines after
an order. Never store only a product-level count: each lot must preserve its
product snapshot, brand, source purchase order and quotation, source customer,
original purchase date/time, transfer reason, transfer actor/date/time,
available quantity and allocation history.

Required journeys:

1. From a sanitary purchase-order line, staff can move a full or partial
quantity to Godown Stock with a required cancellation/decline reason.
2. The Godown Stock page is Sanitary-only, groups/filter by every available
brand, supports product/SKU search, and shows only available lots by default.
3. Every card shows thumbnail, product, brand, SKU, available quantity, source
customer, original purchase date/time and godown transfer date/time. A details
view shows an immutable timeline: original purchase → transfer to godown →
each quotation allocation.
4. In a new Sanitary quotation, show a Godown-available source alongside the
catalog. Let staff review source customer/date/time and requested quantity,
then reserve atomically. If the same product has no sufficient stock, make the
shortfall explicit and do not silently reuse it.
5. Add a non-destructive quotation preview that labels every line as
**Godown stock** or **New order**, includes availability/shortfall and keeps
the builder editable.
6. Persist provenance on quotation lines and surface it instantly in quotation
detail, activity timeline and notifications/inbox: source customer, original
purchase date/time, godown transfer date/time, destination quotation/customer
and allocation date/time.

Integrity and API rules:

- Scope every read/write to `floor_id="first-floor"`; never reuse the
Ground Floor `boxes_godown` fields.
- Use an independent `godown_stock` lot collection with indexes for
`floor_id + available_qty + brand_id`, `floor_id + product_id + available_qty`,
and a unique lot id.
- Use a Mongo transaction or conditional atomic decrement
(`available_qty >= requested_qty`) plus an idempotency key for intake and
allocation. Do not trust product price, source customer or availability from
the client.
- Write activity events and notifications with deep links; events must carry
the provenance snapshot.
- Preserve quotation totals/revisions and never create a supplier PO for a
line fully allocated from godown stock.

Design standard:

- Apple-quality calm layout: large quiet hero, deliberate whitespace, one
strong primary action, card-first stock browsing on phones and no horizontally
clipped tables.
- Mobile first at 320–414px; 44px targets; safe-area-aware sticky actions;
horizontal brand chips; full-screen picker/review sheets.
- WCAG 2.2 AA: native controls, labels, visible focus, keyboard dialog flow,
live availability announcements, status conveyed by text/icon as well as
colour, and no colour-only stock states.

Deliver unit tests for floor isolation, insufficient-stock races, partial
intake/allocation, provenance snapshots, and mobile/desktop responsive
contracts.
