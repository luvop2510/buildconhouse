"""Follow-ups · Sales Command Center — deterministic scoring + idempotent
reconciliation engine.

NOTHING here calls an LLM. Every score, bucket and recommendation is a plain
explainable pre-order rule over quotations, selections, walk-ins and customers.
Payment, purchasing, dispatch and delivery activity belongs in Orders.

reconcile_followups() is the single write path for AUTOMATED rows. It is
idempotent: re-running it never duplicates a card (dedupe key = source_key),
refreshes the score/reason of still-valid cards, and auto-resolves cards whose
trigger condition no longer holds (e.g. the customer placed an order).
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from pymongo.errors import DuplicateKeyError

from auth import floor_inherit
from db import db
from models import Followup, now_iso
from services.activity_log import log_event
from services.notifications import notify
from services.lead_scope import POST_ORDER_CATEGORIES, POST_ORDER_RULES
from services.customer_data_reset import customer_reset_maintenance

IST = timezone(timedelta(hours=5, minutes=30))

# Mutually-exclusive day windows so payment_overdue / payment_partial never
# both fire for the same order.
PAYMENT_OVERDUE_DAYS = 5
CUSTOMER_INACTIVE_DAYS = 21

# Floor-timed follow-up window — how long after a quotation/selection is
# created before the first automated nudge appears. Ground Floor (Tiles)
# gets a shorter window than First Floor (Sanitary) per the 2026-07-27
# design decision. Unknown/missing floor falls back to the same default
# used elsewhere for floor_id (`backend/auth.py`'s "first-floor" default).
FLOOR_FOLLOWUP_DAYS = {"ground-floor": 4, "first-floor": 7}
FOLLOWUP_DEFAULT_DAYS = 7


def quotation_followup_delay_days(floor_id: str) -> int:
    return FLOOR_FOLLOWUP_DAYS.get(floor_id, FOLLOWUP_DEFAULT_DAYS)


def quotation_followup_due_at(created_at: datetime, floor_id: str) -> Optional[datetime]:
    """None if the floor-timed follow-up window hasn't elapsed yet for a
    quotation/selection created at `created_at`; otherwise the fixed due_at
    instant (created_at + delay). Always the same value for the same
    inputs, so repeated reconcile passes never drift the due date — only a
    staff-initiated reschedule (PATCH .../due_at) changes it after that."""
    due = created_at + timedelta(days=quotation_followup_delay_days(floor_id))
    return due if datetime.now(timezone.utc) >= due else None


DELIVERED_RECENCY_DAYS = 5

RULE_DEFINITIONS = [
    {"rule_type": "quotation_followup", "label": "Quotation/selection follow-up", "category": "quotation",
     "description": "Floor-timed nudge — Ground Floor (Tiles) at 4 days, First Floor (Sanitary) at 7 days after creation. Excludes Tile Selections/Quotations, which use their own configurable cadence below."},
    {"rule_type": "selection_waiting", "label": "Tile Selection waiting", "category": "selection",
     "description": "Escalating reminder while a Tile Selection awaits conversion to a Quotation. Day thresholds configurable in Settings → Automation Rules (default 2/4/7/10 days)."},
    {"rule_type": "quotation_tiles_waiting", "label": "Tile Quotation waiting", "category": "quotation",
     "description": "Escalating reminder while a Tile Quotation awaits approval/order. Day thresholds configurable in Settings → Automation Rules (default 2/5/10/15 days)."},
    {"rule_type": "walk_in_new", "label": "Walk-in waiting", "category": "walk_in",
     "description": "Escalating reminder while a Walk-in has not yet reached a Selection. Day thresholds configurable in Settings → Automation Rules (default 1/3/7/14 days). Auto-closes the moment a Selection is created for that customer."},
    {"rule_type": "order_confirmed_ops", "label": "Order confirmed — Operations handoff", "category": "operations",
     "description": "One-time follow-up fired the moment a Quotation is placed as a confirmed Order — notifies the owning salesperson to hand off to Operations. Message text is DB-configurable (see services/workflow_transitions.py). Auto-closes the moment the first Release Material action is recorded against any resulting Purchase Order (Operations has visibly begun processing)."},
    {"rule_type": "quotation_expiring", "label": "Quotation expiring", "category": "quotation",
     "description": "Valid-until date falls within the next 3 days."},
    {"rule_type": "quotation_expired", "label": "Quotation expired", "category": "quotation",
     "description": "Valid-until date has passed but the quotation is still open."},
    {"rule_type": "payment_overdue", "label": "Payment overdue", "category": "payment",
     "description": f"Outstanding balance {PAYMENT_OVERDUE_DAYS}+ days after order confirmation."},
    {"rule_type": "payment_partial", "label": "Partial payment", "category": "payment",
     "description": "Some payment received; balance still pending, still fresh."},
    {"rule_type": "purchase_dispatched", "label": "Purchase dispatched", "category": "dispatch",
     "description": "Goods have shipped but not every line is delivered yet."},
    {"rule_type": "purchase_delivered", "label": "Purchase delivered", "category": "delivery",
     "description": f"All items delivered within the last {DELIVERED_RECENCY_DAYS} days."},
    {"rule_type": "customer_inactive", "label": "Customer inactive", "category": "sales",
     "description": f"No quotation activity for {CUSTOMER_INACTIVE_DAYS}+ days."},
    {"rule_type": "shortage_reorder", "label": "Awaiting reorder", "category": "purchase",
     "description": "A transfer left this customer's original order under-fulfilled — recommend a reorder PO."},
]
RULE_DEFINITIONS = [rule for rule in RULE_DEFINITIONS if rule["rule_type"] not in POST_ORDER_RULES and rule["category"] not in POST_ORDER_CATEGORIES]



# ─────────────────────────────────────────────────────────────────────────────
# Small date helpers (all UTC storage; bucketing is IST-aware for a good feel)
# ─────────────────────────────────────────────────────────────────────────────
def parse_iso(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:  # noqa: BLE001
        return None


def age_days(dt: Optional[datetime]) -> int:
    if not dt:
        return 0
    now = datetime.now(timezone.utc)
    return max(0, (now - dt).days)


def money_short(v: float) -> str:
    v = float(v or 0)
    if v >= 100000:
        return f"{v / 100000:.1f}L"
    if v >= 1000:
        return f"{v / 1000:.0f}K"
    return f"{int(v)}"


def ist_day_bounds_utc(offset_days: int = 0) -> tuple[datetime, datetime]:
    """UTC [start, end) of "today + offset_days" measured in IST — used so
    daily insight counters line up with the salesperson's actual day."""
    now_ist = datetime.now(timezone.utc).astimezone(IST) + timedelta(days=offset_days)
    start_ist = now_ist.replace(hour=0, minute=0, second=0, microsecond=0)
    end_ist = start_ist + timedelta(days=1)
    return start_ist.astimezone(timezone.utc), end_ist.astimezone(timezone.utc)


