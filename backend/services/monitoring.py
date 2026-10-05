"""Production monitoring — Sentry error reporting gated behind environment.

Production readiness audit (2026-08): Forge had zero monitoring/observability
beyond structured stdout logging + the existing /api/health/system endpoint.
This module adds Sentry + PostHog wiring that is a COMPLETE no-op until
credentials are supplied — nothing here changes runtime behavior today.

Required env vars to activate (see backend/.env.example + PRODUCTION.md):
  SENTRY_DSN                  — enables error/crash reporting when set
  SENTRY_ENVIRONMENT          — optional, defaults to "production"
SENTRY_TRACES_SAMPLE_RATE   — optional, defaults to "0.1" (10% tracing)
Monitoring is never a hard dependency of application startup.
"""
from __future__ import annotations

import logging
import os
import re
from collections import deque
from math import ceil
from time import monotonic
from typing import Deque

logger = logging.getLogger("forge.monitoring")


class RequestLatencyTracker:
    """Keep a bounded, in-process view of request latency.

    This is deliberately small and best-effort: it is useful for a single
    process and for structured-log diagnosis, while Sentry/APM remains the
    cross-replica source of truth when configured.  It never stores query
    strings, request bodies, authorization headers, or customer identifiers.
    """

    def __init__(self, max_samples: int = 512) -> None:
        self._samples: Deque[float] = deque(maxlen=max_samples)

    def record(self, duration_ms: float) -> None:
        self._samples.append(max(0.0, duration_ms))

    def snapshot(self) -> dict[str, float | int | None]:
        """Return process-local rolling latency percentiles in milliseconds."""
        if not self._samples:
            return {"count": 0, "p50_ms": None, "p95_ms": None, "max_ms": None}
        values = sorted(self._samples)

        def percentile(percent: float) -> float:
            return values[ceil(percent * len(values)) - 1]

        return {
            "count": len(values),
            "p50_ms": round(percentile(0.50), 1),
            "p95_ms": round(percentile(0.95), 1),
            "max_ms": round(values[-1], 1),
        }


request_latency = RequestLatencyTracker()


def scrub_monitoring_event(event: dict, hint=None) -> dict:
    """Allow only technical error/timing fields; SDK contexts can contain PII.

    Raw exception/log messages, HTTP requests, local variables, database spans,
    user contexts and arbitrary extras never leave the process. Function/module
    names preserve useful grouping without transmitting file paths or values.
    """
    clean = {key: event[key] for key in (
        "event_id", "timestamp", "start_timestamp", "platform", "level",
        "release", "environment", "type",
    ) if key in event}
    if "transaction" in event or event.get("type") == "transaction":
        clean.update(transaction="backend.request", spans=[])
    values = []
    for value in (event.get("exception") or {}).get("values", []):
        safe_type = str(value.get("type", "Error"))
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.]{0,120}", safe_type):
            safe_type = "Error"
        frames = []
        for frame in (value.get("stacktrace") or {}).get("frames", []):
            frames.append({key: item for key in ("module", "function")
                           if isinstance((item := frame.get(key)), str)
                           and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.<>]{0,160}", item)})
        values.append({"type": safe_type, "value": "[redacted]",
                       "stacktrace": {"frames": frames}})
    if values:
        clean["exception"] = {"values": values}
    trace = (event.get("contexts") or {}).get("trace", {})
    safe_trace = {key: trace[key] for key in ("trace_id", "span_id", "parent_span_id")
                  if isinstance(trace.get(key), str)
                  and re.fullmatch(r"[0-9a-f]{16,32}", trace[key])}
    if safe_trace:
        clean["contexts"] = {"trace": safe_trace}
    clean["breadcrumbs"] = []
    return clean


def request_timing_enabled() -> bool:
    """Timing is on by default; allow a controlled emergency opt-out."""
    return (os.environ.get("FORGE_REQUEST_TIMING", "true").strip().lower() != "false")


def slow_request_threshold_ms() -> float:
    """Parse a safe slow-request threshold without letting bad config break traffic."""
    try:
        return max(1.0, float(os.environ.get("FORGE_SLOW_REQUEST_MS", "1000")))
    except ValueError:
        return 1000.0


def record_request_timing(*, method: str, path: str, status_code: int, started_at: float) -> float:
    """Record and, when appropriate, log a request duration without PII."""
    duration_ms = (monotonic() - started_at) * 1000
    request_latency.record(duration_ms)
    if duration_ms >= slow_request_threshold_ms():
        # ``path`` must be a route template supplied by the router, never a
        # raw URL path (which can include customer IDs or create high cardinality).
        logger.warning(
            "slow_request method=%s route=%s status=%d duration_ms=%.1f",
            method, path, status_code, duration_ms,
        )
    return duration_ms

def init_monitoring() -> dict[str, bool]:
    """Call once at process startup (server.py, before the app object is
    used). Returns which integrations activated, for a one-line startup log
    — never raises, even if a package is missing or a DSN is malformed."""
    status = {"sentry": False}

    dsn = (os.environ.get("SENTRY_DSN") or "").strip()
    if dsn:
        try:
            import sentry_sdk
            from sentry_sdk.integrations.fastapi import FastApiIntegration
            from sentry_sdk.integrations.starlette import StarletteIntegration

            sentry_sdk.init(
                dsn=dsn,
                integrations=[
                    StarletteIntegration(transaction_style="endpoint"),
                    FastApiIntegration(transaction_style="endpoint"),
                ],
                traces_sample_rate=float(os.environ.get("SENTRY_TRACES_SAMPLE_RATE", "0.1") or "0.1"),
                send_default_pii=False,
                max_breadcrumbs=0,
                include_local_variables=False,
                before_send=scrub_monitoring_event,
                before_send_transaction=scrub_monitoring_event,
                environment=os.environ.get("SENTRY_ENVIRONMENT", "production"),
            )
            status["sentry"] = True
        except Exception as exc:  # noqa: BLE001 — monitoring must never block startup
            logger.warning("Sentry configured but failed to initialize (%s)", type(exc).__name__)
    else:
        logger.info("SENTRY_DSN not set — error monitoring disabled (safe no-op).")

    return status
