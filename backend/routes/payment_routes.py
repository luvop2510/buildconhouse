"""Payments module — customer collection tracker for confirmed sales orders.

An "order" in this module is a Quotation whose status is `ordered` or `won`
(i.e. a confirmed sale). Each order accrues Payment records against it; the
outstanding balance is derived as `grand_total - sum(payments)`.

There are NO taxes anywhere in Forge — the quotation's grand_total is the
final price the customer pays, and payments accumulate against it directly.
"""
from __future__ import annotations
from services.money import format_indian_money
from services.followup_engine import reconcile_followups_admitted
import re
from services.multi_filters import filter_values, filter_condition
import asyncio
import logging
import math
from uuid import uuid4
from datetime import datetime, timedelta, timezone
from typing import Optional
from urllib.parse import quote_plus

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response

from auth import (
    TILES_FLOOR_ID, accessible_floor_ids, floor_for_write, floor_inherit, floor_query,
    get_current_user, get_floor_scoped_or_404, require_min_role,
)
from db import client, db
from models import Payment, PaymentCreate, PaymentOrderExtraUpdate, UserPublic
from services.activity_log import log_event
from services.analytics import cache
from services.export import export_response
from services.followup_engine import reconcile_followups
from services.notifications import notify
from settings import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/payments", tags=["payments"])


# The set of quotation statuses we treat as "collectable orders".
ORDER_STATUSES = ("ordered", "won")


def _payment_scope_query(user: UserPublic, base: dict | None = None) -> dict:
    """Include Ground Floor tile orders for users authorized to see them.

    Payments is shared by the sanitary and tiles modules, while ``floor_query``
    follows the user's ambient floor header. That header can remain on First
    Floor while a manager is reviewing Ground Floor tiles, so payment screens
    must include the fixed tiles floor explicitly.
    """
    queries = [floor_query(user, base)]
    allowed = accessible_floor_ids(user)
    if user.role in ("owner", "manager") or (allowed and TILES_FLOOR_ID in allowed):
        queries.append({"$and": [{"floor_id": TILES_FLOOR_ID}, base or {}]})
    return queries[0] if len(queries) == 1 else {"$or": queries}

