"""Login rate limiting — brute-force protection for staff/customer
authentication endpoints.

Production readiness audit (2026-08): login endpoints had NO rate limiting at
all — any actor could attempt unlimited password guesses against a known
email. This is a real gap fixed here with the smallest safe mechanism that
matches the app's existing style (see auth.py's `_principal_cache`, also a
deliberate in-memory cache): a sliding window keyed by (ip, identifier).

Shared-state upgrade (PRODUCTION_FIXES_2026-07-16.md item 3): the original
version documented its own limitation — per-process state does not survive a
restart and is not shared across replicas, so a horizontally-scaled deploy
could be bypassed by hitting a different pod per attempt. This module now
uses Redis atomic fixed-window counters whenever REDIS_URL is set. A configured
store failure refuses password work with retryable 503 rather than resetting
the shared budget into fresh per-process counters. Without REDIS_URL, the
bounded in-memory implementation supports a single-process deployment.

Scope/limits of the in-memory fallback (documented, not hidden): state is
per-process and resets on restart/deploy, and does not share state across
multiple backend replicas — acceptable for a single-instance launch only.

Load-balancer note (found during the Phase 9 audit's own testing): behind a
reverse proxy/k8s ingress, `request.client.host` can report the proxy's
internal per-pod IP rather than a stable client IP, so a single attacker can
appear to come from a small rotating set of IPs and partially dilute the
per-(ip,email) bucket. To close that gap without depending on IP at all, an
IP-INDEPENDENT per-email ceiling is enforced as well (`_PER_EMAIL_LIMIT`) —
an attacker cannot exceed this no matter how many source IPs they present.
"""
from __future__ import annotations

import logging
import os
from time import monotonic

from fastapi import HTTPException

logger = logging.getLogger("forge.rate_limit")

# 8 failed attempts per (ip, email) per 15 minutes, and a broader 40/15min per
# IP across any email, to blunt both targeted guessing and distributed spray.
# PLUS a 15/15min ceiling keyed on email ALONE (no IP) — closes the gap where
# a proxy/load balancer presents a rotating set of source IPs for the same
# attacker (see module docstring).
_PER_KEY_LIMIT = 8
_PER_IP_LIMIT = 40
_PER_EMAIL_LIMIT = 15
_WINDOW_SECONDS = 15 * 60
_MAX_TRACKED_KEYS = 20_000

_TOO_MANY = HTTPException(status_code=429, detail="Too many login attempts. Please wait a few minutes and try again.")


def _keys(ip: str | None, identifier: str) -> tuple[str, str, str]:
    ip = ip or "unknown"
    identifier = identifier.lower()
    return f"rl:k:{ip}:{identifier}", f"rl:ip:{ip}", f"rl:email:{identifier}"


# ---------------------------------------------------------------------------
# In-memory backend (default — single process only)
# ---------------------------------------------------------------------------
_attempts: dict[str, list[float]] = {}


def _prune(key: str, now: float) -> list[float]:
    window_start = now - _WINDOW_SECONDS
    hits = [t for t in _attempts.get(key, []) if t > window_start]
    if hits:
        _attempts[key] = hits
    else:
        _attempts.pop(key, None)
    return hits


def _check_memory(limits: list[tuple[str, int]]) -> None:
    now = monotonic()
    for key, limit in limits:
        if len(_prune(key, now)) >= limit:
            raise _TOO_MANY


def _record_memory(keys: list[str], limits: list[int] | None = None) -> None:
    now = monotonic()
    # This function has no await points, so checking and recording together is
    # atomic within the asyncio event loop just like the Redis Lua path.
    if limits is not None:
        for key, limit in zip(keys, limits):
            if len(_prune(key, now)) >= limit:
                raise _TOO_MANY
    for key in keys:
        if key not in _attempts and len(_attempts) >= _MAX_TRACKED_KEYS:
            # Keep a strict cap even during a continuous distributed spray.
            # Prefer expired keys; if all entries are live, evict the least
            # recently failed bucket so this fallback cannot grow unbounded.
            oldest = min(
                _attempts,
                key=lambda candidate: _attempts[candidate][-1] if _attempts[candidate] else float("-inf"),
            )
            _attempts.pop(oldest, None)
        _attempts.setdefault(key, []).append(now)


def _clear_memory(keys: list[str]) -> None:
    for key in keys:
        _attempts.pop(key, None)


# ---------------------------------------------------------------------------
# Redis backend (shared across replicas — used when REDIS_URL is set)
# ---------------------------------------------------------------------------
_redis = None
_redis_checked = False


