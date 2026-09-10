"""Settings writes must use Pydantic v2 serialization without persisting audit metadata."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

from models import CompanySettings, PDFSettings, UserPublic
from routes import settings_routes


class _SettingsCollection:
    def __init__(self) -> None:
        self.writes: list[tuple[dict, dict, bool]] = []

    async def update_one(self, query, update, *, upsert=False):
        self.writes.append((query, update, upsert))


def _admin() -> UserPublic:
    return UserPublic(
        id="admin-1", email="admin@example.com", full_name="Admin User",
        role="admin", floor_ids=["first-floor"],
    )


async def _defaults(_key, model):
    return model()


def test_company_settings_write_uses_v2_serialization_and_excludes_audit_fields(monkeypatch):
    settings = _SettingsCollection()
    monkeypatch.setattr(settings_routes, "db", SimpleNamespace(settings=settings))
    monkeypatch.setattr(settings_routes, "_load", _defaults)
    body = CompanySettings(name="BuildCon North", updated_at="client-value", updated_by="client-id")

    asyncio.run(settings_routes.update_company_settings(body, _admin()))

    query, update, upsert = settings.writes[0]
    stored = update["$set"]
    assert query == {"key": settings_routes.COMPANY_KEY}
    assert upsert is True
    assert stored["name"] == "BuildCon North"
    assert stored["key"] == settings_routes.COMPANY_KEY
    assert stored["updated_by"] == "admin-1"
    assert stored["updated_by_name"] == "Admin User"
    assert stored["updated_at"] != "client-value"


def test_pdf_settings_write_uses_v2_serialization_and_excludes_audit_fields(monkeypatch):
    settings = _SettingsCollection()
    monkeypatch.setattr(settings_routes, "db", SimpleNamespace(settings=settings))
    monkeypatch.setattr(settings_routes, "_load", _defaults)
    body = PDFSettings(footer_company_name="BuildCon North", updated_by_name="client-value")

    asyncio.run(settings_routes.update_pdf_settings(body, _admin()))

    query, update, upsert = settings.writes[0]
    stored = update["$set"]
    assert query == {"key": settings_routes.PDF_KEY}
    assert upsert is True
    assert stored["footer_company_name"] == "BuildCon North"
    assert stored["key"] == settings_routes.PDF_KEY
    assert stored["updated_by"] == "admin-1"
    assert stored["updated_by_name"] == "Admin User"
    assert "client-value" not in stored.values()
