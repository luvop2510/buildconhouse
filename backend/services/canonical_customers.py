"""Resolve confirmed identity links while preserving every operational customer ID."""
from collections import defaultdict
from hashlib import sha256
import re
import unicodedata

from fastapi import HTTPException
from pymongo.errors import DuplicateKeyError

from models import now_iso

REVIEW_KEY = "canonical-customer-review"
LIVE_CUSTOMER = {"is_deleted": {"$ne": True}, "deleted_at": {"$in": [None, ""]}}
ORIGIN_FIELDS = ("imported_from_customer_id", "identity_source_customer_id")
MAX_RECORDS = 50_000
MAX_REVIEW_EVENTS = 5_000


async def review_state(db):
    return (await db.settings.find_one({"_id": REVIEW_KEY})) or {"revision": 0, "decisions": {}, "history": []}


def pair_key(ids):
    return sha256("\0".join(ids).encode()).hexdigest()


def identity_group_token(identity):
    return sha256(f"customer-group:{identity}".encode()).hexdigest()


async def identity_documents(db, ids, *, state=None):
    """Follow both directions of confirmed relationships. Never read contact fields."""
    if not ids:
        return {}, ()
    if state is None:
        state = await db.settings.find_one({"_id": REVIEW_KEY}, {"decisions": 1}) or {}
    decisions = state.get("decisions", {}).values()
    paired = defaultdict(set)
    for decision in decisions:
        if decision["decision"] == "same":
            left, right = decision["customer_ids"]
            paired[left].add(right)
            paired[right].add(left)
    documents = {}
    visited, pending = set(), set(ids)
    while pending:
        visited.update(pending)
        rows = await db.customers.find({**LIVE_CUSTOMER, "$or": [
            {"id": {"$in": sorted(pending)}},
            *({field: {"$in": sorted(pending)}} for field in ORIGIN_FIELDS),
        ]}, {"_id": 0, "id": 1, **{field: 1 for field in ORIGIN_FIELDS}}).max_time_ms(5000).limit(MAX_RECORDS + 1).to_list(MAX_RECORDS + 1)
        documents.update((row["id"], row) for row in rows)
        pending = set(documents) - visited
        for row in rows:
            pending.update(paired[row["id"]] - visited)
            pending.update(row[field] for field in ORIGIN_FIELDS if row.get(field) and row[field] not in visited)
        if len(documents) > MAX_RECORDS or len(visited | pending) > MAX_RECORDS:
            raise HTTPException(422, "Customer identity scope is too large. Choose a smaller range.")
    return documents, decisions


def canonical_mapping(documents, decisions):
    parents = {identity: identity for identity in documents}
    reviewed = {tuple(item["customer_ids"]): item["decision"] for item in decisions}

    def root(identity):
        while parents[identity] != identity:
            parents[identity] = parents[parents[identity]]
            identity = parents[identity]
        return identity

    def join(left, right):
        left, right = root(left), root(right)
        if left != right:
            parents[max(left, right)] = min(left, right)

    origins = set()
    for identity, row in documents.items():
        for field in ORIGIN_FIELDS:
            origin = row.get(field)
            if origin in documents and origin != identity and reviewed.get(tuple(sorted((identity, origin)))) != "distinct":
                origins.add(identity)
                join(identity, origin)
    for (left, right), decision in reviewed.items():
        if decision == "same" and left in documents and right in documents:
            join(left, right)

    members = defaultdict(list)
    for identity in documents:
        members[root(identity)].append(identity)
    # Preserve the original identity as the group representative when possible.
    mapping = {}
    for group in members.values():
        canonical = min(group, key=lambda member: (member in origins, member))
        mapping.update(dict.fromkeys(group, canonical))
    return mapping


async def canonical_customer_ids(db, customer_ids):
    ids = {value for value in customer_ids if isinstance(value, str) and value}
    documents, decisions = await identity_documents(db, ids)
    mapping = canonical_mapping(documents, decisions)
    return {identity: mapping.get(identity, identity) for identity in ids}


async def linked_customer_scope(db, identity):
    documents, decisions = await identity_documents(db, [identity])
    identities = canonical_mapping(documents, decisions)
    group = identities.get(identity, identity)
    return group, sorted({identity, *(member for member, canonical in identities.items() if canonical == group)})


