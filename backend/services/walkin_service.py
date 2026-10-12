"""Walk-ins business logic — kept out of routes/walkin_routes.py so
routes/quotation_routes.py can call the two status-transition hooks
without a route-to-route import.
"""
from __future__ import annotations

from typing import Optional

from db import db
from models import UserPublic, now_iso
from services.activity_log import log_event


async def find_or_create_customer(
    *, name: str, phone: Optional[str], alternate_phone: Optional[str], email: Optional[str],
    floor_id: str, user: UserPublic,
    address: Optional[str] = None, city: Optional[str] = None,
    state: Optional[str] = None, pincode: Optional[str] = None,
) -> dict:
    """Duplicate detection per the Walk-ins spec: search existing customers
    by phone OR alternate phone (either direction — a new walk-in's phone
    might match an existing customer's alternate_phone, or vice versa)
    before ever creating a new Customer record. This is the HIGH-confidence
    tier only (see services/duplicate_detection.py for the full tiered
    matcher used by the check-duplicate endpoint / create-walkin decision
    tree in routes/walkin_routes.py — medium/low confidence matches require
    an explicit staff decision made BEFORE this function is ever called)."""
    from services.duplicate_detection import find_customer_matches

    # Scoped to the department this walk-in is for: matching across business
    # units would reuse (and then attach revenue to) the other unit's
    # customer record.
    matches = await find_customer_matches(
        phone=phone, alternate_phone=alternate_phone, floor_ids=[floor_id],
    )
    if matches["high"]:
        return matches["high"][0]

    from models import CustomerPublic
    data: dict = {
        "name": name, "phone": phone, "alternate_phone": alternate_phone,
        "email": email.lower() if email else None, "floor_id": floor_id,
        "address": address, "city": city, "state": state, "pincode": pincode,
    }
    cust = CustomerPublic(**data)
    to_store = cust.dict()
    to_store["lifecycle"] = "prospect"
    if not to_store.get("email"):
        to_store.pop("email", None)  # customers_email_unique is a sparse index — omit the key entirely, not null
    await db.customers.insert_one(to_store)
    await log_event(
        event_type="customer.created", entity_type="customer", entity_id=cust.id,
        customer_id=cust.id, actor=user, summary="Customer Created (via Walk-in)",
    )
    return to_store


async def on_selection_created(customer_id: str, quotation_id: str, quotation_number: str) -> None:
    """Called by routes/quotation_routes.py right after a doc_type=
    "tiles_selection" Quotation is inserted. Advances any of this
    customer's still-open Walk-ins to "selection_completed" and links them
    to the new document — the walk_in_new Follow-up producer excludes this
    status, so the old card auto-closes on the next reconcile (fired by the
    caller), and the Tile Selections producer picks up the new document on
    its own next reconcile pass. No new reminder logic is added here."""
    from models_walkins import WALKIN_OPEN_STATUSES

    now = now_iso()
    await db.walkins.update_many(
        {"customer_id": customer_id, "status": {"$in": WALKIN_OPEN_STATUSES}, "is_deleted": False},
        {"$set": {"status": "selection_completed", "selection_quotation_id": quotation_id, "updated_at": now}},
    )
    walkins = await db.walkins.find(
        {"customer_id": customer_id, "selection_quotation_id": quotation_id}, {"_id": 0, "id": 1},
    ).to_list(10)
    for w in walkins:
        await log_event(
            event_type="walkin.selection_completed", entity_type="walkin", entity_id=w["id"],
            customer_id=customer_id, quotation_id=quotation_id,
            summary=f"Selection {quotation_number} created — Walk-in converted to Selection",
        )


async def on_moved_to_quotation(quotation_id: str, quotation_number: str) -> None:
    """Called right after routes/quotation_routes.py flips a Selection's
    doc_type to "tiles_quotation". Advances the linked Walk-in (if any) to
    "quotation_created"."""
    now = now_iso()
    result = await db.walkins.update_many(
        {"selection_quotation_id": quotation_id, "status": "selection_completed", "is_deleted": False},
        {"$set": {"status": "quotation_created", "updated_at": now}},
    )
    if result.modified_count:
        walkins = await db.walkins.find({"selection_quotation_id": quotation_id}, {"_id": 0, "id": 1, "customer_id": 1}).to_list(10)
        for w in walkins:
            await log_event(
                event_type="walkin.quotation_created", entity_type="walkin", entity_id=w["id"],
                customer_id=w.get("customer_id"), quotation_id=quotation_id,
                summary=f"Quotation {quotation_number} created from Selection",
            )
