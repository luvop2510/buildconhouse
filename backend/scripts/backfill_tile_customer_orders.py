#!/usr/bin/env python3
"""One-time backfill for the Tile Orders logistics redesign (see
docs/superpowers/specs/2026-07-29-tile-orders-logistics-redesign-design.md
§Migration). Creates a TileCustomerOrder for every pre-existing tiles
PurchaseOrder missing customer_order_id (grouped by quotation_id), and
converts each embedded old Chalan into a new TileDispatch + immutable
TileChalan + one synthetic fully-consumed TileReadyBatch.

Idempotent — a PurchaseOrder with customer_order_id already set is
skipped entirely, so re-running after a partial failure is safe. The Mongo
query below already excludes such POs, but the in-loop check is kept as a
defense-in-depth belt-and-braces guard (and is what makes the unit tests,
which use a hand-rolled fake collection that does not implement query
filtering, actually exercise idempotency).

Usage:
    cd backend && python scripts/backfill_tile_customer_orders.py           # apply
    cd backend && python scripts/backfill_tile_customer_orders.py --dry-run # report only, no writes
"""
from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timezone

from db import db
from models_tile_orders import (
    TileChalan, TileChalanItem, TileCustomerOrder, TileCustomerOrderBrand,
    TileCustomerOrderDashboardSummary, TileDispatch, TileDispatchLineConsumed, TileReadyBatch,
)
from services.sequence import next_number
from services.tile_order_status import derive_current_location, derive_item_status, rollup_status