async def linked_customer_ids(db, identity):
    _, members = await linked_customer_scope(db, identity)
    return members


def normalized_phone(value):
    digits = re.sub(r"[^0-9]", "", str(value or ""))
    if len(digits) == 12 and digits.startswith("91"):
        digits = digits[2:]
    elif len(digits) == 11 and digits.startswith("0"):
        digits = digits[1:]
    return digits if len(digits) >= 7 else ""


def normalized_name(value):
    return " ".join(unicodedata.normalize("NFKC", str(value or "")).casefold().split())


async def review_candidates(db, page, limit):
    state = await review_state(db)
    documents = await db.customers.find(LIVE_CUSTOMER, {"_id": 0, "id": 1, "floor_id": 1, "name": 1,
        "phone": 1, "alternate_phone": 1, "address": 1, **{field: 1 for field in ORIGIN_FIELDS}}
    ).max_time_ms(5000).limit(MAX_RECORDS + 1).to_list(MAX_RECORDS + 1)
    if len(documents) > MAX_RECORDS:
        raise HTTPException(422, "The customer directory exceeds the supported review size.")
    by_id = {row["id"]: row for row in documents if row.get("id")}
    mapping = canonical_mapping(by_id, state["decisions"].values())
    groups = defaultdict(set)
    for identity, row in by_id.items():
        name = normalized_name(row.get("name"))
        if name:
            groups["name", name].add(identity)
        for field in ("phone", "alternate_phone"):
            phone = normalized_phone(row.get(field))
            if phone:
                groups["phone", phone].add(identity)
    rows = []
    for (kind, key), members in sorted(groups.items()):
        if len({mapping[member] for member in members}) > 1:
            rows.append({"id": pair_key([kind, key]), "evidence": kind, "customer_ids": sorted(members)})
    # Keep reviewed and imported links in the same view so the owner can undo them.
    for identity, row in by_id.items():
        for field in ORIGIN_FIELDS:
            origin = row.get(field)
            if origin in by_id and origin != identity:
                ids = sorted((identity, origin))
                rows.append({"id": pair_key(ids), "evidence": "confirmed source", "customer_ids": ids})
    for key, item in state["decisions"].items():
        if all(identity in by_id for identity in item["customer_ids"]):
            rows.append({"id": key, "evidence": "owner review", "customer_ids": item["customer_ids"]})
    rows = list({row["id"]: row for row in rows}.values())
    return {"revision": state["revision"], "total": len(rows), "rows": [
        {**row, "customers": [{key: by_id[identity].get(key) for key in ("id", "name", "floor_id", "phone", "address")}
              for identity in row["customer_ids"]],
         "review": state["decisions"].get(row["id"])} for row in rows[(page - 1) * limit:page * limit]
    ]}


async def save_identity_decision(db, user, ids, decision, note, expected_revision):
    if user.role != "owner":
        raise HTTPException(403, "Only the owner can review customer identity")
    ids = sorted(ids)
    if len(ids) != 2 or ids[0] == ids[1]:
        raise HTTPException(422, "Select two different customer identities")
    state = await review_state(db)
    key = pair_key(ids)
    saved = state["decisions"].get(key)
    if (saved and saved["revision"] == expected_revision + 1 and saved["actor_id"] == user.id
            and saved["decision"] == decision and saved["note"] == note):
        return saved
    if state["revision"] != expected_revision:
        raise HTTPException(409, "Customer identity review changed. Refresh and try again.")
    if len(state["history"]) >= MAX_REVIEW_EVENTS:
        raise HTTPException(422, "Customer identity review has reached its supported audit capacity.")
    documents, _ = await identity_documents(db, ids, state=state)
    if not set(ids).issubset(documents):
        raise HTTPException(404, "One or more customer identities are unavailable")
    event = {"customer_ids": ids, "decision": decision, "note": note, "actor_id": user.id,
             "actor_name": user.full_name, "reviewed_at": now_iso(), "revision": expected_revision + 1}
    decisions = {**state["decisions"], key: event}
    mapping = canonical_mapping(documents, decisions.values())
    for item in decisions.values():
        left, right = item["customer_ids"]
        if item["decision"] == "distinct" and left in mapping and right in mapping and mapping[left] == mapping[right]:
            raise HTTPException(409, "These records have a conflicting confirmed link. Review that link first.")
    if expected_revision:
        result = await db.settings.update_one({"_id": REVIEW_KEY, "revision": expected_revision},
            {"$set": {"revision": event["revision"], f"decisions.{key}": event}, "$push": {"history": event}})
        if result.modified_count != 1:
            raise HTTPException(409, "Customer identity review changed. Refresh and try again.")
    else:
        try:
            await db.settings.insert_one({"_id": REVIEW_KEY, "revision": 1, "decisions": decisions, "history": [event]})
        except DuplicateKeyError as exc:
            raise HTTPException(409, "Customer identity review changed. Refresh and try again.") from exc
    return event

