"""Shared follow-up adapter for the Kitchen/Furniture digital notebook.

The notebook is a projection and constrained write surface over the existing
``followups`` collection. It deliberately does not expose the broader CRM
and automation fields carried by :class:`models.Followup`.
"""
from __future__ import annotations

import re
from typing import Any
from uuid import uuid4

from pymongo.errors import DuplicateKeyError

from models import now_iso


NOTEBOOK_STATUSES: frozenset[str] = frozenset({"new", "pending", "won", "lost"})
KITCHEN_TYPES: frozenset[str] = frozenset({"GI", "SS"})
KITCHEN_FLOOR_ID = "second-floor"

NOTEBOOK_FIELDS: frozenset[str] = frozenset({
    "customer_name", "customer_phone", "address", "kitchen_type",
    "referred_by", "architect_interior_designer", "notebook_status", "notes",
})
QUOTATION_FIELDS: frozenset[str] = frozenset({
    "quotation_price",
})
SEARCH_FIELDS: tuple[str, ...] = (
    "customer_name", "customer_phone", "address",
    "architect_interior_designer", "referred_by", "notes",
)


class NotebookValidationError(ValueError):
    """Raised when a notebook write violates its public contract."""


class NotebookConflictError(RuntimeError):
    """Raised when a row changed after the client read its revision."""

    def __init__(self, row: dict[str, Any], changed_fields: list[str] | None = None):
        self.row = row
        self.changed_fields = changed_fields or []
        super().__init__("Notebook row changed by another user")


def normalize_mobile(value: str) -> str:
    """Normalize common Indian phone formatting to the last ten digits."""
    digits = re.sub(r"\D", "", value or "")
    if len(digits) > 10:
        digits = digits[-10:]
    return digits


def notebook_projection(*, converted: bool) -> dict[str, int]:
    fields = {
        "id": 1,
        "customer_name": 1,
        "customer_phone": 1,
        "address": 1,
        "kitchen_type": 1,
        "referred_by": 1,
        "referrer_id": 1,
        "referrer_name": 1,
        "referrer_type": 1,
        "architect_interior_designer": 1,
        "notebook_status": 1,
        "notes": 1,
        "lost_reason": 1,
        "is_converted": 1,
        "converted_at": 1,
        "last_contacted_at": 1,
        "contact_attempts": 1,
        "updated_at": 1,
        "floor_id": 1,
    }
    if converted:
        fields.update({field: 1 for field in QUOTATION_FIELDS})
    return fields


def serialize_notebook_row(document: dict[str, Any]) -> dict[str, Any]:
    """Return only notebook-facing fields plus stable identity metadata."""
    converted = bool(document.get("is_converted"))
    row = {
        "id": document.get("id"),
        "customer_name": document.get("customer_name") or "",
        "customer_phone": document.get("customer_phone") or "",
        "address": document.get("address") or "",
        "kitchen_type": document.get("kitchen_type") or "",
        "referred_by": document.get("referred_by") or "",
        "referrer_id": document.get("referrer_id"),
        "referrer_name": document.get("referrer_name") or document.get("architect_interior_designer") or "",
        "referrer_type": document.get("referrer_type"),
        "architect_interior_designer": document.get("architect_interior_designer") or "",
        "status": document.get("notebook_status") or "new",
        "notes": document.get("notes") or "",
        "lost_reason": document.get("lost_reason") or "",
        "is_converted": converted,
        "converted_at": document.get("converted_at"),
        "last_contacted_at": document.get("last_contacted_at"),
        "contact_attempts": document.get("contact_attempts") or 0,
        "updated_at": document.get("updated_at"),
    }
    if converted:
        row.update({
            "quotation_price": document.get("quotation_price"),
        })
    return row