def compute_bucket(f: dict) -> str:
    """Overdue | today | tomorrow | this_week | later | completed | snoozed."""
    status = f.get("status")
    if status in ("done", "dismissed"):
        return "completed"
    if status == "snoozed" and f.get("snoozed_until"):
        return "snoozed"
    due = parse_iso(f.get("due_at"))
    if not due:
        return "later"
    now = datetime.now(timezone.utc)
    due_date = due.astimezone(IST).date()
    today_date = now.astimezone(IST).date()
    delta = (due_date - today_date).days
    if delta < 0:
        return "overdue"
    if delta == 0:
        return "today"
    if delta == 1:
        return "tomorrow"
    if delta <= 7:
        return "this_week"
    return "later"


def _followup_sort_key(d: dict, current_user_id: Optional[str]) -> tuple:
    """Overdue always first (business-wide urgency, regardless of who it's
    assigned to), then unresolved rows (open/snoozed) ahead of done/dismissed
    ones (overdue implies unresolved, so these two terms never conflict),
    then cards assigned to the requesting user (so a manager's assignment is
    impossible to miss), then priority score, then soonest due. Used by GET
    /followups — see
    docs/superpowers/specs/2026-07-27-followups-revamp-design.md."""
    return (
        0 if d.get("bucket") == "overdue" else 1,
        0 if d.get("status") in ("open", "snoozed") else 1,
        0 if current_user_id and (d.get("assigned_to") == current_user_id or any(a.get("user_id") == current_user_id and a.get("floor_id") == d.get("floor_id") for a in d.get("assignments", []))) else 1,
        -(d.get("priority_score") or 0),
        d.get("due_at") or "",
    )


