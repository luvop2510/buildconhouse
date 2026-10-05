import json
import sys
from types import SimpleNamespace

from services.monitoring import init_monitoring, scrub_monitoring_event


def test_monitoring_scrubs_all_sdk_sensitive_fields():
    secret = "customer@example.com token=secret123"
    event = {
        "event_id": "abc", "level": "error", "transaction": secret,
        "request": {"headers": {"Authorization": secret}, "data": secret},
        "user": {"email": secret}, "extra": {"record": secret},
        "logentry": {"message": secret}, "message": secret,
        "tags": {"customer": secret}, "breadcrumbs": [{"message": secret}],
        "contexts": {"device": {"name": secret}, "trace": {
            "trace_id": "a" * 32, "span_id": "b" * 16, "data": secret}},
        "exception": {"values": [{"type": "ValueError", "value": secret,
            "stacktrace": {"frames": [{"module": "routes.payments",
                "function": "update_payment", "filename": secret,
                "vars": {"password": secret}, "context_line": secret}]}}]},
        "spans": [{"description": secret}],
    }
    clean = scrub_monitoring_event(event)
    assert secret not in json.dumps(clean)
    assert clean["transaction"] == "backend.request"
    assert clean["exception"]["values"][0]["type"] == "ValueError"
    assert clean["exception"]["values"][0]["stacktrace"]["frames"] == [
        {"module": "routes.payments", "function": "update_payment"}]
    assert clean["contexts"]["trace"]["trace_id"] == "a" * 32


def test_monitoring_installs_privacy_callbacks(monkeypatch):
    options = {}
    monkeypatch.setenv("SENTRY_DSN", "https://fake@example.invalid/1")
    monkeypatch.setitem(sys.modules, "sentry_sdk", SimpleNamespace(init=lambda **kwargs: options.update(kwargs)))
    monkeypatch.setitem(sys.modules, "sentry_sdk.integrations.fastapi", SimpleNamespace(FastApiIntegration=lambda **kw: kw))
    monkeypatch.setitem(sys.modules, "sentry_sdk.integrations.starlette", SimpleNamespace(StarletteIntegration=lambda **kw: kw))
    assert init_monitoring() == {"sentry": True}
    assert options["send_default_pii"] is False
    assert options["include_local_variables"] is False
    assert options["max_breadcrumbs"] == 0
    assert options["before_send"] is scrub_monitoring_event
    assert options["before_send_transaction"] is scrub_monitoring_event
