"""Authenticator MFA. Secrets are encrypted; one-time proofs are claimed in Mongo."""
from __future__ import annotations

import base64
import hashlib
import json
import re
import secrets
import time
from datetime import datetime, timedelta, timezone

import pyotp
from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from fastapi import HTTPException

from db import db
from settings import settings

PENDING_SECONDS = 600
RECOVERY_COUNT = 10


def _cipher() -> Fernet:
    # Set the dedicated key before first enrollment. It stays stable through JWT
    # rotation; changing an existing encryption key requires an explicit migration.
    if settings.mfa_encryption_key:
        return Fernet(settings.mfa_encryption_key.encode())
    # Compatibility for installations enrolled before the dedicated setting.
    key = HKDF(algorithm=hashes.SHA256(), length=32, salt=None,
               info=b"forge/authenticator-mfa/fernet/v1").derive(settings.jwt_secret.encode())
    return Fernet(base64.urlsafe_b64encode(key))


def encrypt_secret(secret: str, user_id: str) -> str:
    return _cipher().encrypt(json.dumps({"user_id": user_id, "secret": secret}).encode()).decode()


def decrypt_secret(ciphertext: str, user_id: str) -> str:
    try:
        payload = json.loads(_cipher().decrypt(ciphertext.encode()))
        if payload["user_id"] != user_id:
            raise ValueError("Secret belongs to a different principal")
        return payload["secret"]
    except (InvalidToken, ValueError, KeyError, TypeError):
        raise HTTPException(status_code=503, detail="Authenticator configuration is unavailable") from None


def matching_counter(secret: str, code: str, *, now: float | None = None) -> int | None:
    if not re.fullmatch(r"[0-9]{6}", code):
        return None
    counter = int((time.time() if now is None else now) // 30)
    generator = pyotp.HOTP(secret)
    # Return the latest matching step, then atomically reject previously used steps.
    for candidate in (counter + 1, counter, counter - 1):
        if candidate >= 0 and secrets.compare_digest(generator.at(candidate), code):
            return candidate
    return None


def recovery_hash(code: str) -> str:
    normalized = code.replace("-", "").strip().lower()
    if not re.fullmatch(r"[0-9a-f]{32}", normalized):
        return ""
    return hashlib.sha256(b"forge/mfa/recovery/v1\0" + normalized.encode()).hexdigest()


def new_recovery_codes() -> tuple[list[str], list[str]]:
    codes = ["-".join(re.findall(r".{8}", secrets.token_hex(16))) for _ in range(RECOVERY_COUNT)]
    return codes, [recovery_hash(code) for code in codes]


def pending_enrollment(user_id: str, email: str) -> tuple[dict, dict]:
    secret = pyotp.random_base32()
    expires = datetime.now(timezone.utc) + timedelta(seconds=PENDING_SECONDS)
    stored = {"secret_encrypted": encrypt_secret(secret, user_id), "expires_at": expires}
    public = {"secret": secret, "uri": pyotp.TOTP(secret).provisioning_uri(email, issuer_name="BuildCon House"),
              "expires_in": PENDING_SECONDS}
    return stored, public


async def consume_factor(doc: dict, code: str | None, recovery_code: str | None = None) -> None:
    """One atomic claim prevents concurrent login/removal/recovery proof replay."""
    if not doc.get("mfa_enabled"):
        raise HTTPException(status_code=409, detail="Authenticator MFA is not enabled")
    query = {"id": doc["id"], "mfa_enabled": True, "mfa_version": doc.get("mfa_version", 0),
             "mfa_secret_encrypted": doc.get("mfa_secret_encrypted")}
    if recovery_code and not code:
        digest = recovery_hash(recovery_code)
        if not digest:
            raise HTTPException(status_code=401, detail="Invalid or already used MFA code")
        query["mfa_recovery_hashes"] = digest
        update = {"$pull": {"mfa_recovery_hashes": digest}}
    elif code and not recovery_code:
        secret = decrypt_secret(doc.get("mfa_secret_encrypted", ""), doc["id"])
        counter = matching_counter(secret, code)
        if counter is None:
            raise HTTPException(status_code=401, detail="Invalid or already used MFA code")
        query["$or"] = [{"mfa_last_counter": {"$lt": counter}}, {"mfa_last_counter": {"$exists": False}}]
        update = {"$set": {"mfa_last_counter": counter}}
    else:
        raise HTTPException(status_code=401, detail="mfa_required")
    claimed = await db.users.update_one(query, update)
    if claimed.modified_count != 1:
        raise HTTPException(status_code=401, detail="Invalid or already used MFA code")