async def backfill(*, dry_run: bool) -> dict:
    customer_orders_created = 0
    customer_orders_resumed = 0
    chalans_migrated = 0

    pos = await db.purchase_orders.find(
        {"$or": [{"customer_order_id": {"$exists": False}}, {"customer_order_id": None}]}, {"_id": 0},
    ).to_list(50000)

    by_quotation: dict[str, list[dict]] = {}
    for po in pos:
        if po.get("customer_order_id"):
            continue  # already migrated — belt-and-braces, see module docstring
        quotation_id = po.get("quotation_id")
        if not quotation_id:
            continue
        by_quotation.setdefault(quotation_id, []).append(po)

    for quotation_id, group_pos in by_quotation.items():
        quotation = await db.quotations.find_one({"id": quotation_id}, {"_id": 0, "doc_type": 1})
        if not quotation or quotation.get("doc_type") not in ("tiles_selection", "tiles_quotation"):
            continue  # standard (sanitaryware) orders never get a TileCustomerOrder

        first_po = group_pos[0]
        year_str = first_po.get("created_at", "")[:4] or str(datetime.now(timezone.utc).year)

        # Retry-safety (Finding 4): a prior run may have crashed after
        # inserting the TileCustomerOrder for this quotation but before
        # finishing every PO in the group. Look it up by quotation_id first
        # so a retry resumes the existing document instead of minting a
        # brand-new one — otherwise a partial failure could leave two
        # orphaned CustomerOrders for the same quotation.
        existing_co = await db.customer_orders.find_one({"quotation_id": quotation_id}, {"_id": 0})
        if existing_co:
            customer_order = TileCustomerOrder(**existing_co)
            customer_orders_resumed += 1
        else:
            # Number allocation is itself a write (db.counters $inc) — skip
            # it in dry-run so a report-only run never consumes a real TORD
            # number.
            number = (
                "DRY-RUN-PREVIEW" if dry_run
                else await next_number("customer_order", f"TORD-{year_str}-", collection="customer_orders")
            )
            customer_order = TileCustomerOrder(
                number=number, quotation_id=quotation_id, quotation_number=first_po.get("quotation_number", ""),
                customer_id=first_po.get("customer_id", ""), customer_name=first_po.get("customer_name", ""),
                customer_phone="", delivery_name=first_po.get("customer_name", ""), delivery_phone="",
                delivery_address="", delivery_city="", delivery_pincode="", delivery_state="",
                floor_id=first_po.get("floor_id", "first-floor"), created_by="system-backfill",
                created_by_name="Backfill script", dashboard_summary=TileCustomerOrderDashboardSummary(),
            )
            # Insert immediately (placeholder totals/brands) so the id is
            # durable before the per-PO loop runs — a crash partway through
            # the loop still leaves a valid document a retry can find above.
            if not dry_run:
                await db.customer_orders.insert_one(customer_order.model_dump())
            customer_orders_created += 1

        total_products, total_boxes = 0, 0.0
        brands: list[TileCustomerOrderBrand] = []

        for po in group_pos:
            items = po.get("items", [])
            items_by_id = {item["id"]: item for item in items}
            total_products += len(items)
            total_boxes += sum(float(i.get("qty") or 0) for i in items)
            item_statuses: list[str] = []

            for item in items:
                # Furthest-progress precedence (Finding 1), not last-chalan-wins:
                # a chalan array can hold e.g. an "at_godown" entry followed by
                # a "released" one for the same item, and the OLD stage that
                # matters for current_location is "does ANY matching chalan sit
                # at Buildcon's own godown" — not whichever happens to be last
                # in the array. "all_delivered" is likewise true only when
                # EVERY matching chalan reached the old system's terminal
                # "dispatched" (=reached-customer) stage; zero matching chalans
                # must NOT vacuously count as delivered.
                matching_chalans = [
                    old_chalan for old_chalan in po.get("chalans", [])
                    if any(line.get("po_item_id") == item["id"] for line in old_chalan.get("items", []))
                ]
                any_at_godown = any(c.get("stage") == "at_godown" for c in matching_chalans)
                all_delivered = bool(matching_chalans) and all(c.get("stage") == "dispatched" for c in matching_chalans)

                boxes_dispatched = 0.0
                for old_chalan in matching_chalans:
                    for line in old_chalan.get("items", []):
                        if line.get("po_item_id") != item["id"]:
                            continue
                        boxes_dispatched += float(line.get("qty") or 0)

                qty_ordered = float(item.get("qty") or 0)
                current_location = derive_current_location(
                    qty_ordered, 0, boxes_dispatched, any_at_godown=any_at_godown, all_delivered=all_delivered,
                )
                overall_status = derive_item_status(
                    qty_ordered, 0, boxes_dispatched, all_delivered=all_delivered,
                )
                item_statuses.append(overall_status)
                # Dry-run must leave the input PO dict completely untouched —
                # not just unpersisted. `items` above is the live list from
                # the fetched PO document, so mutating `item` in place here
                # even when dry_run is true would be a real (if unpersisted)
                # side effect on the in-memory document the caller passed in.
                if not dry_run:
                    item["boxes_ready"] = 0  # no separate Ready stage existed in the old system
                    item["boxes_dispatched"] = boxes_dispatched
                    item["boxes_pending"] = qty_ordered - boxes_dispatched
                    item["current_location"] = current_location
                    item["overall_status"] = overall_status

            # One TileChalan + one TileDispatch per OLD chalan (not per
            # item!) — Chalan.items is itself a list, so a single real
            # historic chalan can cover 2+ items of this PO in one delivery.
            # The old (buggy) version of this loop created one TileChalan
            # per (item x matching old chalan) pairing, all reusing the same
            # old_chalan.number — the second insert for a real multi-item
            # chalan would hard-crash on chalans.number's unique index. One
            # ready batch is still created per line (ReadyBatch is
            # per-po_item_id), but they're all consumed by the single
            # dispatch this old chalan produces, matching TileDispatch's
            # documented 1:1 chalan_id invariant.
            for old_chalan in po.get("chalans", []):
                matching_lines = [
                    line for line in old_chalan.get("items", []) if line.get("po_item_id") in items_by_id
                ]
                if not matching_lines:
                    continue
                chalans_migrated += 1
                if dry_run:
                    continue

                new_chalan_items: list[TileChalanItem] = []
                consumed: list[TileDispatchLineConsumed] = []
                for line in matching_lines:
                    line_item = items_by_id[line["po_item_id"]]
                    qty = float(line.get("qty") or 0)
                    batch_number = await next_number("ready_batch", f"RB-{year_str}-", collection="ready_batches")
                    batch = TileReadyBatch(
                        batch_number=batch_number, purchase_order_id=po["id"], po_item_id=line_item["id"],
                        customer_order_id=customer_order.id, floor_id=po.get("floor_id", "first-floor"),
                        supplier_id=po.get("supplier_id"), supplier_name=po.get("supplier_name") or "Unassigned",
                        customer_id=po.get("customer_id"), customer_name=po.get("customer_name") or "",
                        tile_name=line_item.get("name", ""), qty=qty, remaining_qty=0,
                        created_by="system-backfill", created_by_name="Backfill script", auto_created=True,
                    )
                    await db.ready_batches.insert_one(batch.model_dump())
                    new_chalan_items.append(
                        TileChalanItem(po_item_id=line_item["id"], tile_name=line_item.get("name", ""), boxes=qty, quantity=qty)
                    )
                    consumed.append(TileDispatchLineConsumed(ready_batch_id=batch.id, po_item_id=line_item["id"], qty=qty))

                # Finding 3: only "at_godown" represents material actually
                # sitting at Buildcon's own warehouse as a destination —
                # "released"/"dispatched" are direct-to-customer or
                # already-at-customer, respectively.
                destination_type = "Godown" if old_chalan.get("stage") == "at_godown" else "Customer"
                chalan = TileChalan(
                    number=old_chalan.get("number", ""), dispatch_id="", purchase_order_id=po["id"],
                    customer_order_id=customer_order.id, floor_id=po.get("floor_id", "first-floor"),
                    supplier_name=po.get("supplier_name") or "Unassigned", customer_name=po.get("customer_name") or "",
                    customer_phone="", delivery_address="", delivery_city="",
                    items=new_chalan_items,
                    created_by=old_chalan.get("created_by", "system-backfill"),
                    created_by_name=old_chalan.get("created_by_name", "Backfill script"),
                    generated_at=old_chalan.get("created_at", datetime.now(timezone.utc).isoformat()),
                    generated_by_name=old_chalan.get("created_by_name", "Backfill script"),
                )
                dispatch = TileDispatch(
                    dispatch_number=await next_number("dispatch", f"DSP-{year_str}-", collection="dispatches"),
                    purchase_order_id=po["id"], customer_order_id=customer_order.id,
                    floor_id=po.get("floor_id", "first-floor"), supplier_id=po.get("supplier_id"),
                    supplier_name=po.get("supplier_name") or "Unassigned", customer_id=po.get("customer_id"),
                    customer_name=po.get("customer_name") or "",
                    ready_batches_consumed=consumed,
                    destination_type=destination_type, destination_name=po.get("customer_name") or "",
                    destination_address="", destination_city="",
                    dispatch_date=old_chalan.get("created_at", "")[:10], dispatch_time=old_chalan.get("created_at", "")[11:16],
                    created_by="system-backfill", created_by_name="Backfill script", chalan_id=chalan.id,
                )
                chalan.dispatch_id = dispatch.id
                if old_chalan.get("stage") == "at_godown":
                    dispatch.godown_received_at = old_chalan.get("created_at")
                await db.chalans.insert_one(chalan.model_dump())
                await db.dispatches.insert_one(dispatch.model_dump())

            po_status = rollup_status(item_statuses)
            brands.append(TileCustomerOrderBrand(
                brand_id=po.get("brand_id"), brand_name=po.get("brand_name") or "Unassigned",
                supplier_id=po.get("supplier_id"), supplier_name=po.get("supplier_name") or "Unassigned",
                purchase_order_id=po["id"], status=po_status,
            ))
            if not dry_run:
                await db.purchase_orders.update_one({"id": po["id"]}, {"$set": {
                    "items": items, "customer_order_id": customer_order.id, "overall_status": po_status,
                    "dispatched_boxes": sum(i["boxes_dispatched"] for i in items),
                    "pending_boxes": sum(i["boxes_pending"] for i in items), "ready_boxes": 0,
                }})

        # Retry-safety continued (review finding): `group_pos` only holds the
        # POs THIS run processed. On a retry after a partial crash, POs that
        # a PRIOR run already finished are excluded from the top-level query
        # (they already have customer_order_id set) and never enter
        # `group_pos` — so building the final brands/totals from `group_pos`
        # alone would silently drop those already-migrated POs from the
        # CustomerOrder's brands list and undercount its totals. Re-query the
        # COMPLETE, current set of POs for this quotation (both
        # already-migrated and just-processed-in-this-run — every PO in the
        # group now has customer_order_id set one way or another) and
        # recompute brands/totals from THAT full set instead.
        if not dry_run:
            all_quotation_pos = [
                p for p in await db.purchase_orders.find({"quotation_id": quotation_id}, {"_id": 0}).to_list(50000)
                if p.get("quotation_id") == quotation_id
            ]
            total_products = sum(len(p.get("items", [])) for p in all_quotation_pos)
            total_boxes = sum(float(i.get("qty") or 0) for p in all_quotation_pos for i in p.get("items", []))
            brands = [
                TileCustomerOrderBrand(
                    brand_id=p.get("brand_id"), brand_name=p.get("brand_name") or "Unassigned",
                    supplier_id=p.get("supplier_id"), supplier_name=p.get("supplier_name") or "Unassigned",
                    purchase_order_id=p["id"], status=p.get("overall_status") or "Pending",
                )
                for p in all_quotation_pos
            ]

        customer_order.brands = brands
        customer_order.total_products = total_products
        customer_order.total_boxes = total_boxes
        customer_order.overall_status = rollup_status([b.status for b in brands])
        customer_order.dashboard_summary = TileCustomerOrderDashboardSummary(
            completion_percentage=0, overall_status=customer_order.overall_status,
            supplier_statuses=[{"supplier_name": b.supplier_name, "status": b.status} for b in brands],
        )
        # Finding 4: the document was already inserted (or already existed
        # from a prior partial run) before the per-PO loop above — finish it
        # off with a final update carrying the real rollup, rather than the
        # single insert_one this used to be at the very end.
        if not dry_run:
            await db.customer_orders.update_one({"id": customer_order.id}, {"$set": {
                "brands": [b.model_dump() for b in brands], "total_products": total_products, "total_boxes": total_boxes,
                "overall_status": customer_order.overall_status,
                "dashboard_summary": customer_order.dashboard_summary.model_dump(),
            }})

    return {
        "customer_orders_created": customer_orders_created,
        "customer_orders_resumed": customer_orders_resumed,
        "chalans_migrated": chalans_migrated,
    }


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Report what would change without writing")
    args = parser.parse_args()
    result = await backfill(dry_run=args.dry_run)
    mode = "DRY RUN — " if args.dry_run else ""
    print(
        f"{mode}Created {result['customer_orders_created']} TileCustomerOrder(s) "
        f"(resumed {result['customer_orders_resumed']} from a prior run), "
        f"migrated {result['chalans_migrated']} old Chalan(s)."
    )


if __name__ == "__main__":
    asyncio.run(main())