MODE_LABELS = {
    "cash": "Cash",
    "upi": "UPI",
    "bank": "Bank Transfer",
    "cheque": "Cheque",
    "card": "Credit Card",
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
async def _paid_by_quotation(quotation_ids: list[str], *, floor_id: str | None = None, cash_only: bool = False) -> dict[str, float]:
    """Sum completed payment amounts per quotation.

    A quotation context panel is anchored to one business unit.  Accepting
    its already-authorized floor keeps an unrelated payment with a malformed
    or reused quotation id from affecting that unit's balance.
    """
    if not quotation_ids:
        return {}
    match: dict = {"quotation_id": {"$in": quotation_ids}, "status": "completed"}
    if cash_only:
        match["entry_type"] = {"$ne": "godown_stock_credit"}
    if floor_id is not None:
        match["floor_id"] = floor_id
    pipeline = [
        {"$match": match},
        {"$group": {"_id": "$quotation_id", "total": {"$sum": "$amount"}}},
    ]
    rows = await db.payments.aggregate(pipeline).to_list(len(quotation_ids) + 5)
    return {r["_id"]: float(r.get("total", 0)) for r in rows}


async def _mrp_for_quotation(quotation: dict) -> float:
    """Return the sum of qty × product.mrp for the quotation's line items.
    Falls back to unit_price when the product record is missing."""
    items = quotation.get("items", [])
    if not items:
        return 0.0
    product_ids = list({i.get("product_id") for i in items if i.get("product_id")})
    products = await db.products.find(
        {"id": {"$in": product_ids}}, {"_id": 0, "id": 1, "mrp": 1}
    ).to_list(len(product_ids) + 5) if product_ids else []
    mrp_by_id = {p["id"]: float(p.get("mrp") or 0) for p in products}
    total = 0.0
    for it in items:
        pid = it.get("product_id")
        qty = float(it.get("qty") or 0)
        mrp = mrp_by_id.get(pid) or float(it.get("unit_price") or 0)
        total += qty * mrp
    return round(total, 2)


def _payment_status(paid: float, grand: float) -> str:
    """Derived status for the order card: paid | partial | due."""
    if grand <= 0:
        return "paid"
    if paid + 1e-6 >= grand:
        return "paid"
    if paid > 0:
        return "partial"
    return "due"


def _collection_total(quotation: dict) -> float:
    """Amount due in Collections, including all append-only added costs."""
    history = quotation.get("payment_extra_history")
    # A migration backfills the array, but retaining this fallback keeps an
    # in-flight deployment and old exports correct.
    extras = (
        sum(float(entry.get("amount") or 0) for entry in history)
        if isinstance(history, list)
        else float(quotation.get("payment_extra_amount") or 0)
    )
    return round(float(quotation.get("grand_total") or 0) + extras, 2)


async def _godown_value_by_quotation(
    quotation_ids: list[str], *, floor_id: str | None = None,
    floor_ids: list[str] | None = None, purchase_orders=None,
) -> dict[str, float]:
    """Sold value removed from confirmed orders by permanent godown intakes.

    The payment credit is capped at the unpaid balance.  A fully paid order
    therefore has no credit row, yet may still have a refund due.  Purchase
    item movement counters are the authoritative source for that difference.
    """
    if not quotation_ids:
        return {}
    query: dict = {"quotation_id": {"$in": quotation_ids}}
    if floor_id is not None:
        query["floor_id"] = floor_id
    elif floor_ids is not None:
        query["floor_id"] = {"$in": floor_ids}
    query["items.godown_transferred_qty"] = {"$gt": 0}
    pipeline = [
        {"$match": query},
        {"$unwind": "$items"},
        {"$match": {"items.cancelled": {"$ne": True}, "items.godown_transferred_qty": {"$gt": 0}}},
        {"$group": {"_id": "$quotation_id", "total": {"$sum": {"$add": [
            {"$ifNull": ["$items.godown_transferred_value", 0]},
            {"$multiply": [
                {"$max": [0, {"$subtract": [
                    {"$ifNull": ["$items.godown_transferred_qty", 0]},
                    {"$ifNull": ["$items.godown_valued_qty", 0]},
                ]}]},
                {"$ifNull": ["$items.unit_cost", 0]},
            ]},
        ]}}}},
    ]
    collection = purchase_orders if purchase_orders is not None else db.purchase_orders
    rows = await collection.aggregate(pipeline).to_list(len(quotation_ids) + 5)
    return {row["_id"]: round(float(row.get("total") or 0), 2) for row in rows if row.get("_id")}


def _fully_paid_order_ids(orders: list[dict], paid_by_order: dict[str, float]) -> list[str]:
    """Return non-zero orders whose completed payments cover the total."""
    return [
        order["id"] for order in orders
        if _collection_total(order) > 0
        and paid_by_order.get(order["id"], 0.0) + 1e-6 >= _collection_total(order)
    ]


def _short_amount(amount: float) -> str:
    """Compact Indian rupee display used in the sidebar badge: ₹10.9L / ₹8.5L."""
    if amount >= 1_00_00_000:
        return f"₹{amount / 1_00_00_000:.1f}Cr"
    if amount >= 1_00_000:
        return f"₹{amount / 1_00_000:.1f}L"
    return f"₹{format_indian_money(amount, decimals=0)}"


def _iso_month(iso_ts: str) -> str:
    return (iso_ts or "")[:7]  # "2026-08"


def _days_unpaid(confirmed_at: str | None, *, now: datetime | None = None) -> int:
    """Calendar days since confirmation, never a negative or invalid age."""
    if not confirmed_at:
        return 0
    try:
        confirmed = datetime.fromisoformat(confirmed_at.replace("Z", "+00:00"))
        if confirmed.tzinfo is None:
            confirmed = confirmed.replace(tzinfo=timezone.utc)
        business_tz = timezone(timedelta(hours=5, minutes=30))
        today = (now or datetime.now(timezone.utc)).astimezone(business_tz).date()
        return max(0, (today - confirmed.astimezone(business_tz).date()).days)
    except (TypeError, ValueError):
        return 0


AGING_RANGES = {
    "5_days": (5, None),
    "1_week": (7, None),
    "1_month": (30, None),
    "6_months": (180, None),
    "over_6_months": (181, None),
}


def _aging_range(period: str | None, minimum: int | None, maximum: int | None) -> tuple[int, int | None] | None:
    if not isinstance(period, str) or not period:
        return None
    if period == "custom":
        if minimum is None and maximum is None:
            raise HTTPException(status_code=400, detail="Enter a custom minimum or maximum age")
        if minimum is not None and maximum is not None and minimum > maximum:
            raise HTTPException(status_code=400, detail="Minimum age cannot exceed maximum age")
        return (minimum or 0, maximum)
    if period not in AGING_RANGES:
        raise HTTPException(status_code=400, detail="Unknown overdue period")
    return AGING_RANGES[period]


# ---------------------------------------------------------------------------
# Stats (KPI cards at the top of the page)
# ---------------------------------------------------------------------------
@router.get("/stats")
async def payment_stats(user: UserPublic = Depends(get_current_user)):
    """Four KPIs: Total Outstanding · Collected This Month · Active Orders · Fully Paid."""
    orders = await db.quotations.find(
        _payment_scope_query(user, {"status": {"$in": list(ORDER_STATUSES)}}),
        {"_id": 0, "id": 1, "grand_total": 1, "payment_extra_amount": 1, "payment_extra_history": 1},
    ).to_list(2000)
    ids = [o["id"] for o in orders]
    paid_map, cash_map, godown_map = await asyncio.gather(
        _paid_by_quotation(ids),
        _paid_by_quotation(ids, cash_only=True),
        _godown_value_by_quotation(ids),
    )

    total_outstanding = 0.0
    active_total = 0.0
    active_received = 0.0
    earned_total = 0.0
    refund_due_total = 0.0
    settlement_credits = 0.0
    active_orders = 0
    fully_paid = 0
    for o in orders:
        grand = _collection_total(o)
        paid = paid_map.get(o["id"], 0.0)
        cash = max(0.0, cash_map.get(o["id"], 0.0))
        credit = max(0.0, paid - cash)
        effective_total = max(0.0, grand - godown_map.get(o["id"], 0.0))
        earned_total += min(cash, effective_total)
        refund_due_total += max(0.0, cash - effective_total)
        settlement_credits += credit
        status = _payment_status(paid, grand)
        if status == "paid":
            if grand > 0:
                fully_paid += 1
        else:
            active_orders += 1
            active_total += max(0.0, grand - credit)
            active_received += min(cash, max(grand - credit, 0.0))
            total_outstanding += max(0.0, grand - paid)

    # Purchase orders record supplier costs, not cash disbursements. Exclude
    # unapproved drafts and cancelled orders from this committed spend figure.
    purchase_rows = await db.purchase_orders.aggregate([
        {"$match": _payment_scope_query(user, {"status": {"$nin": ["draft", "awaiting_review", "cancelled"]}})},
        {"$group": {"_id": None, "total": {"$sum": "$grand_total"}}},
    ]).to_list(1)
    spending_total = float(purchase_rows[0].get("total", 0)) if purchase_rows else 0.0

    # Collected this month
    this_month = _iso_month(datetime.now(timezone.utc).isoformat())
    pipeline = [
        {"$match": _payment_scope_query(user, {"status": "completed", "entry_type": {"$ne": "godown_stock_credit"}})},
        {"$group": {"_id": {"$substr": [{"$ifNull": ["$paid_at", "$created_at"]}, 0, 7]}, "total": {"$sum": "$amount"}}},
    ]
    rows = await db.payments.aggregate(pipeline).to_list(60)
    collected_this_month = 0.0
    for r in rows:
        if r["_id"] == this_month:
            collected_this_month = float(r.get("total", 0))
            break

    return {
        "total_outstanding": round(total_outstanding, 2),
        "collected_this_month": round(collected_this_month, 2),
        "active_orders": active_orders,
        "fully_paid": fully_paid,
        "active_total": round(active_total, 2),
        "active_received": round(active_received, 2),
        "earned_total": round(earned_total, 2),
        "refund_due_total": round(refund_due_total, 2),
        "spending_total": round(spending_total, 2),
        "settlement_credits": round(settlement_credits, 2),
    }


# ---------------------------------------------------------------------------
# Orders list (left column)
# ---------------------------------------------------------------------------
@router.get("/orders")
async def list_orders(
    q: Optional[str] = None,
    status_filter: Optional[str] = Query(None, description="paid | partial | due | all"),
    overdue_period: Optional[str] = Query(None, description="5_days | 1_week | 1_month | 6_months | over_6_months | custom"),
    custom_min_days: Optional[int] = Query(None, ge=0),
    custom_max_days: Optional[int] = Query(None, ge=0),
    limit: int = Query(200, ge=1, le=1000),
    user: UserPublic = Depends(get_current_user),
):
    """Collectable orders sorted by outstanding-first."""
    aging_ranges = [_aging_range(value, custom_min_days, custom_max_days) for value in filter_values(overdue_period)]
    query: dict = {"status": {"$in": list(ORDER_STATUSES)}}
    if q:
        term = {"$regex": re.escape(q), "$options": "i"}
        query["$or"] = [
            {"number": term}, {"customer_name": term},
        ]

    docs = await db.quotations.find(
        _payment_scope_query(user, query), {"_id": 0, "id": 1, "number": 1, "customer_id": 1, "customer_name": 1,
                "grand_total": 1, "payment_extra_amount": 1, "payment_extra_history": 1, "status": 1, "ordered_at": 1, "created_at": 1, "notes": 1},
    ).sort("updated_at", -1).to_list(limit * 2)

    ids = [d["id"] for d in docs]
    paid_map, cash_map, godown_map = await asyncio.gather(
        _paid_by_quotation(ids), _paid_by_quotation(ids, cash_only=True),
        _godown_value_by_quotation(ids),
    )

    out = []
    for d in docs:
        grand = _collection_total(d)
        paid = paid_map.get(d["id"], 0.0)
        effective_total = max(0.0, grand - godown_map.get(d["id"], 0.0))
        cash_received = max(0.0, cash_map.get(d["id"], 0.0))
        outstanding = max(0.0, grand - paid)
        pay_status = _payment_status(paid, grand)
        pct = 0 if grand <= 0 else min(100, int(round(paid / grand * 100)))
        confirmed_at = d.get("ordered_at") or d.get("created_at")
        out.append({
            "id": d["id"],
            "number": d.get("number"),
            "customer_id": d.get("customer_id"),
            "customer_name": d.get("customer_name"),
            "grand_total": grand,
            "effective_order_total": round(effective_total, 2),
            "godown_transferred_value": round(godown_map.get(d["id"], 0.0), 2),
            "cash_received": round(cash_received, 2),
            "refund_due": round(max(0.0, cash_received - effective_total), 2),
            "paid": round(paid, 2),
            "outstanding": round(outstanding, 2),
            "percent_collected": pct,
            "payment_status": pay_status,       # paid | partial | due
            "confirmed_at": confirmed_at,
            "days_unpaid": _days_unpaid(confirmed_at) if outstanding > 0 else 0,
            "outstanding_short": _short_amount(outstanding) if outstanding > 0 else None,
        })

    # Collections is an action queue, not an archive. A settled order belongs
    # in Payment History and must not make staff scroll past it to collect an
    # outstanding balance. `all` remains available to an explicit API caller
    # that needs the complete set.
    if status_filter == "all":
        pass
    elif status_filter:
        out = [o for o in out if o["payment_status"] == status_filter]
    else:
        out = [o for o in out if o["payment_status"] != "paid"]

    if aging_ranges:
        out = [o for o in out if o["outstanding"] > 0 and any(bounds is None or (o["days_unpaid"] >= bounds[0] and (bounds[1] is None or o["days_unpaid"] <= bounds[1])) for bounds in aging_ranges)]

    # Sort: outstanding desc, then most recently confirmed
    out.sort(key=lambda o: (o.get("confirmed_at") or "", o["id"]), reverse=True)
    out.sort(key=lambda o: -o["outstanding"])
    return out[:limit]


# ---------------------------------------------------------------------------
# Order detail (right column)
# ---------------------------------------------------------------------------
@router.get("/orders/{order_id}")
async def order_detail(order_id: str, user: UserPublic = Depends(get_current_user)):
    doc = await db.quotations.find_one(_payment_scope_query(user, {"id": order_id}), {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Order not found")
    if doc.get("status") not in ORDER_STATUSES:
        raise HTTPException(status_code=400, detail="Quotation is not a confirmed order yet")

    floor_id = doc.get("floor_id")
    paid_map = await _paid_by_quotation([order_id], floor_id=floor_id)
    cash_map, godown_map = await asyncio.gather(
        _paid_by_quotation([order_id], floor_id=floor_id, cash_only=True),
        _godown_value_by_quotation([order_id], floor_id=floor_id),
    )
    paid = paid_map.get(order_id, 0.0)
    quotation_total = float(doc.get("grand_total") or 0)
    extra_history = doc.get("payment_extra_history") if isinstance(doc.get("payment_extra_history"), list) else []
    manual_extra_amount = round(_collection_total({**doc, "grand_total": 0}), 2)
    manual_extra_name = doc.get("payment_extra_name") or ("Additional cost" if manual_extra_amount else None)
    grand = _collection_total(doc)
    effective_total = max(0.0, grand - godown_map.get(order_id, 0.0))
    cash_received = max(0.0, cash_map.get(order_id, 0.0))
    mrp = await _mrp_for_quotation(doc)
    outstanding = max(0.0, grand - paid)

    customer = await db.customers.find_one(
        {"id": doc["customer_id"], "floor_id": floor_id}, {"_id": 0, "password_hash": 0},
    ) or {}

    payments = await db.payments.find(
        {"quotation_id": order_id, "floor_id": floor_id,
         "$nor": [{"status": "pending", "automation_key": {"$exists": True}}]}, {"_id": 0},
    ).sort("paid_at", -1).to_list(500)
    # Ensure legacy payments (without paid_at) still sort sensibly
    payments.sort(key=lambda p: (p.get("paid_at") or p.get("created_at") or ""), reverse=True)

    return {
        "id": doc["id"],
        "floor_id": floor_id,
        "number": doc.get("number"),
        "status": doc.get("status"),
        "doc_type": doc.get("doc_type") or "standard",
        "customer": {
            "id": customer.get("id"),
            "name": customer.get("name"),
            "company": customer.get("company"),
            "phone": customer.get("phone"),
            "email": customer.get("email"),
            "city": customer.get("city"),
            "address": customer.get("address"),
        },
        "customer_name": doc.get("customer_name"),
        "confirmed_at": doc.get("ordered_at") or doc.get("created_at"),
        "notes": doc.get("notes"),
        "project_name": doc.get("project_name"),
        "mrp": round(mrp, 2),
        "discounted_rate": round(quotation_total, 2),
        "quotation_total": round(quotation_total, 2),
        "manual_extra_amount": round(manual_extra_amount, 2),
        "manual_extra_name": manual_extra_name,
        "additional_costs": extra_history,
        "grand_total": round(grand, 2),
        "effective_order_total": round(effective_total, 2),
        "godown_transferred_value": round(godown_map.get(order_id, 0.0), 2),
        "cash_received": round(cash_received, 2),
        "refund_due": round(max(0.0, cash_received - effective_total), 2),
        "paid": round(paid, 2),
        "outstanding": round(outstanding, 2),
        "percent_collected": 0 if grand <= 0 else min(100, int(round(paid / grand * 100))),
        "payment_status": _payment_status(paid, grand),
        "payments": payments,
    }


@router.patch("/orders/{order_id}/manual-extra")
async def update_ground_floor_manual_extra(
    order_id: str,
    body: PaymentOrderExtraUpdate,
    user: UserPublic = Depends(require_min_role("accounts")),
):
    """Append a labour/other charge without changing the quotation price."""
    # Payments can include all floors the accounts user is authorized to see.
    scope = _payment_scope_query(user, {"id": order_id})
    quotation = await db.quotations.find_one(
        scope, {
            "_id": 0, "id": 1, "floor_id": 1, "grand_total": 1, "status": 1,
            "number": 1, "customer_id": 1, "customer_name": 1,
            "payment_extra_amount": 1, "payment_extra_history": 1,
        },
    )
    if not quotation:
        raise HTTPException(status_code=404, detail="Order not found")
    if quotation.get("status") not in ORDER_STATUSES:
        raise HTTPException(status_code=400, detail="Quotation is not a confirmed order yet")

    if not math.isfinite(body.amount) or round(float(body.amount), 2) <= 0:
        raise HTTPException(status_code=400, detail="Additional cost must be a finite value of at least ₹0.01")
    extra = round(float(body.amount), 2)
    request_key = (body.idempotency_key or "").strip() or None
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="Name the additional cost")
    now = datetime.now(timezone.utc).isoformat()
    entry = {
        "id": str(uuid4()),
        "name": name,
        "amount": extra,
        "note": (body.note or "").strip() or None,
        "created_at": now,
        "recorded_by": user.id,
        "recorded_by_name": user.full_name,
    }
    if request_key:
        entry["request_key"] = request_key
    # An added cost must be visible in the same permanent ledger as payments.
    # It is a debit (not a collection), so it has a distinct status and is
    # intentionally excluded by all ``status: completed`` cash aggregates.
    ledger_entry = Payment(
        id=entry["id"], created_at=now, updated_at=now, paid_at=now,
        floor_id=quotation.get("floor_id"), quotation_id=order_id,
        quotation_number=quotation.get("number"), customer_id=quotation.get("customer_id"),
        customer_name=quotation.get("customer_name"), amount=extra,
        mode="adjustment", status="adjustment", entry_type="additional_cost",
        additional_cost_id=entry["id"], cost_name=name, note=entry["note"],
        recorded_by=user.id, recorded_by_name=user.full_name,
    ).model_dump()
    # The unique sparse payment key index skips missing fields, but indexes
    # an explicit null. Cost retries dedupe via the quotation history above.
    ledger_entry.pop("idempotency_key", None)

    def result_for(current, cost, ledger, *, added=False):
        total = _collection_total(current) + (extra if added else 0)
        return {
            "quotation_total": round(float(current.get("grand_total") or 0), 2),
            "manual_extra_amount": round(total - float(current.get("grand_total") or 0), 2),
            "manual_extra_name": cost["name"], "additional_cost": cost,
            "ledger_entry": ledger, "grand_total": round(total, 2),
        }

    async def _write_extra(session=None):
        current = await db.quotations.find_one(scope, {"_id": 0}, session=session)
        if not current or current.get("status") not in ORDER_STATUSES:
            raise HTTPException(status_code=409, detail="Order changed; refresh before adding a cost")
        if request_key:
            existing = next((cost for cost in current.get("payment_extra_history", []) if cost.get("request_key") == request_key), None)
            if existing:
                if existing["amount"] != extra or existing["name"] != name or existing.get("note") != entry["note"]:
                    raise HTTPException(status_code=409, detail="This additional cost request key was already used for different details")
                ledger = await db.payments.find_one({"id": existing["id"], "floor_id": current.get("floor_id")}, {"_id": 0}, session=session)
                return result_for(current, existing, ledger)
        await db.quotations.update_one(
            {"id": order_id, "floor_id": quotation.get("floor_id")},
            {"$push": {"payment_extra_history": entry}, "$inc": {"payment_extra_amount": extra},
             "$set": {"payment_extra_name": name, "updated_at": now}},
            session=session,
        )
        await db.payments.insert_one(ledger_entry, session=session)
        return result_for(current, entry, ledger_entry, added=True)

    # Keep the quotation audit trail and ledger debit atomic on Atlas.  Local
    # standalone MongoDB cannot run transactions, so it uses the same safe
    # fallback used by payment recording elsewhere in this module.
    try:
        try:
            async with await client.start_session() as session:
                result = await session.with_transaction(_write_extra)
        except Exception as exc:
            txn_unsupported = any(marker in str(exc) for marker in (
                "Transaction numbers", "replica set", "IllegalOperation",
            ))
            if not txn_unsupported:
                raise
            if settings.environment == "production":
                raise HTTPException(status_code=503, detail="Additional cost recording requires a MongoDB replica set in production")
            result = await _write_extra(session=None)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("additional cost ledger write failed for %s", order_id)
        raise HTTPException(status_code=503, detail="Additional cost could not be committed safely") from exc
    try:
        await cache.bump("payments")
    except Exception:
        logger.exception("cache bump failed after manual extra update for %s", order_id)
    return result


# ---------------------------------------------------------------------------
# Record a payment
# ---------------------------------------------------------------------------
@router.post("", response_model=Payment)
async def create_payment(
    body: PaymentCreate,
    idempotency_header: Optional[str] = Header(None, alias="Idempotency-Key"),
    user: UserPublic = Depends(require_min_role("accounts")),
):
    if not math.isfinite(body.amount) or round(float(body.amount), 2) <= 0:
        raise HTTPException(status_code=400, detail="Amount must be a finite value of at least ₹0.01")

    def receipt_time(value):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except (TypeError, ValueError, AttributeError):
            raise HTTPException(status_code=400, detail="Date received must be a valid ISO date")

    if body.paid_at:
        receipt_time(body.paid_at)

    idempotency_key = (idempotency_header or body.idempotency_key or "").strip() or None
    def replay_payment(existing):
        if existing is None:
            return None
        if (existing.get("quotation_id") != body.quotation_id
                or float(existing.get("amount") or 0) != round(float(body.amount), 2)
                or existing.get("mode") != body.mode
                or (existing.get("reference") or None) != (body.reference or None)
                or (existing.get("note") or None) != (body.note or None)
                or (body.paid_at and receipt_time(existing.get("paid_at")) != receipt_time(body.paid_at))):
            raise HTTPException(status_code=409, detail="This payment request key was already used for different payment details")
        return existing

    replay_query = _payment_scope_query(user, {"idempotency_key": idempotency_key})
    if idempotency_key:
        existing = replay_payment(await db.payments.find_one(replay_query, {"_id": 0}))
        if existing:
            return existing
    quot = await db.quotations.find_one(_payment_scope_query(user, {"id": body.quotation_id}), {"_id": 0})
    if not quot:
        raise HTTPException(status_code=404, detail="Order not found")
    if quot.get("status") not in ORDER_STATUSES:
        raise HTTPException(status_code=400, detail="Quotation is not a confirmed order yet")

    now = datetime.now(timezone.utc).isoformat()
    paid_at = body.paid_at or now
    payment = Payment(
        quotation_id=body.quotation_id,
        quotation_number=quot.get("number"),
        customer_id=quot["customer_id"],
        customer_name=quot.get("customer_name"),
        amount=round(float(body.amount), 2),
        mode=body.mode,
        status="completed",
        reference=body.reference,
        note=body.note,
        paid_at=paid_at,
        recorded_by=user.id,
        recorded_by_name=user.full_name,
        idempotency_key=idempotency_key,
        # Payments inherit the quotation's floor. The caller's ambient floor
        # header may still point at First Floor while collecting a Ground Floor
        # tiles order, and payment records must remain joinable to that order.
        floor_id=quot.get("floor_id") or floor_for_write(user),
    )
    committed_totals: dict[str, float] = {}

    async def _check_and_insert(session=None):
        """Balance check + insert, optionally inside a transaction session."""
        if idempotency_key:
            existing = replay_payment(await db.payments.find_one(replay_query, {"_id": 0}, session=session))
            if existing:
                return existing
        # Snapshot reads followed by inserts into different payment documents
        # do not conflict in MongoDB. Write the shared order first so concurrent
        # collectors retry with its latest ledger instead of overspending it.
        locked = await db.quotations.update_one(
            {"id": body.quotation_id, "floor_id": payment.floor_id, "status": {"$in": list(ORDER_STATUSES)}},
            {"$inc": {"payment_revision": 1}}, session=session,
        )
        if locked.matched_count != 1:
            raise HTTPException(status_code=409, detail="Order changed; refresh it before recording payment")
        quot_now = await db.quotations.find_one(
            {"id": body.quotation_id, "floor_id": payment.floor_id},
            {"_id": 0, "grand_total": 1, "payment_extra_amount": 1, "payment_extra_history": 1, "number": 1},
            session=session,
        )
        grand = _collection_total(quot_now or {})
        paid_rows = await db.payments.aggregate([
            {"$match": {"quotation_id": body.quotation_id, "floor_id": payment.floor_id, "status": "completed"}},
            {"$group": {"_id": None, "total": {"$sum": "$amount"}}},
        ], session=session).to_list(1)
        already_paid = float(paid_rows[0].get("total") or 0) if paid_rows else 0.0
        outstanding_before = round(grand - already_paid, 2)
        if payment.amount > outstanding_before + 1e-6:
            raise HTTPException(status_code=400, detail=(
                f"Payment of ₹{format_indian_money(body.amount)} exceeds the outstanding balance of "
                f"₹{format_indian_money(max(outstanding_before, 0))} on {quot.get('number')}"
            ))
        payment_doc = payment.model_dump()
        if not idempotency_key:
            # Omit the field entirely rather than leaving an explicit None —
            # payments.payment_idempotency_key is a unique *sparse* index,
            # which only skips documents missing the key, not documents
            # where it's present-but-null. Leaving it in would make the
            # SECOND EVER payment recorded without an Idempotency-Key crash
            # with a DuplicateKeyError (same root cause as the OrderPlaced
            # automation bug fixed in services/domain_outbox.py).
            payment_doc.pop("idempotency_key", None)
        await db.payments.insert_one(payment_doc, session=session)
        committed_totals.update(grand=grand, total_paid=already_paid + payment.amount)
        return None

    # The order write serializes the balance check; with_transaction retries
    # transient write conflicts with a fresh snapshot before inserting payment.
    # Standalone Mongo (local dev) has no transactions — fall back to the
    # unserialized check there, still protected by the idempotency unique index.
    try:
        try:
            async with await client.start_session() as session:
                replay = await session.with_transaction(_check_and_insert)
                if replay is not None:
                    return replay
        except HTTPException:
            raise
        except Exception as exc:
            message = str(exc)
            txn_unsupported = (
                "Transaction numbers" in message
                or "replica set" in message
                or "IllegalOperation" in message
            )
            if not txn_unsupported:
                raise
            if settings.environment == "production":
                raise HTTPException(
                    status_code=503,
                    detail="Payment recording requires a MongoDB replica set in production",
                )
            replay = await _check_and_insert(session=None)
            if replay is not None:
                return replay
    except HTTPException:
        raise
    except Exception as exc:
        # A unique-key race is safe to replay; return the committed payment.
        if idempotency_key:
            existing = replay_payment(await db.payments.find_one(replay_query, {"_id": 0}))
            if existing:
                return existing
        raise HTTPException(status_code=503, detail="Payment could not be committed safely") from exc

    # Use the committed transaction's totals. A second database read failing
    # after commit must never turn a received payment into a failed response.
    total_paid = committed_totals["total_paid"]
    grand = committed_totals["grand"]
    fully_paid = total_paid + 1e-6 >= grand

    try:
        await log_event(
            event_type="payment.recorded",
            entity_type="payment",
            entity_id=payment.id,
            actor=user,
            customer_id=quot["customer_id"],
            quotation_id=body.quotation_id,
            summary=(
                f"{MODE_LABELS.get(body.mode, body.mode).title()} · "
                f"₹{format_indian_money(payment.amount, decimals=0)} received on {quot.get('number')}"
            ),
            payload={
                "amount": payment.amount,
                "mode": body.mode,
                "reference": body.reference,
                "fully_paid": fully_paid,
            },
        )
    except Exception:
        logger.exception("activity log failed after committed payment %s", payment.id)
    try:
        await cache.bump("payments")
    except Exception:
        logger.exception("cache bump failed for payments after payment %s", payment.id)
    # A payment landing is exactly when payment_overdue/payment_partial
    # reminders should refresh or auto-close — event-triggered, not a cron job.
    asyncio.create_task(reconcile_followups_admitted())
    await notify(
        quot.get("created_by"),
        f"Payment received · {quot.get('number')}",
        body=f"₹{format_indian_money(payment.amount, decimals=0)} ({MODE_LABELS.get(body.mode, body.mode).title()}) from {quot.get('customer_name')}"
        + (" — fully paid" if fully_paid else f" — ₹{format_indian_money(max(grand - total_paid, 0), decimals=0)} outstanding"),
        kind="success",
        link=f"/quotations/{body.quotation_id}",
        floor_id=floor_inherit(quot),
    )
    return payment


# Backwards-compat: keep GET /api/payments returning the raw list (used elsewhere).
# `skip`/`limit` are additive and opt-in — omitting them preserves the exact
# prior behavior (first 500, newest first). `X-Has-More` lets a future caller
# detect truncation without a breaking response-shape change; see
# PRODUCTION_FIXES_2026-07-16.md item 8 (pagination hardening).
@router.get("")
async def list_payments(
    response: Response,
    skip: int = Query(0, ge=0),
    limit: int = Query(500, ge=1, le=2000),
    user: UserPublic = Depends(get_current_user),
):
    docs = await db.payments.find(_payment_scope_query(user), {"_id": 0}).sort("created_at", -1).skip(skip).limit(limit + 1).to_list(limit + 1)
    response.headers["X-Has-More"] = "true" if len(docs) > limit else "false"
    return docs[:limit]


@router.get("/list")
async def completed_payment_list(
    response: Response,
    q: Optional[str] = Query(None, description="Search customer, invoice number, or reference"),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    business_unit: Optional[str] = Query(None),
    mode: Optional[str] = Query(None),
    sort: str = Query("date_desc", pattern="^(date_desc|date_asc|amount_desc|amount_asc)$"),
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    user: UserPublic = Depends(get_current_user),
):
    """Return payment rows only for orders that are fully paid (100%)."""
    floor_ids = _resolve_history_floor_ids(user, business_unit)
    order_query: dict = {"status": {"$in": list(ORDER_STATUSES)}}
    if floor_ids is not None:
        order_query["floor_id"] = {"$in": floor_ids}
    orders = await db.quotations.find(order_query, {"_id": 0, "id": 1, "grand_total": 1, "payment_extra_amount": 1, "payment_extra_history": 1}).to_list(5000)
    paid_by_order = await _paid_by_quotation([order["id"] for order in orders])
    fully_paid_ids = _fully_paid_order_ids(orders, paid_by_order)
    query = _history_filter(floor_ids, q, date_from, date_to, None, mode, "completed")
    query["quotation_id"] = {"$in": fully_paid_ids}
    total = await db.payments.count_documents(query)
    docs = await db.payments.find(query, {"_id": 0}).sort(_SORT_MAP[sort]).skip(skip).limit(limit).to_list(limit)
    response.headers["X-Total-Count"] = str(total)
    return {"total": total, "items": await _enrich_history_rows(docs)}


@router.get("/fully-paid-orders")
async def fully_paid_orders(
    q: Optional[str] = None,
    business_unit: Optional[str] = None,
    sort: str = Query("date_desc", pattern="^(date_desc|date_asc|amount_desc|amount_asc)$"),
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    user: UserPublic = Depends(get_current_user),
):
    """One row per settled order, even when it took several installments."""
    query: dict = {"status": {"$in": list(ORDER_STATUSES)}}
    floor_ids = _resolve_history_floor_ids(user, business_unit)
    if floor_ids is not None:
        query["floor_id"] = {"$in": floor_ids}
    if q:
        term = {"$regex": re.escape(q.strip()), "$options": "i"}
        query["$or"] = [{"number": term}, {"customer_name": term}]
    orders = await db.quotations.find(
        query,
        {"_id": 0, "id": 1, "number": 1, "customer_id": 1, "customer_name": 1,
         "floor_id": 1, "grand_total": 1, "payment_extra_amount": 1,
         "payment_extra_history": 1, "ordered_at": 1, "created_at": 1},
    ).to_list(5000)
    paid_map = await _paid_by_quotation([order["id"] for order in orders])
    cash_map, godown_map = await asyncio.gather(
        _paid_by_quotation([order["id"] for order in orders], cash_only=True),
        _godown_value_by_quotation([order["id"] for order in orders]),
    )
    settled = []
    for order in orders:
        total = _collection_total(order)
        paid = paid_map.get(order["id"], 0.0)
        if total <= 0 or paid + 1e-6 < total:
            continue
        effective_total = max(0.0, total - godown_map.get(order["id"], 0.0))
        cash_received = max(0.0, cash_map.get(order["id"], 0.0))
        settled.append({
            "id": order["id"], "number": order.get("number"),
            "customer_id": order.get("customer_id"), "customer_name": order.get("customer_name"),
            "floor_id": order.get("floor_id"), "grand_total": total,
            "received": round(paid, 2), "outstanding": 0.0,
            "effective_order_total": round(effective_total, 2),
            "godown_transferred_value": round(godown_map.get(order["id"], 0.0), 2),
            "cash_received": round(cash_received, 2),
            "refund_due": round(max(0.0, cash_received - effective_total), 2),
            "confirmed_at": order.get("ordered_at") or order.get("created_at"),
        })
    reverse = sort in ("date_desc", "amount_desc")
    key = "grand_total" if sort.startswith("amount") else "confirmed_at"
    settled.sort(key=lambda order: order.get(key) or (0 if key == "grand_total" else ""), reverse=reverse)
    return {"total": len(settled), "items": settled[skip:skip + limit]}


# ---------------------------------------------------------------------------
# Payment History — permanent reconciliation ledger.
#
# Every row here is an immutable ``payments`` ledger document.  Cash payments
# are credits and added costs are explicit receivable debits; keeping both in
# the same indexed collection lets the ledger paginate and export correctly
# without a separate, eventually-consistent history read model.
#
# Floor scope follows the Sales Data precedent (routes/sales_data_routes.py
# `_resolve_floor_ids`), NOT the single-active-floor `floor_query()` used
# everywhere else — this is deliberately a cross-business-unit reconciliation
# view (it has its own Business Unit column + filter), the same carve-out
# auth.py's `_resolve_floor_scope` docstring documents for Sales Data.
# ---------------------------------------------------------------------------
def _resolve_history_floor_ids(user: UserPublic, business_unit: Optional[str]) -> Optional[list[str]]:
    """None means "no floor restriction" (every floor the caller can see).
    An explicit business_unit narrows to exactly that floor, after checking
    the caller is actually allowed onto it."""
    if business_unit and business_unit != "all":
        allowed = accessible_floor_ids(user)
        if allowed is not None and any(value not in allowed for value in filter_values(business_unit)):
            raise HTTPException(status_code=403, detail="You do not have access to this business unit")
        return filter_values(business_unit)
    return accessible_floor_ids(user)  # None (unrestricted) for owner/manager, else their assigned floors


async def _floor_names() -> dict[str, str]:
    rows = await db.floors.find({}, {"_id": 0, "id": 1, "name": 1}).to_list(50)
    return {r["id"]: r["name"] for r in rows}


def _history_filter(
    floor_ids: Optional[list[str]], q: Optional[str], date_from: Optional[str], date_to: Optional[str],
    customer_id: Optional[str], mode: Optional[str], status: Optional[str],
) -> dict:
    query: dict = {}
    if floor_ids is not None:
        query["floor_id"] = {"$in": floor_ids}
    if customer_id:
        query["customer_id"] = customer_id
    if mode:
        query["mode"] = filter_condition(mode)
    if status:
        query["status"] = filter_condition(status)
    date_range: dict = {}
    if date_from:
        date_range["$gte"] = date_from
    if date_to:
        date_range["$lte"] = date_to if len(date_to) > 10 else f"{date_to}T23:59:59.999"
    if date_range:
        # paid_at is optional on older rows; created_at is always present and
        # indexed, so filtering on it keeps this fast and gap-free.
        query["created_at"] = date_range
    if q:
        rx = {"$regex": re.escape(q.strip()), "$options": "i"}
        or_clause = [
            {"customer_name": rx}, {"quotation_number": rx}, {"reference": rx},
            {"note": rx}, {"cost_name": rx},
        ]
        query["$and"] = query.get("$and", []) + [{"$or": or_clause}]
    return query


_SORT_MAP = {
    "date_desc": [("created_at", -1)],
    "date_asc": [("created_at", 1)],
    "amount_desc": [("amount", -1)],
    "amount_asc": [("amount", 1)],
}


async def _enrich_history_rows(docs: list[dict]) -> list[dict]:
    """Attach invoice number, business unit label, and outstanding
    before/after — all derived, nothing stored twice."""
    qids = list({d["quotation_id"] for d in docs if d.get("quotation_id")})
    quotations = await db.quotations.find(
        {"id": {"$in": qids}}, {
            "_id": 0, "id": 1, "number": 1, "doc_number": 1, "grand_total": 1,
            "payment_extra_amount": 1, "payment_extra_history": 1,
        },
    ).to_list(len(qids) + 5) if qids else []
    quot_by_id = {qq["id"]: qq for qq in quotations}

    # Running balance needs every cash credit and added-cost debit on each
    # touched quotation (not just the rows matching this page's filters),
    # otherwise a search/date filter would silently produce a wrong balance.
    all_pmts = await db.payments.find(
        {"quotation_id": {"$in": qids}, "status": {"$in": ["completed", "adjustment"]}},
        {
            "_id": 0, "id": 1, "quotation_id": 1, "amount": 1, "paid_at": 1,
            "created_at": 1, "entry_type": 1, "additional_cost_id": 1,
        },
    ).to_list(5000) if qids else []
    by_qid: dict[str, list[dict]] = {}
    for p in all_pmts:
        by_qid.setdefault(p["quotation_id"], []).append(p)
    outstanding_by_payment_id: dict[str, tuple[float, float]] = {}
    for qid, pmts in by_qid.items():
        pmts.sort(key=lambda p: (p.get("paid_at") or p.get("created_at") or "", p.get("id") or ""))
        quotation = quot_by_id.get(qid) or {}
        # Costs recorded before this ledger feature have no matching debit
        # document. Treat only those historical costs as opening receivables;
        # new costs are added exactly once by their ledger event below.
        history = quotation.get("payment_extra_history")
        ledger_cost_ids = {p.get("additional_cost_id") for p in pmts if p.get("entry_type") == "additional_cost"}
        if isinstance(history, list):
            legacy_extras = sum(
                float(cost.get("amount") or 0) for cost in history
                if cost.get("id") not in ledger_cost_ids
            )
        else:
            legacy_extras = float(quotation.get("payment_extra_amount") or 0)
        running = float(quotation.get("grand_total") or 0) + legacy_extras
        for p in pmts:
            before = round(running, 2)
            if p.get("entry_type") == "additional_cost":
                running += float(p.get("amount") or 0)
            else:
                running -= float(p.get("amount") or 0)
            after = round(running, 2)
            outstanding_by_payment_id[p["id"]] = (before, after)

    floor_names = await _floor_names()
    out = []
    for d in docs:
        qq = quot_by_id.get(d.get("quotation_id"), {})
        before_after = outstanding_by_payment_id.get(d["id"])
        # Keep non-cash ledger credits legible in both the payment-history
        # table and the order detail timeline.  The persisted entry_type is
        # the source of truth; this label avoids relying on a free-text note.
        label = d.get("label")
        if d.get("entry_type") == "godown_stock_credit":
            label = "Moved to go-down stock"
        elif d.get("entry_type") == "additional_cost":
            label = f"Additional cost · {d.get('cost_name') or 'Unnamed cost'}"
        out.append({
            **d,
            "label": label,
            "paid_at": d.get("paid_at") or d.get("created_at"),
            "invoice_number": qq.get("doc_number") or qq.get("number") or d.get("quotation_number"),
            "business_unit": floor_names.get(d.get("floor_id"), d.get("floor_id")),
            "outstanding_before": before_after[0] if before_after else None,
            "outstanding_after": before_after[1] if before_after else None,
        })
    return out


@router.get("/history")
async def payment_history(
    response: Response,
    q: Optional[str] = Query(None, description="Search customer, invoice number, or reference"),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    customer_id: Optional[str] = Query(None),
    business_unit: Optional[str] = Query(None, description="Floor id, or omit/'all' for every accessible unit"),
    mode: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    sort: str = Query("date_desc", pattern="^(date_desc|date_asc|amount_desc|amount_asc)$"),
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    user: UserPublic = Depends(get_current_user),
):
    floor_ids = _resolve_history_floor_ids(user, business_unit)
    query = _history_filter(floor_ids, q, date_from, date_to, customer_id, mode, status)
    total = await db.payments.count_documents(query)
    docs = await db.payments.find(query, {"_id": 0}).sort(_SORT_MAP[sort]).skip(skip).limit(limit).to_list(limit)
    response.headers["X-Total-Count"] = str(total)
    return {"total": total, "items": await _enrich_history_rows(docs)}


_HISTORY_COLUMNS = [
    ("customer_name", "Customer"),
    ("invoice_number", "Invoice / Order"),
    ("business_unit", "Business Unit"),
    ("paid_at", "Payment Date"),
    ("amount", "Payment Amount"),
    ("mode", "Payment Method"),
    ("reference", "Transaction Reference"),
    ("recorded_by_name", "Collected By"),
    ("outstanding_before", "Outstanding Before"),
    ("outstanding_after", "Outstanding After"),
    ("status", "Status"),
    ("note", "Notes"),
]


@router.get("/history/export")
async def export_payment_history(
    q: Optional[str] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    customer_id: Optional[str] = Query(None),
    business_unit: Optional[str] = Query(None),
    mode: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    sort: str = Query("date_desc", pattern="^(date_desc|date_asc|amount_desc|amount_asc)$"),
    fmt: str = Query("xlsx", pattern="^(csv|xlsx)$"),
    user: UserPublic = Depends(get_current_user),
):
    floor_ids = _resolve_history_floor_ids(user, business_unit)
    query = _history_filter(floor_ids, q, date_from, date_to, customer_id, mode, status)
    docs = await db.payments.find(query, {"_id": 0}).sort(_SORT_MAP[sort]).limit(5000).to_list(5000)
    rows = await _enrich_history_rows(docs)
    for r in rows:
        r["mode"] = MODE_LABELS.get(r.get("mode"), r.get("mode"))
    return export_response(rows, _HISTORY_COLUMNS, "payment_history", fmt)


# ---------------------------------------------------------------------------
# WhatsApp reminder builder
# ---------------------------------------------------------------------------
def _format_amount(v: float) -> str:
    """Indian-style comma formatting: 12,34,567."""
    return format_indian_money(v, decimals=0)


def _clean_phone(phone: Optional[str]) -> Optional[str]:
    """Strip everything but digits; if it starts with 0 or has no country code assume India (+91)."""
    if not phone:
        return None
    digits = "".join(ch for ch in phone if ch.isdigit())
    if not digits:
        return None
    if len(digits) == 10:                     # 98200 12345 → +91
        return "91" + digits
    if digits.startswith("0") and len(digits) == 11:
        return "91" + digits[1:]
    return digits


@router.get("/orders/{order_id}/whatsapp-reminder")
async def whatsapp_reminder(order_id: str, user: UserPublic = Depends(get_current_user)):
    """Build a wa.me link + message body for a payment reminder."""
    doc = await get_floor_scoped_or_404(db.quotations, order_id, user, not_found="Order not found", projection={"_id": 0})
    floor_id = doc.get("floor_id")
    customer = await db.customers.find_one({"id": doc["customer_id"], "floor_id": floor_id}, {"_id": 0}) or {}
    paid_map = await _paid_by_quotation([order_id], floor_id=floor_id)
    paid = paid_map.get(order_id, 0.0)
    grand = _collection_total(doc)
    outstanding = max(0.0, grand - paid)

    phone = _clean_phone(customer.get("phone"))
    name = (customer.get("name") or doc.get("customer_name") or "there").split()[0]
    number = doc.get("number") or ""

    lines = [
        f"Hi {name},",
        "",
        f"This is a gentle reminder for your order *{number}*.",
        "",
        f"• Order total: ₹{_format_amount(grand)}",
        f"• Already received: ₹{_format_amount(paid)}",
        f"• Outstanding balance: *₹{_format_amount(outstanding)}*",
        "",
        "Kindly complete the pending payment at your earliest convenience. Please share the reference (UTR / cheque no.) once done so we can update our records.",
        "",
        "Thank you for your business!",
        "— Forge",
    ]
    message = "\n".join(lines)

    return {
        "customer_name": customer.get("name") or doc.get("customer_name"),
        "phone": phone,
        "phone_display": customer.get("phone"),
        "message": message,
        "outstanding": round(outstanding, 2),
        "wa_url": (
            f"https://wa.me/{phone}?text={quote_plus(message)}"
            if phone else
            f"https://wa.me/?text={quote_plus(message)}"
        ),
    }
