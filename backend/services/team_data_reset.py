"""Explicit operational account reset. Never invoked by startup or migrations.

Deploy all API/worker instances in FORGE_CUSTOMER_RESET_MAINTENANCE first and
wait for in-flight requests to finish. The maintenance gate also pauses domain
workers. A transaction replaces staff and revokes every login without touching
customer business documents, catalog, stock, or financial history.
"""
from __future__ import annotations

from uuid import NAMESPACE_URL, uuid5

from pymongo.read_concern import ReadConcern
from pymongo.write_concern import WriteConcern

from auth import hash_password
from models import UserPublic, now_iso
from services.customer_data_reset import customer_reset_maintenance
from services.login_identity import normalize_login_id
from services.password_policy import validate_new_password
from services.team_credentials import encrypt_password

REQUEST_ID = "team-reset-20261010"
RECEIPT_ID = "team_data_reset:" + REQUEST_ID
OWNER_LOGIN = "JK PATEL"
OWNER_EMAIL = "jkpatel@buildconhouse.com"
OWNER_ID = str(uuid5(NAMESPACE_URL, "buildcon-house/" + REQUEST_ID))
CUSTOMER_CREDENTIAL_FIELDS = (
    "password_hash", "must_change_password", "temp_password_expires_at",
    "mfa_secret_encrypted", "mfa_pending", "mfa_recovery_hashes", "mfa_last_counter",
    "mfa_enabled", "mfa_version", "invite_token", "invite_token_hash",
    "invite_expires_at", "reset_token", "reset_token_hash", "reset_token_expires_at",
    "google_id", "google_sub", "oauth_sub", "oauth_provider",
)


def _customer_credentials_query() -> dict:
    return {"$or": [{"portal_enabled": True},
        *[{key: {"$exists": True}} for key in CUSTOMER_CREDENTIAL_FIELDS]]}


def _customer_accounts_query() -> dict:
    # Model-default false/null fields are scrubbed too, but do not represent
    # an existing login account in the preview/completion count.
    return {"$or": [{"portal_enabled": True},
        *[{key: {"$exists": True, "$nin": [None, "", False, [], {}]}}
          for key in CUSTOMER_CREDENTIAL_FIELDS]]}


def _queries(old_ids: list[str]) -> dict[str, dict]:
    # Authentication/invite fields live on the user/customer documents in
    # this schema; there are no separate refresh-token or invite collections.
    return {
        "users": {}, "access_grants": {}, "user_sessions": {}, "download_tokens": {},
        "product_usage": {"user_id": {"$in": old_ids}},
        "followup_saved_views": {"user_id": {"$in": old_ids}},
        "notifications": {"user_id": {"$in": old_ids}},
        # Keep business activity and its historical actor attribution.
        "activity_events": {"$or": [{"entity_type": {"$in": ["user", "access_grant"]}},
            {"event_type": {"$regex": r"^user\."}}]},
        "settings": {"key": "permission_matrix"},
    }


async def team_reset_preview(database, *, session=None) -> dict:
    old_ids = [row["id"] async for row in database.users.find({}, {"id": 1}, session=session)
        if row.get("id")]
    deleted = {name: await database[name].count_documents(query, session=session)
        for name, query in _queries(old_ids).items()}
    prior = await database.settings.find_one({"_id": RECEIPT_ID}, session=session)
    return {"request_id": REQUEST_ID, "database": database.name, "deleted": deleted,
        "portal_accounts_disabled": await database.customers.count_documents(
            _customer_accounts_query(), session=session),
        "owner": {"id": OWNER_ID, "full_name": OWNER_LOGIN, "login_id": OWNER_LOGIN,
            "email": OWNER_EMAIL, "role": "owner"}, "already_applied": bool(prior),
        "dry_run": True}


async def reset_team_data(database, client, *, request_id: str,
                          owner_password: str, expected_user_count: int) -> dict:
    if not customer_reset_maintenance():
        raise RuntimeError("Account reset requires every API and worker in maintenance mode")
    if request_id != REQUEST_ID:
        raise ValueError("Unrecognized account reset request")
    validate_new_password(owner_password)
    password_hash = hash_password(owner_password)

    async def operation(session):
        prior = await database.settings.find_one({"_id": RECEIPT_ID}, session=session)
        if prior:
            return {**prior["receipt"], "already_applied": True}
        actual = await database.users.count_documents({}, session=session)
        if actual != expected_user_count:
            raise RuntimeError("Staff count changed since preview; reset aborted")
        preview = await team_reset_preview(database, session=session)
        old_ids = [row["id"] async for row in database.users.find({}, {"id": 1}, session=session)
            if row.get("id")]
        deleted = {}
        for name, query in _queries(old_ids).items():
            deleted[name] = (await database[name].delete_many(query, session=session)).deleted_count
        disabled = await database.customers.update_many(_customer_credentials_query(), {
            "$set": {"portal_enabled": False},
            "$unset": {key: "" for key in CUSTOMER_CREDENTIAL_FIELDS},
        }, session=session)
        owner = UserPublic(id=OWNER_ID, email=OWNER_EMAIL, login_id=OWNER_LOGIN,
            full_name=OWNER_LOGIN, role="owner", active=True, floor_ids=[]).model_dump()
        # Owner retains normal full access. Empty floor_ids has established
        # all-floor semantics for owners and needs no custom grants.
        owner.pop("active_floor_id", None)
        owner.pop("session_id", None)
        await database.users.insert_one({**owner, "login_id_key": normalize_login_id(OWNER_LOGIN),
            "password_hash": password_hash, "password_encrypted": encrypt_password(owner_password, OWNER_ID)}, session=session)
        receipt = {"request_id": request_id, "completed_at": now_iso(), "deleted": deleted,
            "portal_accounts_disabled": preview["portal_accounts_disabled"],
            "customer_credential_rows_scrubbed": disabled.modified_count, "owner_id": OWNER_ID,
            "already_applied": False, "preview_staff_count": preview["deleted"]["users"]}
        # _id is unique even where generic settings.id/key has no index. This
        # durable replay guard is committed atomically with the replacement.
        await database.settings.insert_one({"_id": RECEIPT_ID, "id": RECEIPT_ID,
            "receipt": receipt}, session=session)
        return receipt

    async with await client.start_session() as session:
        return await session.with_transaction(operation, read_concern=ReadConcern("snapshot"),
            write_concern=WriteConcern("majority"))
