"""Repair direct GoDown transfers created before customer order recording.

Dry run by default. ``--apply`` creates the missing quotation and In Box PO
inside a transaction and links the existing transfer. Stock is never changed.
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

from dotenv import load_dotenv

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE))
load_dotenv(BASE / ".env")

from db import client, db  # noqa: E402
from models import PurchaseOrder, PurchaseOrderItem, PurchaseStageEvent  # noqa: E402
from routes.godown_stock_routes import CustomerTransfer, _new_transfer_quotation  # noqa: E402
from services.sequence import next_number  # noqa: E402


QUERY = {"transfer_type": "godown_stock", "recipient_purchase_item_id": None,
         "recipient_inbox_stage": None}


async def repair_one(transfer_id: str) -> bool:
    async with await client.start_session() as session:
        async with session.start_transaction():
            transfer = await db.godown_customer_transfers.find_one(
                {"id": transfer_id, **QUERY}, {"_id": 0}, session=session,
            )
            if not transfer:
                return False
            if await db.purchase_orders.find_one(
                {"items.godown_customer_transfer_id": transfer_id}, {"_id": 0, "id": 1}, session=session,
            ):
                raise RuntimeError(f"Transfer {transfer_id} already has a purchase item; inspect it manually")
            lot = await db.godown_stock.find_one(
                {"id": transfer["stock_id"], "floor_id": transfer["floor_id"]}, {"_id": 0}, session=session,
            )
            customer = await db.customers.find_one(
                {"id": transfer["recipient_customer_id"], "floor_id": transfer["floor_id"]},
                {"_id": 0}, session=session,
            )
            if not lot or not customer:
                raise RuntimeError(f"Transfer {transfer_id} has no same-floor stock lot or customer")
            at = transfer["created_at"]
            actor = SimpleNamespace(id=transfer.get("created_by") or "system",
                                    full_name=transfer.get("created_by_name") or "System")
            snapshot = {**lot, **{key: transfer[key] for key in (
                "product_id", "sku", "name", "image", "source_customer_name", "mrp", "unit_price",
            ) if key in transfer}}
            body = CustomerTransfer(
                qty=transfer["qty"], recipient_customer_id=customer["id"],
                unit_price=transfer.get("unit_price"), discount_pct=transfer.get("discount_pct") or 0,
                reason=transfer.get("reason"), idempotency_key=transfer["id"],
            )
            quote, quote_line = await _new_transfer_quotation(
                snapshot, customer, body, transfer["stock_id"], at, actor, session,
            )
            quote["created_at"] = at
            quote["updated_at"] = at
            net_unit_price = float(transfer.get("net_unit_price") or 0)
            if abs(quote["grand_total"] - float(transfer.get("total") or 0)) > 0.01:
                raise RuntimeError(f"Transfer {transfer_id} price no longer matches its saved total")
            customer_name = customer.get("company") or customer.get("name")
            item = PurchaseOrderItem(
                product_id=quote_line.product_id, sku=quote_line.sku, name=quote_line.name,
                image=transfer.get("image"), qty=body.qty, qty_received=body.qty,
                unit_cost=net_unit_price, quotation_line_id=quote_line.id,
                stage="in_box", customer_id=customer["id"], customer_name=customer_name,
                brand_id=lot.get("brand_id"), brand_name=lot.get("brand_name") or lot.get("brand"),
                godown_stock_id=transfer["stock_id"],
                godown_source_customer_name=transfer.get("source_customer_name"),
                godown_source_purchased_at=lot.get("source_purchased_at"),
                godown_transferred_at=at, godown_allocated_at=at,
                godown_customer_transfer_id=transfer_id,
                godown_transfer_mrp=transfer.get("mrp"), godown_transfer_unit_price=transfer.get("unit_price"),
                godown_transfer_discount_pct=body.discount_pct,
                godown_transfer_net_unit_price=net_unit_price,
                last_moved_at=at, last_moved_by=actor.id, last_moved_by_name=actor.full_name,
                stage_history=[PurchaseStageEvent(
                    at=at, from_stage=None, to_stage="in_box", by_user_id=actor.id,
                    by_user_name=actor.full_name, note="Transferred from GoDown stock", action="transfer_in",
                )],
            ).model_dump()
            year = datetime.now(timezone.utc).year
            po_number = await next_number(
                "purchase_order", f"FPO-{year}-", collection="purchase_orders", session=session,
            )
            po = PurchaseOrder(
                number=po_number, quotation_id=quote["id"], quotation_number=quote["number"],
                customer_id=customer["id"], customer_name=customer_name,
                brand_id=lot.get("brand_id"), brand_name=lot.get("brand_name") or lot.get("brand"),
                status="draft", items=[item], subtotal=quote["grand_total"], grand_total=quote["grand_total"],
                created_by=actor.id, created_by_name=actor.full_name, floor_id=transfer["floor_id"],
                internal_notes="Recovered from GoDown stock transfer",
                created_at=at, updated_at=at,
            ).model_dump()
            quote["source_purchase_order_id"] = po["id"]
            quote["source_item_id"] = item["id"]
            await db.quotations.insert_one(quote, session=session)
            await db.purchase_orders.insert_one(po, session=session)
            updated = await db.godown_customer_transfers.update_one(
                {"id": transfer_id, **QUERY}, {"$set": {
                    "recipient_purchase_order_id": po["id"], "replacement_item_id": item["id"],
                    "recipient_quotation_id": quote["id"], "recipient_inbox_stage": "in_box",
                }}, session=session,
            )
            if updated.modified_count != 1:
                raise RuntimeError(f"Transfer {transfer_id} changed during repair")
            return True


async def main(apply: bool) -> None:
    rows = await db.godown_customer_transfers.find(QUERY, {"_id": 0, "id": 1}).to_list(100)
    print(f"Direct transfers missing customer orders: {len(rows)}")
    if not apply:
        print("Dry run only; use --apply to repair these records")
        return
    for row in rows:
        repaired = await repair_one(row["id"])
        print(f"{row['id']}: {'repaired' if repaired else 'already repaired'}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Create missing customer orders and PO items")
    args = parser.parse_args()
    asyncio.run(main(args.apply))
