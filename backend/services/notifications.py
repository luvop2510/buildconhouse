"""Real notification generation.

Before this file existed, db.notifications only ever got rows from the
one-time demo seed (seed.py) — nothing in the running application ever
created one, so the Notifications screen was permanently frozen on
whatever the seed happened to contain. This module is the single write
path for real, in-app notifications going forward.
"""
from __future__ import annotations

from typing import Literal, Optional

from db import db
from models import Notification


async def notify(
    user_id: Optional[str],
    title: str,
    *,
    body: Optional[str] = None,
    kind: Literal["info", "success", "warning", "error"] = "info",
    link: Optional[str] = None,
    floor_id: Optional[str] = None,
) -> None:
    """Best-effort — a notification failing to write must never break the
    business action that triggered it (payment recording, order placement,
    follow-up reconciliation, etc.).

    `floor_id` is the business unit the triggering record belongs to. Always
    take it from that record (`doc.get("floor_id")`), never from the request
    header: a notification outlives the request that created it and is read
    back later under whatever floor the recipient happens to be viewing.
    """
    if not user_id:
        return
    try:
        n = Notification(user_id=user_id, kind=kind, title=title, body=body, link=link, floor_id=floor_id)
        await db.notifications.insert_one(n.model_dump())
    except Exception:  # noqa: BLE001 — notifications are never allowed to fail the caller
        pass


async def notify_many(user_ids: list[str], title: str, **kwargs) -> None:
    for uid in {u for u in user_ids if u}:
        await notify(uid, title, **kwargs)
