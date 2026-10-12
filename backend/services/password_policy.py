"""Shared policy for newly assigned passwords."""
from __future__ import annotations

import hmac

MIN_PASSWORD_LENGTH = 6


def is_known_default_password(password: str) -> bool:
    # Bootstrap retains the public legacy value solely for detection. Keeping
    # one reference prevents login and provisioning policies from diverging.
    from bootstrap import LEGACY_DEMO_PASSWORD

    return hmac.compare_digest(password.encode("utf-8"), LEGACY_DEMO_PASSWORD.encode("utf-8"))


def validate_new_password(password: str) -> str:
    if len(password) < MIN_PASSWORD_LENGTH:
        raise ValueError(f"Password must contain at least {MIN_PASSWORD_LENGTH} characters")
    if len(password.encode("utf-8")) > 72:
        raise ValueError("Password must contain at most 72 UTF-8 bytes")
    if is_known_default_password(password):
        raise ValueError("Choose a password other than the historical demo password")
    return password