def _merged(current: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    result = dict(current)
    result.update(patch)
    return result


def validate_notebook_patch(
    patch: dict[str, Any], *, converted: bool, current: dict[str, Any], creating: bool = False,
    floor_id: str | None = None,
) -> dict[str, Any]:
    """Validate and normalize a notebook patch; return a safe copy."""
    # Quote fields are known notebook fields even before conversion; reporting
    # the specific conversion error is more useful than treating them as an
    # unknown field.
    allowed = NOTEBOOK_FIELDS | QUOTATION_FIELDS
    unknown = set(patch) - allowed
    if unknown:
        raise NotebookValidationError(f"unsupported field: {sorted(unknown)[0]}")

    clean = dict(patch)
    if "customer_phone" in clean:
        clean["customer_phone"] = normalize_mobile(str(clean["customer_phone"]))
    merged = _merged(current, clean)

    if creating or "customer_name" in clean:
        if not str(merged.get("customer_name") or "").strip():
            raise NotebookValidationError("customer_name is required")
    if creating or "customer_phone" in clean:
        phone = normalize_mobile(str(merged.get("customer_phone") or ""))
        if not phone:
            raise NotebookValidationError("customer_phone is required")
        if len(phone) != 10:
            raise NotebookValidationError("customer_phone must contain 10 digits")
    requires_kitchen_type = floor_id in (None, KITCHEN_FLOOR_ID)
    if requires_kitchen_type and (creating or "kitchen_type" in clean):
        if merged.get("kitchen_type") not in KITCHEN_TYPES:
            raise NotebookValidationError("kitchen_type must be GI or SS")
    if not requires_kitchen_type and "kitchen_type" in clean:
        raise NotebookValidationError("kitchen_type is only available on Kitchen Floor")

    status = merged.get("notebook_status") or "new"
    if status not in NOTEBOOK_STATUSES:
        raise NotebookValidationError("notebook_status is invalid")
    previous_status = current.get("notebook_status") or "new"
    if previous_status == "won" and any(field not in QUOTATION_FIELDS for field in clean):
        raise NotebookValidationError("Won follow-ups are locked")
    if previous_status == "won" and status != "won":
        raise NotebookValidationError("Won cannot return to another status")
    if status == "lost" and not str(merged.get("notes") or "").strip():
        raise NotebookValidationError("Notes are required before marking Lost")
    if status == "won" and previous_status != "won":
        raise NotebookValidationError("Won is recorded only after an order is placed")
    for field in QUOTATION_FIELDS:
        if field in clean and not converted:
            raise NotebookValidationError("quotation fields require conversion")
    for field in ("quotation_price",):
        if field in clean and clean[field] is not None:
            try:
                if float(clean[field]) < 0:
                    raise NotebookValidationError(f"{field} cannot be negative")
            except (TypeError, ValueError):
                raise NotebookValidationError(f"{field} must be a number")
    return clean


def timeline_event_for_field(field: str, old_value: Any, new_value: Any) -> tuple[str, str]:
    if field == "notebook_status":
        status = str(new_value or "").replace("_", " ").title()
        return "project_followup.status_changed", f"Status changed to {status}"
    if field in QUOTATION_FIELDS:
        return "project_followup.quotation_updated", f"{field.replace('_', ' ').title()} updated"
    if field in {"customer_name", "customer_phone", "address"}:
        return "project_followup.customer_updated", f"{field.replace('_', ' ').title()} updated"
    return "project_followup.edited", f"{field.replace('_', ' ').title()} updated"


def notebook_search_query(query: str) -> dict[str, Any] | None:
    if not query.strip():
        return None
    escaped = re.escape(query.strip())
    term = {"$regex": escaped, "$options": "i"}
    return {"$or": [{field: term} for field in SEARCH_FIELDS]}


def notebook_query(user: Any, floor_id: str, extra: dict[str, Any] | None = None) -> dict[str, Any]:
    """Build a query pinned to the notebook route's explicit floor.

    Notebook URLs address a concrete department.  Using the caller's ambient
    active-floor header here made a valid Kitchen/Furniture request look empty
    whenever that header was stale or selected a different permitted floor.
    Routes authorize ``floor_id`` before calling this helper; the data query
    must then remain pinned to that same floor.
    """
    # Every shared Followup model carries ``notebook_key=None`` unless it is
    # an actual Kitchen/Furniture notebook row.  ``$exists`` therefore leaks
    # ordinary CRM/automation rows into the notebook; accept only real keys.
    base = {"floor_id": floor_id, "notebook_key": {"$type": "string"}}
    if extra:
        base.update(extra)
    return base


async def resolve_or_create_customer(
    db: Any, *, user: Any, floor_id: str, name: str, phone: str, address: str | None,
) -> dict[str, Any]:
    """Find or create one floor-scoped customer for a notebook row."""
    normalized = normalize_mobile(phone)
    if not normalized:
        raise NotebookValidationError("customer_phone is required")
    # The floor is explicit and pre-authorized by the notebook route.  Do not
    # additionally apply the user's ambient active-floor selection: it can be
    # stale and would split one floor's customers into duplicate identities.
    query = {"floor_id": floor_id, "phone_normalized": normalized}
    customer = await db.customers.find_one(query, {"_id": 0})
    if not customer:
        # Compatibility fallback for customers written before the normalized
        # field existed. The migration backfills it for indexed lookups.
        cursor = db.customers.find({"floor_id": floor_id}, {"_id": 0})
        for candidate in await cursor.to_list(10000):
            if normalize_mobile(candidate.get("phone") or "") == normalized:
                customer = candidate
                break
    if customer:
        return customer

    now = now_iso()
    document = {
        "id": str(uuid4()), "name": name.strip(), "phone": phone.strip(),
        "phone_normalized": normalized, "address": address, "tier": "retail",
        "floor_id": floor_id, "created_at": now, "updated_at": now,
        "portal_enabled": False, "tags": [],
    }
    try:
        await db.customers.insert_one(document)
    except DuplicateKeyError:
        customer = await db.customers.find_one(query, {"_id": 0})
        if customer:
            return customer
        raise
    return document


async def patch_notebook_row(
    db: Any, *, user: Any, floor_id: str, row_id: str, patch: dict[str, Any], expected_updated_at: str,
) -> dict[str, Any]:
    """Atomically apply one notebook patch against the observed revision."""
    query = notebook_query(user, floor_id, {"id": row_id})
    current = await db.followups.find_one(query, {"_id": 0})
    if not current:
        raise KeyError("Notebook row not found")
    if current.get("updated_at") != expected_updated_at:
        # A cell patch touches exactly one field, so the client can safely
        # highlight that cell after refreshing the current server row.
        raise NotebookConflictError(serialize_notebook_row(current), changed_fields=list(patch))
    clean = validate_notebook_patch(
        patch, converted=bool(current.get("is_converted")), current=current, floor_id=floor_id,
    )
    if not clean:
        return serialize_notebook_row(current)
    now = now_iso()
    result = await db.followups.update_one(
        {**query, "updated_at": expected_updated_at},
        {"$set": {**clean, "updated_at": now}},
    )
    if not result.matched_count:
        changed = await db.followups.find_one(query, {"_id": 0})
        raise NotebookConflictError(serialize_notebook_row(changed or current), changed_fields=list(patch))
    updated = await db.followups.find_one(query, {"_id": 0})
    return serialize_notebook_row(updated)


async def convert_notebook_row(
    db: Any, *, user: Any, floor_id: str, row_id: str, patch: dict[str, Any], expected_updated_at: str,
) -> dict[str, Any]:
    """Convert a row in place, or return the existing conversion on retry."""
    query = notebook_query(user, floor_id, {"id": row_id})
    current = await db.followups.find_one(query, {"_id": 0})
    if not current:
        raise KeyError("Notebook row not found")
    if current.get("is_converted"):
        return serialize_notebook_row(current)
    if (current.get("notebook_status") or "new") in {"lost", "won"}:
        raise NotebookValidationError("Closed follow-ups cannot be moved to quotation")
    if current.get("updated_at") != expected_updated_at:
        raise NotebookConflictError(
            serialize_notebook_row(current), changed_fields=[*patch.keys(), "is_converted"],
        )
    if patch.get("quotation_price") is None:
        raise NotebookValidationError("quotation_price is required to convert a follow-up")
    clean = validate_notebook_patch(patch, converted=True, current=current, floor_id=floor_id)
    now = now_iso()
    result = await db.followups.update_one(
        {**query, "updated_at": expected_updated_at},
        {"$set": {
            **clean,
            "is_converted": True,
            "converted_at": now,
            # A converted row remains an active quotation follow-up until it
            # is explicitly won or lost; it must not disappear from the
            # shared follow-up queue.
            "notebook_status": "pending",
            "updated_at": now,
        }},
    )
    if not result.matched_count:
        changed = await db.followups.find_one(query, {"_id": 0})
        raise NotebookConflictError(
            serialize_notebook_row(changed or current), changed_fields=[*patch.keys(), "is_converted"],
        )
    updated = await db.followups.find_one(query, {"_id": 0})
    return serialize_notebook_row(updated)


async def complete_notebook_row(
    db: Any, *, user: Any, floor_id: str, row_id: str, outcome: str,
    lost_reason: str | None, expected_updated_at: str,
    notes: str | None = None,
) -> dict[str, Any]:
    """Atomically close a notebook lead and its shared Followup record."""
    query = notebook_query(user, floor_id, {"id": row_id})
    current = await db.followups.find_one(query, {"_id": 0})
    if not current:
        raise KeyError("Notebook row not found")
    if current.get("updated_at") != expected_updated_at:
        raise NotebookConflictError(serialize_notebook_row(current), changed_fields=["status", "lost_reason"])
    if (current.get("notebook_status") or "new") in {"won", "lost"}:
        raise NotebookValidationError("This follow-up is already closed")
    if outcome == "lost" and not (lost_reason or "").strip():
        raise NotebookValidationError("A lost reason is required")
    if outcome == "won":
        from services.order_confirmation import has_placed_order
        if not await has_placed_order(db, current, floor_id=floor_id):
            raise NotebookValidationError("Won is recorded only after an order is placed")
    elif outcome != "lost":
        raise NotebookValidationError("Invalid follow-up outcome")

    now = now_iso()
    update = {
        "notebook_status": outcome,
        "status": "done" if outcome == "won" else "dismissed",
        "completed_outcome": outcome,
        "completed_at": now,
        "resolution_note": (lost_reason or "").strip() if outcome == "lost" else "Client won",
        "lost_reason": (lost_reason or "").strip() if outcome == "lost" else None,
        "updated_at": now,
    }
    if notes is not None:
        update["notes"] = notes
        if outcome == "won":
            update["resolution_note"] = notes
    result = await db.followups.update_one(
        {**query, "updated_at": expected_updated_at}, {"$set": update},
    )
    if not result.matched_count:
        changed = await db.followups.find_one(query, {"_id": 0})
        raise NotebookConflictError(serialize_notebook_row(changed or current), changed_fields=["status", "lost_reason"])
    updated = await db.followups.find_one(query, {"_id": 0})
    return serialize_notebook_row(updated)
