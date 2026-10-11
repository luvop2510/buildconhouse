"""InviteService — delivery abstraction for portal invites & password resets.

Today's implementation (`ManualInviteService`) does not send any email/SMS:
it shows a credential once for the account administrator to relay
themselves (WhatsApp/SMS/email), which is the option the user explicitly
chose for launch. Staff credentials are permanently owner-managed, with no
expiry; customer invites retain the temporary credential policy.
`EmailInviteService` is a stub for a future real email
integration (Resend/SendGrid) — swapping the driver is a single env var
(`INVITE_SERVICE_DRIVER=email`) and changes NOTHING else:

  * The database fields written are identical either way (password_hash,
    must_change_password, temp_password_expires_at) — no schema change on
    upgrade.
  * The API response always has a `delivery_method` field ("manual" |
    "email"). The frontend already branches on this value, so the exact same
    UI code path handles both — "manual" shows the one-time password dialog,
    "email" shows a plain success toast. No frontend change needed to go
    live with real email later.

Callers (routes/customer_routes.py send-invite/reset-password,
routes/misc_routes.py team reset-password) always go through
`get_invite_service().deliver(...)` — never construct a driver directly.
"""
from __future__ import annotations

import os
import secrets
import string
from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

# Security requirement: any temporary password issued by an invite/reset must
# stop working after this many hours if the recipient never logs in with it.
TEMP_PASSWORD_TTL_HOURS = 72


def generate_temp_password(length: int = 12) -> str:
    """Cryptographically-random, human-typable temporary password — guaranteed
    to contain a lowercase, uppercase, and digit character."""
    alphabet = string.ascii_letters + string.digits
    while True:
        pw = "".join(secrets.choice(alphabet) for _ in range(length))
        if (
            any(c.islower() for c in pw)
            and any(c.isupper() for c in pw)
            and any(c.isdigit() for c in pw)
        ):
            return pw


def temp_password_expiry_iso() -> str:
    return (datetime.now(timezone.utc) + timedelta(hours=TEMP_PASSWORD_TTL_HOURS)).isoformat()


def is_temp_password_expired(expires_at_iso: Optional[str]) -> bool:
    """True only when an expiry timestamp exists AND has passed. A missing
    timestamp (legacy account, normal password) is never treated as expired."""
    if not expires_at_iso:
        return False
    try:
        expires_at = datetime.fromisoformat(expires_at_iso)
    except ValueError:
        return False
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc) > expires_at


@dataclass
class InviteResult:
    delivery_method: str  # "manual" | "email"
    temporary_password: Optional[str] = None  # only ever populated for "manual"
    expires_at: Optional[str] = None
    message: str = ""


class InviteService(ABC):
    """Delivers a freshly-issued account password to a recipient. Never
    persists or hashes anything itself — the caller is responsible for
    storing `password_hash` before calling `deliver`; this class only decides
    HOW the credential reaches the recipient."""

    @abstractmethod
    async def deliver(
        self, *, recipient_email: Optional[str], recipient_name: str,
        temp_password: str, expires_at: Optional[str], kind: str,
    ) -> InviteResult:
        ...


class ManualInviteService(InviteService):
    """Launch implementation — zero external dependencies. Returns the
    plaintext temp password so the admin UI can show it exactly once."""

    async def deliver(self, *, recipient_email, recipient_name, temp_password, expires_at, kind):
        verb = {
            "customer_invite": "Portal invite",
            "customer_reset": "Password reset",
            "staff_reset": "Password reset",
        }.get(kind, "Credential")
        return InviteResult(
            delivery_method="manual",
            temporary_password=temp_password,
            expires_at=expires_at,
            message=(
                f"{verb} generated for {recipient_name}. Share it with them directly — "
                "it will not be shown again. Only the owner can change this password."
                if kind == "staff_reset" else
                f"{verb} generated for {recipient_name}. Share it with them directly — "
                "it will not be shown again and expires in 72 hours if unused."
            ),
        )


class EmailInviteService(InviteService):
    """Future implementation — NOT wired up yet. Would actually send an
    email via Resend/SendGrid and must never return the plaintext password
    in the API response."""

    async def deliver(self, *, recipient_email, recipient_name, temp_password, expires_at, kind):
        raise NotImplementedError(
            "EmailInviteService is not configured yet. Set INVITE_SERVICE_DRIVER=manual "
            "(the current default) until an email provider is integrated."
        )


def get_invite_service() -> InviteService:
    driver = (os.environ.get("INVITE_SERVICE_DRIVER") or "manual").strip().lower()
    if driver == "email":
        return EmailInviteService()
    return ManualInviteService()
