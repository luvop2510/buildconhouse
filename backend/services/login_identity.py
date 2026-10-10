"""Canonical staff work IDs; names are never implicit authentication aliases."""
from __future__ import annotations

import unicodedata


def normalize_login_id(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())
