"""Bind private exports to an independently verified source; never print credentials."""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
from collections.abc import Mapping
from urllib.parse import urlsplit


def source_fingerprint(env: Mapping[str, str]) -> str:
    mongo_value = env.get("MONGO_URL", "")
    storage_value = env.get("SUPABASE_URL", "")
    database = env.get("DB_NAME", "")
    # The exporter selects the literal DB_NAME. Reject characters that parsers
    # might discard instead of certifying a normalized, different namespace.
    if any(not isinstance(value, str) or any(char.isspace() or ord(char) < 32 or ord(char) == 127
                                           for char in value)
           for value in (mongo_value, storage_value, database)):
        raise ValueError("invalid_source")
    mongo = urlsplit(mongo_value)
    storage = urlsplit(storage_value)
    hosts = mongo.netloc.rsplit("@", 1)[-1].lower()
    if (mongo.scheme not in {"mongodb", "mongodb+srv"} or not hosts
            or not re.fullmatch(r"[a-z0-9.\-,:\[\]]+", hosts)
            or not re.fullmatch(r"[A-Za-z0-9_-][A-Za-z0-9_.-]*", database)):
        raise ValueError("invalid_source")
    if (storage.scheme != "https" or not storage.hostname
            or storage.username is not None or storage.password is not None
            or storage.path not in {"", "/"} or storage.query or storage.fragment):
        raise ValueError("invalid_source")
    # Validate port syntax/range without including any input in diagnostics.
    _ = storage.port
    # Bind target identities, excluding Mongo username/password and storage keys.
    identity = {"mongo_scheme": mongo.scheme, "mongo_hosts": hosts,
                "database": database, "storage_origin": "https://" + storage.netloc.lower()}
    return hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def verify_source(env: Mapping[str, str], expected: str) -> bool:
    if not re.fullmatch(r"[0-9a-f]{64}", expected):
        raise ValueError("invalid_expected_fingerprint")
    return hmac.compare_digest(source_fingerprint(env), expected)


def run_cli(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--print-fingerprint", action="store_true",
                        help="Run only in an independently verified source environment")
    args = parser.parse_args(argv)
    try:
        if args.print_fingerprint:
            print(source_fingerprint(os.environ))
            return 0
        matched = verify_source(os.environ, os.environ.get("EXPECTED_SOURCE_FINGERPRINT", ""))
        print(json.dumps({"source_binding_verified": matched}))
        return 0 if matched else 1
    except Exception as exc:
        # Do not echo provider messages, URLs, supplied values or input identities.
        print(json.dumps({"source_binding_verified": False, "exception_type": type(exc).__name__}))
        return 1


if __name__ == "__main__":
    raise SystemExit(run_cli())