# ─────────────────────────────────────────────────────────────────────────────
# Deterministic scoring — explainable, no LLM. See PRD for weight rationale:
# value (0-25) + silence (0-20) + urgency (0-35, rule-specific) + tier (0-10).
# ─────────────────────────────────────────────────────────────────────────────
def score_followup(value: float, days_since_contact: int, urgency_pts: int, tier: str) -> tuple[int, str]:
    value_pts = min(25, round((value or 0) / 100000 * 4))
    contact_pts = min(20, days_since_contact * 2)
    tier_pts = {"vip": 10, "trade": 5, "retail": 0}.get(tier, 0)
    urgency_pts = min(35, max(0, urgency_pts))
    score = int(min(100, value_pts + contact_pts + urgency_pts + tier_pts))
    level = "critical" if score >= 80 else "high" if score >= 60 else "medium" if score >= 35 else "low"
    return score, level


def reason_factors_for(value: float, days_since_contact: int, urgency_bullet: str, tier: str) -> list[str]:
    out: list[str] = []
    if value and value >= 10000:
        out.append(f"₹{money_short(value)} at stake")
    if days_since_contact >= 2:
        out.append(f"No contact for {days_since_contact} days")
    if urgency_bullet:
        out.append(urgency_bullet)
    if tier == "vip":
        out.append("VIP customer")
    elif tier == "trade":
        out.append("Trade customer")
    return out


def _followup_floor_id(quotation: Optional[dict], purchase: Optional[dict]) -> str:
    """Automated follow-ups inherit floor_id from whichever source document
    triggered the rule — never a hardcoded default that would silently mix
    floors once ground-floor quotations/purchases exist."""
    return floor_inherit(quotation) if quotation else floor_inherit(purchase or {})


def build_whatsapp_message(f: dict) -> str:
    """Generic, honest message builder — no fabricated tracking claims."""
    name = (f.get("customer_name") or "there").split()[0]
    category = f.get("category")
    lines: list[str]
    if category == "payment":
        lines = [
            f"Hi {name},",
            "",
            f"This is a reminder regarding order {f.get('quotation_number') or ''}.",
            f"Outstanding balance: ₹{money_short(f.get('value', 0))}.",
            "",
            "Kindly share the payment update at your convenience. Thank you!",
            "— BuildCon House",
        ]
    elif category == "quotation":
        lines = [
            f"Hi {name},",
            "",
            f"Following up on quotation {f.get('quotation_number') or ''}.",
            f.get("reason") or "",
            "",
            "Happy to answer any questions or share a revised quote.",
            "— BuildCon House",
        ]
    elif category in ("dispatch", "delivery"):
        lines = [f"Hi {name},", "", f.get("reason") or "", "", "— BuildCon House"]
    else:
        lines = [f"Hi {name},", "", f.get("reason") or "Just checking in!", "", "— BuildCon House"]
    return "\n".join([line for line in lines if line is not None])


async def last_contact_map(customer_ids: list[str]) -> dict[str, datetime]:
    if not customer_ids:
        return {}
    docs = await db.followups.find(
        {"customer_id": {"$in": customer_ids}, "last_contacted_at": {"$ne": None}},
        {"_id": 0, "customer_id": 1, "last_contacted_at": 1},
    ).to_list(10000)
    out: dict[str, datetime] = {}
    for d in docs:
        dt = parse_iso(d.get("last_contacted_at"))
        if dt and (d["customer_id"] not in out or dt > out[d["customer_id"]]):
            out[d["customer_id"]] = dt
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Tile Selections / Tile Quotations — dedicated, configurable-cadence producer
# (Follow-ups 2.0 redesign). "Selection" and "Quotation" here are NOT separate
# entities — both live in the `quotations` collection distinguished by
# doc_type (see models.Quotation.doc_type), so this producer just reads the
# same `quotations` list the rest of reconcile_followups() already loaded.
# Auto-close is FREE: once a Selection's doc_type flips to "tiles_quotation"
# (routes/quotation_routes.py move_to_quotation) or a Quotation's status
# advances past "waiting", it simply stops appearing in this producer's
# output — the generic persist loop in reconcile_followups() already marks
# any previously-automated key that's no longer desired as auto_resolved.
# ─────────────────────────────────────────────────────────────────────────────
_STAGE_LABELS = {1: "Gentle reminder", 2: "waiting — call customer", 3: "High priority", 4: "Manager attention"}


