import json
from types import SimpleNamespace

import httpx
import pytest
from pymongo.errors import OperationFailure

from scripts import predeploy_backend_gate as gate


PRIVATE = "synthetic-private-token https://user:password@provider.invalid/customer"


def probes(monkeypatch, *, report=None, bootstrap_error=None, bucket_error=None):
    calls = []

    async def bootstrap(*, enforce_indexes):
        calls.append(("bootstrap", enforce_indexes))
        if bootstrap_error is not None:
            raise bootstrap_error
        return report or SimpleNamespace(healthy=True, errors=[], checks={
            "mongo": {"connected": True, "missing_indexes": {}}})

    async def ready():
        calls.append(("supabase",))
        if bucket_error is not None:
            raise bucket_error

    monkeypatch.setattr(gate, "_load_checks", lambda: (bootstrap, ready))
    return calls


def output(capsys):
    captured = capsys.readouterr()
    assert not captured.err
    assert PRIVATE not in captured.out
    assert "password" not in captured.out and "customer" not in captured.out
    return json.loads(captured.out)


@pytest.mark.asyncio
async def test_healthy_gate_preserves_status_shape_and_both_read_only_probes(monkeypatch, capsys):
    calls = probes(monkeypatch)
    assert await gate.main() == 0
    assert calls == [("bootstrap", True), ("supabase",)]
    assert output(capsys) == {"read_only": True, "checks": {
        "mongodb_ping": "pass", "required_indexes": "pass", "supabase_buckets": "pass"}}


@pytest.mark.asyncio
@pytest.mark.parametrize("mongo", [
    {"connected": False},
    {"connected": True, "missing_indexes": {"users": PRIVATE}},
    {"connected": True, "missing_unique_indexes": {"users": PRIVATE}},
    {"connected": True, "database": PRIVATE, "missing_collections": [PRIVATE]},
])
async def test_unhealthy_returned_errors_remain_blocking_and_redacted(monkeypatch, capsys, mongo):
    report = SimpleNamespace(healthy=False, errors=[PRIVATE, PRIVATE], checks={"mongo": mongo})
    calls = probes(monkeypatch, report=report)
    assert await gate.main() == 1
    assert calls == [("bootstrap", True), ("supabase",)]
    checks = output(capsys)["checks"]
    assert checks["mongodb_ping"] == ("pass" if mongo["connected"] else "fail")
    assert checks["required_indexes"] == ("fail" if mongo.get("missing_indexes") else "pass")
    assert checks["supabase_buckets"] == "pass"
    assert checks["bootstrap_errors"] == {"phase": "bootstrap", "error_count": 2}


class CannotStringify(Exception):
    def __str__(self):
        raise AssertionError("Provider messages must not be inspected")


@pytest.mark.asyncio
@pytest.mark.parametrize("exc,diagnostic", [
    (OperationFailure(PRIVATE, code=8000), {"exception_type": "OperationFailure", "provider_code": 8000}),
    (CannotStringify(PRIVATE), {"exception_type": "CannotStringify"}),
    (ExceptionGroup(PRIVATE, [RuntimeError(PRIVATE)]), {"exception_type": "RuntimeError"}),
])
async def test_bootstrap_exception_text_and_args_never_reach_logs(monkeypatch, capsys, exc, diagnostic):
    calls = probes(monkeypatch, bootstrap_error=exc)
    assert await gate.main() == 1
    assert calls == [("bootstrap", True)]
    assert output(capsys)["checks"] == {"failure": {**diagnostic, "phase": "bootstrap"}}


@pytest.mark.asyncio
async def test_bucket_http_failure_retains_numeric_status_and_completed_checks(monkeypatch, capsys):
    response = httpx.Response(503, text=PRIVATE, request=httpx.Request("GET", "https://provider.invalid"))
    exc = httpx.HTTPStatusError(PRIVATE, request=response.request, response=response)
    probes(monkeypatch, bucket_error=exc)
    assert await gate.main() == 1
    checks = output(capsys)["checks"]
    assert checks == {"mongodb_ping": "pass", "required_indexes": "pass", "failure": {
        "exception_type": "HTTPStatusError", "phase": "supabase-buckets", "status_code": 503}}


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [401, 403, 503])
async def test_actual_supabase_readiness_error_preserves_only_http_status(monkeypatch, capsys, status):
    from media_storage.supabase_driver import supabase_ready

    class Client:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def get(self, *args, **kwargs):
            return httpx.Response(status, text=PRIVATE)

    monkeypatch.setattr(httpx, "AsyncClient", Client)
    calls = probes(monkeypatch)
    bootstrap, _ = gate._load_checks()
    monkeypatch.setattr(gate, "_load_checks", lambda: (bootstrap, supabase_ready))
    assert await gate.main() == 1
    assert calls == [("bootstrap", True)]
    assert output(capsys)["checks"]["failure"] == {
        "exception_type": "StorageError", "phase": "supabase-buckets", "status_code": status}


@pytest.mark.asyncio
async def test_configuration_import_errors_are_inside_safe_boundary(monkeypatch, capsys):
    def fail():
        raise ValueError(PRIVATE)
    monkeypatch.setattr(gate, "_load_checks", fail)
    assert await gate.main() == 1
    assert output(capsys)["checks"] == {"failure": {"exception_type": "ValueError", "phase": "configuration"}}


def test_only_integer_technical_metadata_is_projected():
    exc = RuntimeError(PRIVATE)
    exc.code, exc.status_code = PRIVATE, True
    assert gate.safe_failure(exc, phase="bootstrap") == {
        "exception_type": "RuntimeError", "phase": "bootstrap"}
    assert "status_code" not in gate.safe_failure(
        RuntimeError("Supabase readiness failed [503]: " + PRIVATE), phase="supabase-buckets")
    exc.code, exc.status_code = False, 999
    assert gate.safe_failure(exc, phase="bootstrap") == {
        "exception_type": "RuntimeError", "phase": "bootstrap"}