async def reuse_customer_for_floor(database, user, source_id, source_floor, target_floor):
    """Keep operational IDs local. A verified user selection supplies the identity edge."""
    from auth import authorize_staff_resource, require_floor_access
    from models import CustomerPublic
    from services.activity_log import log_event
    from services.customer_search import account_scope
    from uuid import NAMESPACE_URL, uuid5

    actor = account_scope(user)
    require_floor_access(source_floor, actor)
    require_floor_access(target_floor, actor)
    await authorize_staff_resource(actor, method="GET", path="/api/customers", floor_id=source_floor)
    source = await database.customers.find_one({"id": source_id, "floor_id": source_floor, **LIVE_CUSTOMER},
        {"_id": 0, "password_hash": 0})
    if not source:
        raise HTTPException(404, "Selected customer is unavailable")
    if source_floor == target_floor:
        return source, False

    canonical, linked = await linked_customer_scope(database, source_id)
    query = {"id": {"$in": linked}, "floor_id": target_floor, **LIVE_CUSTOMER}
    target = await database.customers.find_one(query, {"_id": 0, "password_hash": 0}, sort=[("created_at", 1), ("id", 1)])
    if target:
        return target, False

    target_id = str(uuid5(NAMESPACE_URL, f"customer-floor:{canonical}:{target_floor}"))
    copied = {field: source.get(field) for field in ("name", "phone", "address", "alternate_phone") if source.get(field)}
    target = CustomerPublic(id=target_id, floor_id=target_floor, **copied).model_dump(exclude={"email"})
    target.update(identity_source_customer_id=source_id, identity_linked_by=user.id, identity_linked_at=now_iso())
    try:
        await database.customers.insert_one({"_id": target_id, **target})
    except DuplicateKeyError:
        existing = await database.customers.find_one({"_id": target_id, "floor_id": target_floor, **LIVE_CUSTOMER},
            {"_id": 0, "password_hash": 0})
        if existing and target_id in await linked_customer_ids(database, source_id):
            return existing, False
        raise HTTPException(409, "This customer link changed. Refresh and try again.")
    await log_event(
        event_type="customer.identity_linked", entity_type="customer", entity_id=target_id,
        customer_id=target_id, actor=user, floor_id=target_floor,
        summary="Linked the selected customer to this department",
        payload={"source_customer_id": source_id},
    )
    return target, True



async def create_intake_customer(database, *, identity, floor, name, phone, address=None):
    """Persist an explicitly distinct person under a stable intake request ID."""
    stamp = now_iso()
    data = {"id": identity, "floor_id": floor, "name": name.strip(), "phone": phone.strip(),
            "address": address, "tier": "retail", "created_at": stamp, "updated_at": stamp,
            "portal_enabled": False, "tags": []}
    key = {"_id": identity, "floor_id": floor}
    try:
        await database.customers.insert_one({**key, **data, "created_by_intake": True})
    except DuplicateKeyError:
        saved = await database.customers.find_one({**key, **LIVE_CUSTOMER, "created_by_intake": True}, {"_id": 0})
        if not saved:
            raise HTTPException(409, "The saved customer was changed. Start a new intake.")
        if any(saved.get(field) != data[field] for field in ("phone", "name", "address")):
            raise HTTPException(409, "This intake request was used with different contact details.")
        return saved, False
    return data, True
