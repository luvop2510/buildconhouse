"""Read-only backend pre-deploy gate: health, required indexes and media audit."""
from __future__ import annotations

import asyncio
import json
import re
import sys
from pathlib import Path

from dotenv import load_dotenv

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE))


def _load_checks():
    # Configuration/import failures also belong inside the safe output boundary.
    load_dotenv(BASE / ".env")
    from bootstrap import run_bootstrap
    from media_storage.factory import storage_ready
    return run_bootstrap, storage_ready


def safe_failure(exc: Exception, *, phase: str) -> dict:
    """Project technical fields only; never stringify messages, bodies or config."""
    while isinstance(exc, BaseExceptionGroup) and exc.exceptions:
        exc = exc.exceptions[0]
    detail = {"exception_type": type(exc).__name__, "phase": phase}
    code = getattr(exc, "code", None)
    if type(code) is int:
        detail["provider_code"] = code
    status = getattr(exc, "status_code", None)
    if status is None:
        status = getattr(getattr(exc, "response", None), "status_code", None)
    if status is None and exc.args and isinstance(exc.args[0], str):
        # The direct readiness caller uses this fixed message instead of an
        # HTTPStatusError. Extract only its numeric status, never provider text.
        match = re.fullmatch(r"Supabase readiness failed \[([1-5]\d\d)\]", exc.args[0])
        if match:
            status = int(match[1])
    if type(status) is int and 100 <= status <= 599:
        detail["status_code"] = status
    return detail


async def main() -> int:
    checks: dict[str, object] = {}
    phase = "configuration"
    try:
        run_bootstrap, supabase_ready = _load_checks()
        phase = "bootstrap"
        report = await run_bootstrap(enforce_indexes=True)
        checks["mongodb_ping"] = "pass" if report.checks.get("mongo", {}).get("connected") else "fail"
        checks["required_indexes"] = "pass" if not report.checks.get("mongo", {}).get("missing_indexes") else "fail"
        from settings import settings
        provider = settings.media_storage_driver
        phase = f"{provider}-buckets"
        await supabase_ready()  # explicit authenticated bucket access check
        checks[f"{provider}_buckets"] = "pass"
        if not report.healthy:
            checks["bootstrap_errors"] = {"phase": "bootstrap", "error_count": len(report.errors)}
            print(json.dumps({"read_only": True, "checks": checks}, indent=2))
            return 1
    except Exception as exc:
        checks["failure"] = safe_failure(exc, phase=phase)
        print(json.dumps({"read_only": True, "checks": checks}, indent=2))
        return 1
    print(json.dumps({"read_only": True, "checks": checks}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