async def _tiles_pipeline_producer(quotations: list[dict], customers: dict[str, dict], contact_map: dict) -> dict[str, dict]:
    from services.automation_rules import get_offsets

    selection_offsets = await get_offsets("selection")
    quotation_offsets = await get_offsets("quotation_tiles")
    out: dict[str, dict] = {}

    def build(q: dict, cust: dict, offsets: list[int], rule_type: str, category: str, label_word: str) -> None:
        created_at = parse_iso(q.get("created_at"))
        first_offset = offsets[0] if offsets else 2
        if not created_at:
            return
        days_waiting = age_days(created_at)
        if days_waiting < first_offset:
            return
        stage = min(4, sum(1 for o in offsets if days_waiting >= o))
        stage_label = _STAGE_LABELS.get(stage, "Follow-up due")
        value = float(q.get("grand_total") or 0)
        tier = cust.get("tier", "retail")
        last_contact = contact_map.get(cust["id"]) or created_at
        days_since_contact = age_days(last_contact)
        urgency_pts = min(35, days_waiting * 3)
        score, level = score_followup(value, days_since_contact, urgency_pts, tier)
        if stage >= 4:
            level = "critical"
        out[f"{rule_type}:{q['id']}"] = {
            "rule_type": rule_type, "category": category,
            "customer_id": cust["id"], "customer_name": cust.get("company") or cust.get("name"),
            "customer_phone": cust.get("phone"), "customer_tier": tier,
            "quotation_id": q["id"], "quotation_number": q.get("number"),
            "purchase_id": None, "purchase_number": None, "project_name": q.get("project_name"),
            "value": round(value, 2),
            "reason": f"{label_word} {q.get('number')} waiting {days_waiting} day(s) — {stage_label}.",
            "reason_factors": reason_factors_for(value, days_since_contact, f"{label_word} waiting {days_waiting} day(s)", tier),
            "next_action": "Call customer", "next_action_reason": stage_label,
            "suggested_channel": "call" if stage < 3 else "whatsapp",
            "priority_score": score, "priority_level": level,
            "tags": [tier.upper(), "TILES"], "due_at": now_iso(),
            "floor_id": _followup_floor_id(q, None),
        }

    for q in quotations:
        if q.get("customer_outcome") in {"won", "lost"}:
            continue
        cust = customers.get(q.get("customer_id"))
        if not cust or not q.get("items"):
            continue
        doc_type = q.get("doc_type")
        status = q.get("status")
        if doc_type == "tiles_selection" and status not in ("rejected", "lost"):
            build(q, cust, selection_offsets, "selection_waiting", "selection", "Selection")
        elif doc_type == "tiles_quotation" and status not in ("approved", "won", "ordered", "rejected", "lost"):
            build(q, cust, quotation_offsets, "quotation_tiles_waiting", "quotation", "Quotation")
    return out


