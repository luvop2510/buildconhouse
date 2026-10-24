"""Recoverable staff credentials for the owner's explicit password view.

Authentication continues to use bcrypt. This independently derived encryption
key must remain stable; legacy hashes cannot reconstruct a forgotten password.
"""
from __future__ import annotations

import base64
import json

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from fastapi import HTTPException
from settings import settings


def _cipher() -> Fernet:
    root = (base64.urlsafe_b64decode(settings.mfa_encryption_key)
            if settings.mfa_encryption_key else settings.jwt_secret.encode())
    key = HKDF(algorithm=hashes.SHA256(), length=32, salt=None,
               info=b"forge/owner-team-credentials/fernet/v1").derive(root)
    return Fernet(base64.urlsafe_b64encode(key))


def encrypt_password(password: str, user_id: str) -> str:
    return _cipher().encrypt(json.dumps({"user_id": user_id, "password": password}).encode()).decode()


def decrypt_password(ciphertext: str, user_id: str) -> str:
    try:
        value = json.loads(_cipher().decrypt(ciphertext.encode()))
        if value["user_id"] != user_id or not isinstance(value["password"], str):
            raise ValueError("Credential principal mismatch")
        return value["password"]
    except (InvalidToken, ValueError, KeyError, TypeError, AttributeError):
        raise HTTPException(status_code=409, detail="Reset this member's password before viewing it") from None
