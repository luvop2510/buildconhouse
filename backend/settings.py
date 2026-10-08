"""Centralized, fail-fast runtime configuration for Forge.

Process environment variables are authoritative in deployed environments. A local
``backend/.env`` file is loaded only as a development/preview fallback and never
overrides values injected by the platform.
"""
from __future__ import annotations

import os
import base64
import binascii
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping
from urllib.parse import urlparse

from dotenv import load_dotenv


BACKEND_DIR = Path(__file__).resolve().parent
LOCAL_ENV_FILE = BACKEND_DIR / ".env"


class ConfigurationError(RuntimeError):
    """Raised when Forge cannot start safely with the supplied configuration."""


VALID_ENVIRONMENTS = ("production", "staging", "development")


@dataclass(frozen=True)
class Settings:
    mongo_url: str
    db_name: str
    mongo_max_pool_size: int
    mongo_min_pool_size: int
    mongo_connect_timeout_ms: int
    mongo_server_selection_timeout_ms: int
    mongo_socket_timeout_ms: int
    mongo_wait_queue_timeout_ms: int
    jwt_secret: str
    jwt_algorithm: str
    jwt_exp_minutes: int
    media_storage_driver: str
    supabase_url: str
    supabase_service_role_key: str
    supabase_anon_key: str
    supabase_public_bucket: str
    supabase_private_bucket: str
    allow_demo_seed: bool
    environment: str
    demo_password: str | None
    mfa_encryption_key: str | None = None

    def readiness_flags(self) -> dict[str, bool]:
        """Safe, non-secret status values for diagnostics and health responses."""
        return {
            "MONGO_URL": bool(self.mongo_url),
            "DB_NAME": bool(self.db_name),
            "JWT_SECRET": bool(self.jwt_secret),
            "SUPABASE_URL": bool(self.supabase_url),
            "SUPABASE_SERVICE_ROLE_KEY": bool(self.supabase_service_role_key),
            "SUPABASE_ANON_KEY": bool(self.supabase_anon_key),
            "SUPABASE_PUBLIC_BUCKET": bool(self.supabase_public_bucket),
            "SUPABASE_PRIVATE_BUCKET": bool(self.supabase_private_bucket),
        }


def _required(env: Mapping[str, str], name: str) -> str:
    value = (env.get(name) or "").strip()
    invalid = not value or value.startswith("<") or "..." in value
    if invalid:
        raise ConfigurationError(
            f"Missing or placeholder configuration: {name}. "
            "Set it in the deployment environment; backend/.env is only a local fallback. "
            "See STARTUP_CHECK.md."
        )
    return value


def _positive_int(env: Mapping[str, str], name: str, default: int, *, allow_zero: bool = False) -> int:
    """Parse a bounded Mongo driver setting before the client is created."""
    raw = (env.get(name) or str(default)).strip()
    try:
        value = int(raw)
    except ValueError as exc:
        raise ConfigurationError(f"{name} must be an integer.") from exc
    if value < 0 or (value == 0 and not allow_zero):
        qualifier = "zero or a positive integer" if allow_zero else "greater than zero"
        raise ConfigurationError(f"{name} must be {qualifier}.")
    return value