async def _walkin_producer(customers: dict[str, dict], contact_map: dict) -> dict[str, dict]:
    """Walk-ins (Phase 4). Same shape as _tiles_pipeline_producer above —
    reads the customer's own `visited_at`, escalates via the existing
    generic score_followup(), and auto-closes for free once status leaves
    WALKIN_OPEN_STATUSES (Selection created for that customer)."""
    from models_walkins import WALKIN_OPEN_STATUSES
    from services.automation_rules import get_offsets

    offsets = await get_offsets("walk_in")
    first_offset = offsets[0] if offsets else 1
    out: dict[str, dict] = {}
    walkins = await db.walkins.find(
        {"status": {"$in": WALKIN_OPEN_STATUSES}, "is_deleted": False}, {"_id": 0},
    ).to_list(5000)
    for w in walkins:
        if w.get("scope_followup_id") or w.get("showroom_followup_id") or w.get("showroom_transferred_at"):
            continue
        cust = customers.get(w.get("customer_id")) or {"id": w.get("customer_id"), "tier": "retail"}
        visited_at = parse_iso(w.get("visited_at"))
        if not visited_at:
            continue
        days_waiting = age_days(visited_at)
        if days_waiting < first_offset:
            continue
        stage = min(4, sum(1 for o in offsets if days_waiting >= o))
        stage_label = _STAGE_LABELS.get(stage, "Follow-up due")
        tier = cust.get("tier", "retail")
        last_contact = contact_map.get(w.get("customer_id")) or visited_at
        days_since_contact = age_days(last_contact)
        urgency_pts = min(35, days_waiting * 4)  # walk-ins escalate a little faster than Selections (shorter cadence)
        score, level = score_followup(0, days_since_contact, urgency_pts, tier)
        if stage >= 4:
            level = "critical"
        out[f"walk_in_new:{w['id']}"] = {
            "rule_type": "walk_in_new", "category": "walk_in",
            "customer_id": w.get("customer_id"), "customer_name": w.get("customer_name"),
            "customer_phone": w.get("customer_phone"), "customer_tier": tier,
            "quotation_id": None, "quotation_number": None,
            "purchase_id": None, "purchase_number": None, "project_name": None,
            "value": 0.0,
            "reason": f"Walk-in {w.get('number')} waiting {days_waiting} day(s) — {stage_label}.",
            "reason_factors": reason_factors_for(0, days_since_contact, f"Walk-in waiting {days_waiting} day(s)", tier),
            "next_action": "Call customer", "next_action_reason": stage_label,
            "suggested_channel": "call" if stage < 3 else "whatsapp",
            "priority_score": score, "priority_level": level,
            "tags": [tier.upper(), "WALK_IN"], "due_at": now_iso(),
            "floor_id": w.get("floor_id"),
        }
    return out


async def _operational_followup_producer(quotations: list[dict], customers: dict[str, dict]) -> dict[str, dict]:
    """Orders continue through Operations; sales follow-ups stop at placement."""
    return {}

# from many routes (quotation/payment/PO/dispatch mutations, plus
# move_to_quotation added this session). Without serialization, two overlapping
# runs both read `existing` before either has written, both see a brand-new
# source_key as "not yet created", and both insert — a real duplicate-card
# race, caught by testing. A process-local lock is the correct, minimal fix:
# it doesn't change the reconciliation algorithm at all, it just guarantees
# runs never interleave, so every run's read-then-write sees the previous
# run's writes.
# ─────────────────────────────────────────────────────────────────────────────
_reconcile_lock = asyncio.Lock()
_reconcile_requested = False


async def followup_worker() -> None:
    """Re-evaluate time-based reminders even when no business record changes.

    Runs after readiness and shares the mutation reconciler's coalescing lock.
    The five-minute polling interval never changes configured reminder dates.
    """
    logger = logging.getLogger("forge.followups")
    while True:
        try:
            await reconcile_followups_admitted()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Follow-up reconciliation failed; retrying next cycle")
        await asyncio.sleep(300)


async def reconcile_followups_admitted() -> dict:
    from services.mutation_admission import admission
    async with admission(db):
        return await reconcile_followups()


async def reconcile_followups() -> dict:
    global _reconcile_requested
    if customer_reset_maintenance():
        return {"skipped": True, "reason": "customer reset maintenance"}
    if _reconcile_lock.locked():
        # The active pass may already have read its quotation snapshot before
        # this caller's mutation. Coalesce concurrent requests into one fresh
        # pass instead of losing that change until the periodic worker runs.
        _reconcile_requested = True
        return {"skipped": True, "reason": "reconcile already in progress"}
    async with _reconcile_lock:
        while True:
            _reconcile_requested = False
            result = await _reconcile_followups_locked()
            if not _reconcile_requested:
                return result