def _redis_client():
    global _redis, _redis_checked
    if _redis_checked:
        if _redis is None and (os.environ.get("REDIS_URL") or "").strip():
            raise HTTPException(503, "Sign-in protection is temporarily unavailable. Please try again shortly.", headers={"Retry-After": "30"})
        return _redis
    _redis_checked = True
    url = (os.environ.get("REDIS_URL") or "").strip()
    if not url:
        logger.info("REDIS_URL not set — rate limiting stays per-process in-memory (fine for a single instance).")
        return None
    try:
        import redis.asyncio as redis_asyncio
        _redis = redis_asyncio.from_url(url, decode_responses=True, socket_connect_timeout=3, socket_timeout=3)
    except Exception as exc:  # noqa: BLE001 — invoked at admission, not startup
        logger.warning("Configured login limiter initialization failed (%s)", type(exc).__name__)
        _redis = None
        raise HTTPException(503, "Sign-in protection is temporarily unavailable. Please try again shortly.", headers={"Retry-After": "30"}) from exc
    return _redis


async def _check_redis(r, limits: list[tuple[str, int]]) -> None:
    try:
        counts = await r.mget([key for key, _ in limits])
    except Exception as exc:  # noqa: BLE001 — preserve the configured shared budget
        logger.warning("Configured login limiter check failed (%s)", type(exc).__name__)
        raise HTTPException(503, "Sign-in protection is temporarily unavailable. Please try again shortly.", headers={"Retry-After": "30"}) from exc
    for (_key, limit), count in zip(limits, counts):
        if count is not None and int(count) >= limit:
            raise _TOO_MANY


async def _record_redis(r, keys: list[str], limits: list[int]) -> None:
    try:
        # Check-and-increment is one Redis operation.  A separate MGET before
        # INCR permits simultaneous failed logins to all pass the check.
        script = """
        local ttl = tonumber(ARGV[#ARGV])
        for i = 1, #KEYS do
            if tonumber(redis.call('GET', KEYS[i]) or '0') >= tonumber(ARGV[i]) then
                return 0
            end
        end
        for i = 1, #KEYS do
            local count = redis.call('INCR', KEYS[i])
            if count == 1 then redis.call('EXPIRE', KEYS[i], ttl) end
        end
        return 1
        """
        accepted = await r.eval(script, len(keys), *keys, *limits, _WINDOW_SECONDS)
        if not accepted:
            raise _TOO_MANY
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 — do not grant a fresh local guess budget
        logger.warning("Configured login limiter admission failed (%s)", type(exc).__name__)
        raise HTTPException(503, "Sign-in protection is temporarily unavailable. Please try again shortly.", headers={"Retry-After": "30"}) from exc


async def _clear_redis(r, keys: list[str]) -> None:
    try:
        await r.delete(*keys)
    except Exception as exc:  # noqa: BLE001
        logger.debug("Redis unavailable for rate-limit clear (%s)", type(exc).__name__)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
async def reserve_login_attempt(ip: str | None, identifier: str) -> None:
    """Admit one password comparison atomically, before any awaited lookup.

    The slot counts immediately so a concurrent wave cannot all pass a
    read-only precheck. Success clears the account buckets; the IP ceiling
    still limits repeated successful authentication work.
    """
    await record_login_failure(ip, identifier)


async def check_login_rate_limit(ip: str | None, identifier: str) -> None:
    """Call BEFORE attempting a password check. Raises 429 if the
    per-(ip,identifier), per-ip, OR the IP-independent per-email ceiling is
    already exhausted. Does NOT record an attempt itself — call
    `record_login_failure` after a failed password check so successful
    logins never count against the limit."""
    key, ip_key, email_key = _keys(ip, identifier)
    limits = [(key, _PER_KEY_LIMIT), (ip_key, _PER_IP_LIMIT), (email_key, _PER_EMAIL_LIMIT)]
    r = _redis_client()
    if r is not None:
        await _check_redis(r, limits)
    else:
        _check_memory(limits)


async def record_login_failure(ip: str | None, identifier: str) -> None:
    key, ip_key, email_key = _keys(ip, identifier)
    keys = [key, ip_key, email_key]
    limits = [_PER_KEY_LIMIT, _PER_IP_LIMIT, _PER_EMAIL_LIMIT]
    r = _redis_client()
    if r is not None:
        await _record_redis(r, keys, limits)
    else:
        _record_memory(keys, limits)


async def clear_login_attempts(ip: str | None, identifier: str) -> None:
    """Call after a SUCCESSFUL login so a legitimate user who mistyped their
    password a few times isn't stuck waiting once they get it right."""
    key, _ip_key, email_key = _keys(ip, identifier)
    keys = [key, email_key]
    r = _redis_client()
    if r is not None:
        await _clear_redis(r, keys)
    else:
        _clear_memory(keys)