def load_settings(
    environ: Mapping[str, str] | None = None,
    *,
    load_local_fallback: bool = True,
) -> Settings:
    """Load and validate settings, preferring platform-injected process values."""
    if environ is None:
        if load_local_fallback:
            load_dotenv(LOCAL_ENV_FILE, override=False)
        env: Mapping[str, str] = os.environ
    else:
        env = environ

    mongo_url = _required(env, "MONGO_URL")
    db_name = _required(env, "DB_NAME")
    jwt_secret = _required(env, "JWT_SECRET")
    mfa_encryption_key = (env.get("MFA_ENCRYPTION_KEY") or "").strip() or None
    if mfa_encryption_key:
        try:
            decoded_key = base64.b64decode(mfa_encryption_key, altchars=b"-_", validate=True)
            valid_key = len(decoded_key) == 32 and base64.urlsafe_b64encode(decoded_key).decode() == mfa_encryption_key
        except (ValueError, binascii.Error):
            valid_key = False
        if not valid_key:
            raise ConfigurationError("MFA_ENCRYPTION_KEY must be a canonical URL-safe base64 Fernet key containing 32 bytes.")
    supabase_url = _required(env, "SUPABASE_URL").rstrip("/")
    service_key = _required(env, "SUPABASE_SERVICE_ROLE_KEY")
    anon_key = _required(env, "SUPABASE_ANON_KEY")
    public_bucket = _required(env, "SUPABASE_PUBLIC_BUCKET")
    private_bucket = _required(env, "SUPABASE_PRIVATE_BUCKET")

    if not mongo_url.startswith(("mongodb://", "mongodb+srv://")):
        raise ConfigurationError("MONGO_URL must start with mongodb:// or mongodb+srv://.")
    if any(ch.isspace() for ch in mongo_url):
        raise ConfigurationError("MONGO_URL contains whitespace; provide the exact Atlas URI on one line.")
    if not db_name or any(ch.isspace() for ch in db_name):
        raise ConfigurationError("DB_NAME must be a non-empty MongoDB database name without whitespace.")
    if len(jwt_secret) < 32:
        raise ConfigurationError("JWT_SECRET must contain at least 32 characters.")
    parsed = urlparse(supabase_url)
    if parsed.scheme != "https" or not parsed.netloc:
        raise ConfigurationError("SUPABASE_URL must be a valid https:// project URL.")

    try:
        jwt_exp_minutes = int(env.get("JWT_EXP_MINUTES", "43200"))
    except ValueError as exc:
        raise ConfigurationError("JWT_EXP_MINUTES must be an integer.") from exc
    if jwt_exp_minutes <= 0:
        raise ConfigurationError("JWT_EXP_MINUTES must be greater than zero.")

    mongo_max_pool_size = _positive_int(env, "MONGO_MAX_POOL_SIZE", 20)
    mongo_min_pool_size = _positive_int(env, "MONGO_MIN_POOL_SIZE", 0, allow_zero=True)
    if mongo_min_pool_size > mongo_max_pool_size:
        raise ConfigurationError("MONGO_MIN_POOL_SIZE cannot exceed MONGO_MAX_POOL_SIZE.")
    mongo_connect_timeout_ms = _positive_int(env, "MONGO_CONNECT_TIMEOUT_MS", 10_000)
    mongo_server_selection_timeout_ms = _positive_int(env, "MONGO_SERVER_SELECTION_TIMEOUT_MS", 10_000)
    mongo_socket_timeout_ms = _positive_int(env, "MONGO_SOCKET_TIMEOUT_MS", 30_000)
    mongo_wait_queue_timeout_ms = _positive_int(env, "MONGO_WAIT_QUEUE_TIMEOUT_MS", 10_000)

    driver = (env.get("MEDIA_STORAGE_DRIVER") or "supabase").strip().lower()
    if driver != "supabase":
        raise ConfigurationError(
            f"Unsupported MEDIA_STORAGE_DRIVER={driver!r}; Forge production currently requires 'supabase'."
        )

    # Unset means assume the most restrictive setting — a missing ENVIRONMENT
    # var must never be silently treated as a safe non-production default.
    environment = (env.get("ENVIRONMENT") or "production").strip().lower()
    if environment not in VALID_ENVIRONMENTS:
        raise ConfigurationError(
            f"ENVIRONMENT={environment!r} is not valid; must be one of {VALID_ENVIRONMENTS}."
        )

    allow_demo_seed = (env.get("FORGE_ALLOW_DEMO_SEED", "false").strip().lower() == "true")
    if environment == "production" and allow_demo_seed:
        raise ConfigurationError(
            "FORGE_ALLOW_DEMO_SEED=true is not allowed when ENVIRONMENT=production. "
            "Demo seeding must never be enabled in a production environment."
        )

    demo_password = (env.get("FORGE_DEMO_PASSWORD") or "").strip() or None
    if allow_demo_seed and not demo_password:
        raise ConfigurationError(
            "FORGE_ALLOW_DEMO_SEED=true requires FORGE_DEMO_PASSWORD to be set explicitly — "
            "no demo password ships as a hardcoded default anymore."
        )

    return Settings(
        mongo_url=mongo_url,
        db_name=db_name,
        mongo_max_pool_size=mongo_max_pool_size,
        mongo_min_pool_size=mongo_min_pool_size,
        mongo_connect_timeout_ms=mongo_connect_timeout_ms,
        mongo_server_selection_timeout_ms=mongo_server_selection_timeout_ms,
        mongo_socket_timeout_ms=mongo_socket_timeout_ms,
        mongo_wait_queue_timeout_ms=mongo_wait_queue_timeout_ms,
        jwt_secret=jwt_secret,
        jwt_algorithm=(env.get("JWT_ALGORITHM") or "HS256").strip(),
        jwt_exp_minutes=jwt_exp_minutes,
        media_storage_driver=driver,
        supabase_url=supabase_url,
        supabase_service_role_key=service_key,
        supabase_anon_key=anon_key,
        supabase_public_bucket=public_bucket,
        supabase_private_bucket=private_bucket,
        allow_demo_seed=allow_demo_seed,
        environment=environment,
        demo_password=demo_password,
        mfa_encryption_key=mfa_encryption_key,
    )


# Imported by runtime modules. Invalid configuration stops module import with a
# descriptive error before database/auth clients are constructed.
settings = load_settings()