async def _persist_desired_followups(
    desired: dict[str, dict], quotation_created_by: dict[str, str] | None = None,
) -> dict:
    """Write the reconciler's desired state: upsert what should exist, resolve
    what should not.

    Split out from `_reconcile_followups_locked` so the write half is testable
    without standing up the entire quotation/payment/purchase corpus the
    desired-state half needs. Behaviour is unchanged.
    """
    desired = {key: fields for key, fields in desired.items() if fields.get("category") not in POST_ORDER_CATEGORIES and fields.get("rule_type") not in POST_ORDER_RULES and not fields.get("purchase_id")}
    quotation_created_by = quotation_created_by or {}
    existing = await db.followups.find(
        {"is_automated": True, "status": {"$in": ["open", "snoozed"]}}, {"_id": 0},
    ).to_list(10000)
    existing_by_key = {f["source_key"]: f for f in existing if f.get("source_key")}
    # `source_key` is uniquely indexed across ALL statuses, so a key still held
    # by a completed or dismissed row cannot be inserted again. Reading only
    # open/snoozed rows above therefore made the engine attempt a duplicate
    # insert for any trigger a human had already closed while its condition
    # still held — E11000 aborted the entire pass, and because all 15 mutation
    # routes fire this fire-and-forget, follow-up automation silently stopped
    # app-wide (no new cards, no auto-resolution) with only a startup WARNING
    # to show for it. Skipping these keys is also the correct behaviour on its
    # own terms: a closed follow-up means the work was handled, and resurrecting
    # it would reopen finished work every reconcile.
    closed_keys = {
        d["source_key"]
        async for d in db.followups.find(
            {"is_automated": True, "status": {"$nin": ["open", "snoozed"]},
             "source_key": {"$ne": None}},
            {"_id": 0, "source_key": 1},
        )
    }

    created = updated = resolved = 0
    for key, fields in desired.items():
        ex = existing_by_key.pop(key, None)
        if ex:
            if ex.get("status") == "open":
                patch = {k: v for k, v in fields.items() if k != "due_at"}
                patch["updated_at"] = now_iso()
                await db.followups.update_one({"id": ex["id"]}, {"$set": patch})
                updated += 1
            # snoozed rows are left completely untouched — respect the snooze.
        elif key in closed_keys:
            # Already handled by a human — do not recreate it.
            continue
        else:
            f = Followup(source_key=key, is_automated=True, **fields)
            try:
                await db.followups.insert_one(f.model_dump())
            except DuplicateKeyError:
                # Belt and braces against a concurrent writer between the read
                # above and this insert. One card must never be able to abort
                # the whole reconciliation again.
                continue
            created += 1
            # Operational handoff follow-ups (2026-08) must show up on the
            # customer's unified timeline the moment they're created — every
            # other producer's card creation is silent by design (the
            # Follow-ups list IS its visibility), but this one is a
            # cross-team business-event handoff worth a permanent audit row.
            if fields.get("rule_type") == "order_confirmed_ops":
                await log_event(
                    event_type="quotation.order_confirmed_followup_created", entity_type="followup", entity_id=f.id,
                    customer_id=fields.get("customer_id"), quotation_id=fields.get("quotation_id"),
                    actor_name="Automation", summary=fields.get("reason"),
                    floor_id=fields.get("floor_id"),
                )
            # Nudge the rep who owns this customer's quotation the moment a
            # new high-priority follow-up appears — this is the ONLY place
            # in the app that ever wrote a Notification before this fix
            # existed only as a one-time demo seed.
            if fields.get("priority_level") in ("critical", "high"):
                recipient = quotation_created_by.get(fields.get("quotation_id"))
                await notify(
                    recipient,
                    f"Follow-up needed · {fields.get('customer_name')}",
                    body=fields.get("reason"),
                    kind="warning" if fields.get("priority_level") == "critical" else "info",
                    link=f"/customers/{fields.get('customer_id')}",
                    floor_id=fields.get("floor_id"),
                )

    for _key, ex in existing_by_key.items():
        await db.followups.update_one({"id": ex["id"]}, {"$set": {
            "status": "done", "auto_resolved": True, "completed_at": now_iso(),
            "resolution_note": "Resolved automatically — the trigger condition no longer applies.",
            "updated_at": now_iso(),
        }})
        resolved += 1
        await log_event(
            event_type="followup.auto_resolved", entity_type="followup", entity_id=ex["id"],
            customer_id=ex.get("customer_id"), quotation_id=ex.get("quotation_id"), purchase_id=ex.get("purchase_id"),
            actor_name="Automation", summary=f"Follow-up resolved automatically — {ex.get('reason')}",
            floor_id=ex.get("floor_id"),
        )

    return {"created": created, "updated": updated, "auto_resolved": resolved, "active": len(desired)}


