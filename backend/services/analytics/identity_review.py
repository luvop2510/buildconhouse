"""Human review of similar identities; canonical records are never merged here."""
from collections import defaultdict
from datetime import datetime, timezone
from hashlib import sha256
import unicodedata

from fastapi import HTTPException
from pymongo.errors import DuplicateKeyError

from services.analytics.unified import KINDS, MAX_RECORDS, _bounded, page_rows, scope_for
from services.referrer_identity import referrer_query


def normalized_name(value):
    return " ".join(unicodedata.normalize("NFKC", str(value or "")).casefold().split())


def review_key(kind, identities):
    return "sales-identity-review:" + sha256((kind + "\0" + "\0".join(sorted(identities))).encode()).hexdigest()


def public_review(doc):
    return {key: doc.get(key) for key in ("decision", "note", "reviewed_at", "reviewed_by_name", "revision")} if doc else None


async def identity_documents(db, q, floors, kind):
    if kind not in KINDS:
        raise HTTPException(422, "Choose a customer, product, company or architect directory")
    scope = scope_for(q, floors)
    match = {"floor_id": scope["floor_id"], "is_deleted": {"$ne": True}}
    if kind == "architects":
        match = referrer_query({"floor_id": scope["floor_id"]}, {"type": {"$in": ["architect", "interior_designer"]}})
    collection = {"companies": "brands", "products": "products", "architects": "referrers", "customers": "customers"}[kind]
    return await _bounded(db[collection].find(match, {"_id": 0, "id": 1, "name": 1, "floor_id": 1, "sku": 1, "status": 1, "active": 1}), "Identity review directory", MAX_RECORDS)


async def duplicate_groups(db, q, floors, kind):
    grouped = defaultdict(dict)
    documents = await identity_documents(db, q, floors, kind)
    by_id = {doc["id"]: doc for doc in documents if doc.get("id")}
    for doc in documents:
        if doc.get("id") and normalized_name(doc.get("name")):
            grouped[normalized_name(doc["name"])][doc["id"]] = doc
    groups = [{"id": review_key(kind, members), "kind": kind, "name": next(iter(members.values()))["name"], "entities": sorted(members.values(), key=lambda doc: doc["id"])} for members in grouped.values() if len(members) > 1]
    reviews = await _bounded(db.settings.find({"kind": kind, "entity_ids": {"$in": list(by_id)}}, {"_id": 1, "entity_ids": 1, "decision": 1, "note": 1, "reviewed_at": 1, "reviewed_by_name": 1, "revision": 1}), "Identity reviews", MAX_RECORDS) if by_id else []
    reviews = [row for row in reviews if row.get("entity_ids") and all(identity in by_id for identity in row["entity_ids"])]
    current_keys = {group["id"] for group in groups}
    for review in reviews:
        if review["_id"] not in current_keys:
            members = [by_id[identity] for identity in review["entity_ids"]]
            groups.append({"id": review["_id"], "kind": kind, "name": " / ".join(dict.fromkeys(doc["name"] for doc in members)), "entities": members})
    saved = {row["_id"]: public_review(row) for row in reviews}
    return [{**group, "review": saved.get(group["id"])} for group in sorted(groups, key=lambda group: (normalized_name(group["name"]), group["id"]))]


async def review_identity(db, q, floors, user, body):
    # Authenticate before reads even when called outside the HTTP dependency.
    if user.role != "owner":
        raise HTTPException(403, "Only the owner can resolve identity reviews")
    identities = sorted(set(body.entity_ids))
    if len(identities) != len(body.entity_ids) or len(identities) < 2:
        raise HTTPException(422, "Choose at least two different stable identities")
    docs = [doc for doc in await identity_documents(db, q, floors, body.kind) if doc.get("id") in identities]
    if {doc["id"] for doc in docs} != set(identities):
        raise HTTPException(404, "One or more identities are unavailable in your permitted scope")
    key = review_key(body.kind, identities)
    existing = await db.settings.find_one({"_id": key})
    # A resolved group remains available to the ledger even after a source rename.
    if not existing and len({normalized_name(doc.get("name")) for doc in docs}) != 1:
        raise HTTPException(409, "These identities no longer have the same name. Refresh the review list")
    if existing and existing.get("revision") == body.expected_revision + 1 and existing.get("reviewed_by") == user.id and existing.get("decision") == body.decision and existing.get("note") == body.note:
        return public_review(existing)
    if (existing or {}).get("revision", 0) != body.expected_revision:
        raise HTTPException(409, "This review changed elsewhere. Refresh before saving your decision")
    if len((existing or {}).get("history", [])) >= 1000:
        raise HTTPException(422, "This identity review has reached its audit history limit")
    event = {"decision": body.decision, "note": body.note, "reviewed_at": datetime.now(timezone.utc).isoformat(), "reviewed_by": user.id,
             "reviewed_by_name": user.full_name, "revision": body.expected_revision + 1}
    if existing:
        result = await db.settings.update_one({"_id": key, "revision": body.expected_revision}, {"$set": event, "$push": {"history": event}})
        if result.modified_count != 1:
            raise HTTPException(409, "This review changed elsewhere. Refresh before saving your decision")
    else:
        try:
            await db.settings.insert_one({"_id": key, "kind": body.kind, "entity_ids": identities, **event, "history": [event]})
        except DuplicateKeyError as exc:
            raise HTTPException(409, "This review changed elsewhere. Refresh before saving your decision") from exc
    return public_review(event)


async def review_page(db, q, floors, kind, page=1, page_size=25):
    return page_rows(await duplicate_groups(db, q, floors, kind), page, page_size)
