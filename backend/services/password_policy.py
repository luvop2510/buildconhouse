"""Shared checks for the published historical demo credential."""
from __future__ import annotations

import hmac


def is_known_default_password(password: str) -> bool:
    # Bootstrap retains the public legacy value solely for detection. Keeping
    # one reference prevents login and provisioning policies from diverging.
    from bootstrap import LEGACY_DEMO_PASSWORD

    return hmac.compare_digest(password.encode("utf-8"), LEGACY_DEMO_PASSWORD.encode("utf-8"))


def validate_new_password(password: str) -> str:
    if len(password.encode("utf-8")) > 72:
        raise ValueError("Password must contain at most 72 UTF-8 bytes")
    if is_known_default_password(password):
        raise ValueError("Choose a password other than the historical demo password")
    return password