async def _reconcile_followups_locked() -> dict:
    now = datetime.now(timezone.utc)

    customers = {c["id"]: c async for c in db.customers.find({}, {"_id": 0})}
    quotations = await db.quotations.find({}, {"_id": 0}).to_list(10000)
    contact_map = await last_contact_map(list(customers.keys()))

    desired: dict[str, dict] = {}

    def upsert(
        key: str, rule_type: str, category: str, customer: dict, *,
        quotation: Optional[dict] = None, purchase: Optional[dict] = None,
        value: float = 0.0, due_at: Optional[str] = None,
        urgency_bullet: str = "", urgency_pts: int = 15,
        reason: str = "", next_action: str = "", next_action_reason: str = "",
        channel: str = "call", tags: Optional[list[str]] = None,
        days_since_contact: int = 0,
    ) -> None:
        tier = customer.get("tier", "retail")
        score, level = score_followup(value, days_since_contact, urgency_pts, tier)
        factors = reason_factors_for(value, days_since_contact, urgency_bullet, tier)
        desired[key] = {
            "rule_type": rule_type, "category": category,
            "customer_id": customer["id"],
            "customer_name": customer.get("company") or customer.get("name"),
            "customer_phone": customer.get("phone"), "customer_tier": tier,
            "quotation_id": quotation.get("id") if quotation else None,
            "quotation_number": quotation.get("number") if quotation else None,
            "purchase_id": purchase.get("id") if purchase else None,
            "purchase_number": purchase.get("number") if purchase else None,
            "project_name": (quotation or {}).get("project_name"),
            "value": round(value, 2), "reason": reason, "reason_factors": factors,
            "next_action": next_action, "next_action_reason": next_action_reason,
            "suggested_channel": channel, "priority_score": score, "priority_level": level,
            "tags": tags or [], "due_at": due_at or now_iso(),
            "floor_id": _followup_floor_id(quotation, purchase),
        }

    # ---- Quotation-based rules ------------------------------------------------
    for q in quotations:
        if q.get("customer_outcome") in {"won", "lost"}:
            continue
        cust = customers.get(q.get("customer_id"))
        if not cust or not q.get("items"):
            continue
        tier = cust.get("tier", "retail")
        value = float(q.get("grand_total") or 0)
        status = q.get("status")
        created_at = parse_iso(q.get("created_at"))
        updated_at = parse_iso(q.get("updated_at")) or created_at
        last_contact = contact_map.get(cust["id"]) or updated_at
        days_since_contact = age_days(last_contact)
        tags = [tier.upper()] + ([q["reference_source"]] if q.get("reference_source") else [])

        if status in ("draft", "sent", "pending_approval") and created_at and q.get("doc_type") not in ("tiles_selection", "tiles_quotation"):
            q_floor_id = _followup_floor_id(q, None)
            due = quotation_followup_due_at(created_at, q_floor_id)
            if due:
                is_selection = q.get("doc_type") == "tiles_selection"
                age_created = age_days(created_at)
                upsert(
                    f"quotation_followup:{q['id']}", "quotation_followup", "quotation", cust,
                    quotation=q, value=value, due_at=due.isoformat(),
                    urgency_bullet=f"No follow-up since it was created {age_created} days ago", urgency_pts=20,
                    reason=(
                        f"{'Selection' if is_selection else 'Quotation'} created {age_created} day(s) ago — "
                        f"₹{money_short(value)}. Time to follow up."
                    ),
                    next_action="Call customer",
                    next_action_reason=f"{quotation_followup_delay_days(q_floor_id)}-day follow-up window has passed.",
                    channel="call", tags=tags, days_since_contact=days_since_contact,
                )

        if status in ("sent", "pending_approval", "approved") and q.get("valid_until"):
            valid_until = parse_iso(q["valid_until"])
            if valid_until:
                days_left = (valid_until.astimezone(IST).date() - now.astimezone(IST).date()).days
                if 0 <= days_left <= 3:
                    label = "today" if days_left == 0 else "tomorrow" if days_left == 1 else f"in {days_left} days"
                    urgency = {0: 35, 1: 32, 2: 26, 3: 20}.get(days_left, 15)
                    upsert(
                        f"quotation_expiring:{q['id']}", "quotation_expiring", "quotation", cust,
                        quotation=q, value=value, due_at=valid_until.isoformat(),
                        urgency_bullet=f"Quotation expires {label}", urgency_pts=urgency,
                        reason=f"Quotation expires {label} — ₹{money_short(value)}.",
                        next_action="Call customer",
                        next_action_reason=f"Quotation expires {label} — confirm before it lapses.",
                        channel="call", tags=tags, days_since_contact=days_since_contact,
                    )
                elif -14 <= days_left < 0:
                    days_expired = abs(days_left)
                    upsert(
                        f"quotation_expired:{q['id']}", "quotation_expired", "quotation", cust,
                        quotation=q, value=value, due_at=valid_until.isoformat(),
                        urgency_bullet=f"Quotation expired {days_expired}d ago", urgency_pts=34,
                        reason=f"Quotation expired {days_expired} day(s) ago — still open at ₹{money_short(value)}.",
                        next_action="Share revised quotation",
                        next_action_reason="Original quotation has lapsed — send a fresh one to re-engage.",
                        channel="whatsapp", tags=tags, days_since_contact=days_since_contact,
                    )

    # ---- Tile Selections / Tile Quotations (Follow-ups 2.0 workspaces) --------
    desired.update(await _tiles_pipeline_producer(quotations, customers, contact_map))

    # ---- Walk-ins (Phase 4) -----------------------------------------------------
    desired.update(await _walkin_producer(customers, contact_map))

    # ---- Customer-inactivity rule -----------------------------------------------
    quotations_by_customer: dict[str, list[dict]] = {}
    for q in quotations:
        if q.get("customer_outcome") in {"won", "lost"}:
            continue
        quotations_by_customer.setdefault(q["customer_id"], []).append(q)

    for cid, cust in customers.items():
        cqs = quotations_by_customer.get(cid)
        if not cqs or any(q.get("status") == "ordered" for q in cqs):
            continue
        touches = [parse_iso(q.get("updated_at")) for q in cqs]
        touches = [t for t in touches if t]
        if not touches:
            continue
        last_touch = max(touches)
        days_silent = age_days(last_touch)
        if days_silent >= CUSTOMER_INACTIVE_DAYS:
            last_q = max(cqs, key=lambda q: q.get("updated_at") or "")
            value = float(last_q.get("grand_total") or 0)
            upsert(
                f"customer_inactive:{cid}", "customer_inactive", "sales", cust,
                quotation=last_q, value=value, due_at=now_iso(),
                urgency_bullet=f"No activity for {days_silent} days", urgency_pts=15,
                reason=f"No activity for {days_silent} days — last quotation was ₹{money_short(value)}.",
                next_action="Call customer",
                next_action_reason="Reconnect before they choose another vendor.",
                channel="call", tags=[cust.get("tier", "retail").upper()], days_since_contact=days_silent,
            )

    ordered_customers = {(q.get("floor_id"), q.get("customer_id")) for q in quotations if q.get("status") == "ordered"}
    desired = {key: fields for key, fields in desired.items() if (fields.get("floor_id"), fields.get("customer_id")) not in ordered_customers}
    # ---- Persist: upsert desired, auto-resolve stale --------------------------
    quotation_created_by = {q["id"]: q.get("created_by") for q in quotations}
    return await _persist_desired_followups(desired, quotation_created_by)
