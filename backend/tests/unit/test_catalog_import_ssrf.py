"""SSRF guard for catalog-import-from-URL (BACKEND_AUDIT_2026-07-17.md
Critical #2) — must re-validate every redirect hop, not just the first
request, and must reject non-standard ports."""
from __future__ import annotations

import asyncio

import httpx
import pytest
from fastapi import HTTPException

from routes.catalog_import_routes import _fetch_public_url, _source_type_and_validate_adapter, _validate_public_host


def test_validate_public_host_accepts_default_https():
    _validate_public_host("https://example.com/file.pdf")  # no raise


def test_validate_public_host_rejects_non_standard_port():
    with pytest.raises(HTTPException) as exc:
        _validate_public_host("https://example.com:8080/file.pdf")
    assert exc.value.status_code == 400


def test_validate_public_host_allows_explicit_default_ports():
    _validate_public_host("https://example.com:443/file.pdf")  # no raise
    _validate_public_host("http://example.com:80/file.pdf")  # no raise


def test_validate_public_host_rejects_non_http_schemes():
    for scheme in ("file", "ftp", "gopher"):
        with pytest.raises(HTTPException) as exc:
            _validate_public_host(f"{scheme}://example.com/x")
        assert exc.value.status_code == 400


def test_import_validation_rejects_binary_xls_instead_of_silently_losing_images():
    with pytest.raises(HTTPException) as exc:
        _source_type_and_validate_adapter("Hansgrohe", "supplier-catalog.xls")
    assert exc.value.status_code == 400
    assert "save as .xlsx" in exc.value.detail


def test_import_validation_enforces_the_selected_supplier_adapter_format():
    with pytest.raises(HTTPException) as exc:
        _source_type_and_validate_adapter("Hansgrohe", "supplier-catalog.pdf")
    assert exc.value.status_code == 400
    assert ".xlsx" in exc.value.detail

    assert _source_type_and_validate_adapter("Hansgrohe", "supplier-catalog.xlsx") == "excel"


class _FakeResponse:
    def __init__(self, status_code, headers=None, content=b""):
        self.status_code = status_code
        self.headers = headers or {}
        self.content = content

    def raise_for_status(self):
        pass


def test_fetch_public_url_rejects_redirect_to_private_address(monkeypatch):
    """A URL that passes the initial guard but 302s to a private address must
    be rejected — this is the concretely demonstrated bypass: httpx's
    follow_redirects=True previously followed it unchecked."""
    calls = {"n": 0}

    async def fake_get(_self, url):
        calls["n"] += 1
        if calls["n"] == 1:
            return _FakeResponse(302, headers={"location": "http://169.254.169.254/latest/meta-data"})
        raise AssertionError("should never reach the redirect target")

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(_fetch_public_url("https://example.com/pricelist.pdf"))
    assert exc.value.status_code == 400
    assert calls["n"] == 1  # never actually requested the private target


def test_fetch_public_url_follows_public_to_public_redirect(monkeypatch):
    calls = {"n": 0}

    async def fake_get(_self, url):
        calls["n"] += 1
        if calls["n"] == 1:
            # Same host as the original request — a real, always-resolvable
            # domain (avoids depending on a made-up subdomain's DNS record
            # existing in whatever environment runs this test).
            return _FakeResponse(302, headers={"location": "https://example.com/pricelist-final.pdf"})
        return _FakeResponse(200, content=b"file-bytes")

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)

    result = asyncio.run(_fetch_public_url("https://example.com/redirect"))
    assert result == b"file-bytes"
    assert calls["n"] == 2
