"""Reusable Customer duplicate-detection service (2026-08).

Confidence-tiered matching, per the CRM foundation spec:
  HIGH   — primary phone OR alternate phone matches (either direction).
           Treated as the same customer automatically — callers should
           reuse this customer, never create a new one, no staff prompt.
  MEDIUM — email matches, OR (name + city) both match, OR (name + address)
           both match. Requires an explicit staff decision before either
           reusing or creating a new customer (ambiguous — could be a
           different family member at the same address, a typo, etc).
  LOW    — name similarity only (case-insensitive substring either way).
           Informational only — NEVER blocks customer creation.

Deliberately entity-agnostic (no Walk-in-specific fields) so it can be
called from Walk-ins today and from Customers/imports/API integrations
later without duplicating matching logic — see routes/walkin_routes.py for
the current caller.
"""
from __future__ import annotations

import re
from typing import Optional

from db import db

_PROJECTION = {
    "_id": 0, "id": 1, "name": 1, "company": 1, "phone": 1, "alternate_phone": 1,
    "email": 1, "city": 1, "address": 1, "tier": 1, "created_at": 1,
}
_MAX_PER_TIER = 5


def _digits(phone: Optional[str]) -> str:
    return "".join(c for c in (phone or "") if c.isdigit())


def _fuzzy_digit_pattern(digits: str) -> str:
    """Builds a regex that matches `digits` even if the stored value has
    spaces/dashes between digits (e.g. "+91 98200 12345" must still match
    a typed "9820012345") — phones in this DB are stored with human
    formatting, not normalized, so a literal suffix match silently misses
    real duplicates. Anchored at the end ($) so a stored value with a
    country-code prefix (+91) still matches on the trailing local number."""
    return "[^0-9]*".join(re.escape(d) for d in digits) + "$"


async def find_customer_matches(
    *,
    phone: Optional[str] = None,
    alternate_phone: Optional[str] = None,
    email: Optional[str] = None,
    name: Optional[str] = None,
    city: Optional[str] = None,
    address: Optional[str] = None,
    floor_ids: Optional[list[str]] = None,
) -> dict:
    """`floor_ids` restricts matching to those business units.

    It is not optional in practice — every caller passes one. Customer records
    are floor-scoped, so an unrestricted search both leaked another unit's
    contact details (name, company, both phone numbers, email, address) to
    anyone who could type a name, and let a HIGH-confidence phone match
    silently attach a walk-in to a customer belonging to the other business.
    """
    floor_scope: list[dict] = [{"floor_id": {"$in": floor_ids}}] if floor_ids is not None else []

    def scoped(criteria: dict) -> dict:
        return {"$and": [*floor_scope, criteria]} if floor_scope else criteria

    phone_digits = _digits(phone)
    alt_digits = _digits(alternate_phone)
    phone_candidates = [d for d in (phone_digits, alt_digits) if d]

    high: list[dict] = []
    seen_ids: set[str] = set()
    if phone_candidates:
        high = await db.customers.find(
            scoped({"$or": (
                [{"phone": {"$regex": _fuzzy_digit_pattern(d)}} for d in phone_candidates]
                + [{"alternate_phone": {"$regex": _fuzzy_digit_pattern(d)}} for d in phone_candidates]
            )}),
            _PROJECTION,
        ).to_list(_MAX_PER_TIER)
        seen_ids = {c["id"] for c in high}

    medium: list[dict] = []
    email_norm = (email or "").strip().lower()
    name_norm = (name or "").strip().lower()
    city_norm = (city or "").strip().lower()
    address_norm = (address or "").strip().lower()

    medium_or: list[dict] = []
    if email_norm:
        medium_or.append({"email": email_norm})
    if name_norm and city_norm:
        medium_or.append({"name": {"$regex": f"^{re.escape(name_norm)}$", "$options": "i"}, "city": {"$regex": f"^{re.escape(city_norm)}$", "$options": "i"}})
    if name_norm and address_norm:
        medium_or.append({"name": {"$regex": f"^{re.escape(name_norm)}$", "$options": "i"}, "address": {"$regex": re.escape(address_norm[:40]), "$options": "i"}})
    if medium_or:
        candidates = await db.customers.find(scoped({"$or": medium_or}), _PROJECTION).to_list(_MAX_PER_TIER + len(seen_ids))
        medium = [c for c in candidates if c["id"] not in seen_ids][:_MAX_PER_TIER]
        seen_ids |= {c["id"] for c in medium}

    low: list[dict] = []
    if name_norm and len(name_norm) >= 3:
        candidates = await db.customers.find(
            scoped({"name": {"$regex": re.escape(name_norm[:30]), "$options": "i"}}), _PROJECTION,
        ).to_list(_MAX_PER_TIER + len(seen_ids))
        low = [c for c in candidates if c["id"] not in seen_ids][:_MAX_PER_TIER]

    return {"high": high, "medium": medium, "low": low}
