"""Short-lived, single-use tokens for browser-download URLs.

Endpoints that must open as a plain browser navigation (PDF viewer tab, .xlsx
export) can't attach an Authorization header, so they previously accepted the
full-lifetime JWT itself as a `?_t=` query parameter — a token valid for
JWT_EXP_MINUTES (weeks) that then leaks into browser history, proxy/server
access logs, and Referer headers on any outbound request from that tab.

This replaces that with an opaque, random, 60-second, single-use token minted
right before the download starts (see POST /api/downloads/token) and consumed
exactly once by the download endpoint itself.
"""
from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone

from db import db

_TTL_SECONDS = 60


async def ensure_download_token_indexes() -> None:
    await db.download_tokens.create_index("token", unique=True, name="download_token_unique")
    # TTL cleanup only — access control re-checks expires_at explicitly below,
    # since Mongo's TTL monitor sweeps on its own ~60s cadence, not instantly.
    await db.download_tokens.create_index("expires_at", expireAfterSeconds=0, name="download_token_ttl")


async def create_download_token(
    user_id: str, session_id: str | None = None, floor_id: str | None = None,
    target: str | None = None, *, kind: str = "staff",
) -> str:
    token = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    await db.download_tokens.insert_one({
        "token": token,
        "user_id": user_id,
        "kind": kind,
        # Bound to the minting request's session so the download inherits the
        # same revocation semantics as a normal API call.
        "session_id": session_id,
        # …and to its business unit. A browser download is a plain navigation
        # and structurally cannot send X-Floor-Id, so without this the
        # download runs with no active floor — which, for an all-floors
        # owner/manager, makes `floor_query()` unrestricted and lets a PDF or
        # export URL resolve against the other unit's records. This is the one
        # in-product request path where the header is absent by construction.
        "floor_id": floor_id,
        # A leaked token may be spent only on the exact browser navigation it
        # was minted for, never on an arbitrary authenticated GET endpoint.
        "target": target,
        "used": False,
        "created_at": now.isoformat(),
        "expires_at": now + timedelta(seconds=_TTL_SECONDS),
    })
    return token


async def consume_download_token(token: str, *, target: str | None = None) -> dict | None:
    """Atomically marks the token used and returns its record, or None if
    missing, expired, or already redeemed. The atomic find_one_and_update
    means two concurrent requests replaying one leaked token can't both
    succeed."""
    now = datetime.now(timezone.utc)
    query = {"token": token, "used": False, "expires_at": {"$gt": now}}
    if target:
        # Existing 60-second tokens from the rollout before target binding
        # remain usable once; all newly minted tokens have an exact target.
        query["$or"] = [{"target": target}, {"target": {"$exists": False}}]
    return await db.download_tokens.find_one_and_update(
        query,
        {"$set": {"used": True}},
    )
