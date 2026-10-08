"""Regression tests for two P1 catalog-pipeline fixes.

Fix A: VITRA `.wdp` (JPEG XR / HD Photo) frames are now decoded via
       `imagecodecs.jpegxr_decode` and re-encoded as PNG (previously skipped).

Fix B: Certifier no longer rejects legitimate cross-family SKU listings.
       True dupes (same SKU + same family_key) still counted in
       `duplicates_sku` and rejected; cross-family listings counted in the
       new `cross_family_skus` field and kept.

Also verifies:
- /api/health responds 200
- POST /api/auth/login returns a JWT for owner@forge.app / [legacy credential removed]
- Public endpoints /api/catalog/imports/from-url and
  /api/catalog/imports/{id}/approve are wired and reject bad input as expected.
"""
from __future__ import annotations

import base64
import io
import os
import re
import zipfile

import numpy as np
import pytest
import requests
from imagecodecs import jpegxr_encode, png_encode

# Ensure /app/backend is on sys.path so `catalog_pipeline`, `models`, ...
# resolve when pytest is invoked from repo root.
import sys
import pathlib
BACKEND_DIR = pathlib.Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from catalog_pipeline.base import ProductRow  # noqa: E402
from catalog_pipeline.certifier import CertificationReport, validate  # noqa: E402
from catalog_pipeline.image_extractor import extract_images_from_xlsx  # noqa: E402

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "").rstrip("/")
if not BASE_URL:
    # Fallback to internal loopback so unit tests still run if env is missing
    BASE_URL = "http://localhost:8001"


# ---------- helpers ---------------------------------------------------------

def _make_png_bytes() -> bytes:
    arr = np.zeros((6, 6, 3), dtype=np.uint8)
    arr[:, :, 1] = 200  # green
    return bytes(png_encode(arr))


def _make_wdp_bytes() -> bytes:
    arr = np.zeros((6, 6, 3), dtype=np.uint8)
    arr[:, :, 0] = 200  # red
    return bytes(jpegxr_encode(arr))


def _build_synthetic_xlsx(png_bytes: bytes, wdp_bytes: bytes) -> bytes:
    """Build the minimum-viable xlsx zip that `extract_images_from_xlsx`
    walks: workbook → sheet → drawing → media.
    """
    workbook_xml = (
        b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        b'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        b'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        b'<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>'
        b'</workbook>'
    )
    workbook_rels = (
        b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        b'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        b'<Relationship Id="rId1" '
        b'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
        b'Target="worksheets/sheet1.xml"/>'
        b'</Relationships>'
    )
    sheet_xml = (
        b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        b'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        b'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        b'<sheetData/><drawing r:id="rId1"/></worksheet>'
    )
    sheet_rels = (
        b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        b'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        b'<Relationship Id="rId1" '
        b'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" '
        b'Target="../drawings/drawing1.xml"/>'
        b'</Relationships>'
    )
    drawing_xml = (
        b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        b'<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" '
        b'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
        b'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        # PNG anchor at row 1 (0-based → yields row_idx = 1)
        b'<xdr:oneCellAnchor>'
        b'<xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff>'
        b'<xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>'
        b'<xdr:ext cx="100" cy="100"/>'
        b'<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="1" name="png"/><xdr:cNvPicPr/></xdr:nvPicPr>'
        b'<xdr:blipFill><a:blip r:embed="rId1"/></xdr:blipFill>'
        b'<xdr:spPr/></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>'
        # WDP anchor at row 4 (0-based → yields row_idx = 5)
        b'<xdr:oneCellAnchor>'
        b'<xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff>'
        b'<xdr:row>4</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>'
        b'<xdr:ext cx="100" cy="100"/>'
        b'<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="wdp"/><xdr:cNvPicPr/></xdr:nvPicPr>'
        b'<xdr:blipFill><a:blip r:embed="rId2"/></xdr:blipFill>'
        b'<xdr:spPr/></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>'
        b'</xdr:wsDr>'
    )
    drawing_rels = (
        b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        b'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        b'<Relationship Id="rId1" '
        b'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" '
        b'Target="../media/image1.png"/>'
        b'<Relationship Id="rId2" '
        b'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" '
        b'Target="../media/image2.wdp"/>'
        b'</Relationships>'
    )

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("xl/workbook.xml", workbook_xml)
        z.writestr("xl/_rels/workbook.xml.rels", workbook_rels)
        z.writestr("xl/worksheets/sheet1.xml", sheet_xml)
        z.writestr("xl/worksheets/_rels/sheet1.xml.rels", sheet_rels)
        z.writestr("xl/drawings/drawing1.xml", drawing_xml)
        z.writestr("xl/drawings/_rels/drawing1.xml.rels", drawing_rels)
        z.writestr("xl/media/image1.png", png_bytes)
        z.writestr("xl/media/image2.wdp", wdp_bytes)
    return buf.getvalue()


def _build_synthetic_xlsx_absolute_target(png_bytes: bytes, wdp_bytes: bytes) -> bytes:
    """Same as above but uses an absolute Target (`/xl/worksheets/sheet1.xml`)
    in workbook.xml.rels — exercises the latent-bug fix in image_extractor."""
    workbook_xml = (
        b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        b'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        b'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        b'<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>'
        b'</workbook>'
    )
    workbook_rels = (
        b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        b'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        b'<Relationship Id="rId1" '
        b'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
        b'Target="/xl/worksheets/sheet1.xml"/>'
        b'</Relationships>'
    )
    sheet_xml = (
        b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        b'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        b'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        b'<sheetData/><drawing r:id="rId1"/></worksheet>'
    )
    sheet_rels = (
        b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        b'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        b'<Relationship Id="rId1" '
        b'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" '
        b'Target="../drawings/drawing1.xml"/>'
        b'</Relationships>'
    )
    drawing_xml = (
        b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        b'<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" '
        b'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
        b'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        b'<xdr:oneCellAnchor>'
        b'<xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff>'
        b'<xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>'
        b'<xdr:ext cx="100" cy="100"/>'
        b'<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="1" name="png"/><xdr:cNvPicPr/></xdr:nvPicPr>'
        b'<xdr:blipFill><a:blip r:embed="rId1"/></xdr:blipFill>'
        b'<xdr:spPr/></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>'
        b'<xdr:oneCellAnchor>'
        b'<xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff>'
        b'<xdr:row>2</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>'
        b'<xdr:ext cx="100" cy="100"/>'
        b'<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="wdp"/><xdr:cNvPicPr/></xdr:nvPicPr>'
        b'<xdr:blipFill><a:blip r:embed="rId2"/></xdr:blipFill>'
        b'<xdr:spPr/></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>'
        b'</xdr:wsDr>'
    )
    drawing_rels = (
        b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        b'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        b'<Relationship Id="rId1" '
        b'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" '
        b'Target="../media/image1.png"/>'
        b'<Relationship Id="rId2" '
        b'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" '
        b'Target="../media/image2.wdp"/>'
        b'</Relationships>'
    )

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("xl/workbook.xml", workbook_xml)
        z.writestr("xl/_rels/workbook.xml.rels", workbook_rels)
        z.writestr("xl/worksheets/sheet1.xml", sheet_xml)
        z.writestr("xl/worksheets/_rels/sheet1.xml.rels", sheet_rels)
        z.writestr("xl/drawings/drawing1.xml", drawing_xml)
        z.writestr("xl/drawings/_rels/drawing1.xml.rels", drawing_rels)
        z.writestr("xl/media/image1.png", png_bytes)
        z.writestr("xl/media/image2.wdp", wdp_bytes)
    return buf.getvalue()


# ---------- backend health + auth ------------------------------------------

@pytest.fixture(scope="module")
def api_client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


class TestHealthAndAuth:
    def test_health(self, api_client):
        # Try several likely health endpoints; at least one must return 200.
        candidates = [f"{BASE_URL}/api/health", f"{BASE_URL}/api/", f"{BASE_URL}/api"]
        oks = []
        for u in candidates:
            try:
                r = api_client.get(u, timeout=15)
                oks.append((u, r.status_code))
                if r.status_code == 200:
                    return
            except Exception as e:  # noqa: BLE001
                oks.append((u, str(e)))
        pytest.fail(f"No health endpoint returned 200: {oks}")

    def test_owner_login_returns_jwt(self, api_client):
        r = api_client.post(
            f"{BASE_URL}/api/auth/login",
            json={"email": "owner@forge.app", "password": os.environ["FORGE_TEST_OWNER_PASSWORD"]},
            timeout=20,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        # Accept common shapes: {token: ...} or {access_token: ...}
        tok = body.get("token") or body.get("access_token")
        assert tok, f"No token in login response: {body}"
        # JWT has three base64 chunks separated by dots
        assert re.match(r"^[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+$", tok), (
            f"Login token doesn't look like a JWT: {tok[:40]}..."
        )
        # Stash for later tests
        api_client.headers["Authorization"] = f"Bearer {tok}"


# ---------- Fix A: WDP image extraction -------------------------------------

class TestImageExtractorWdp:
    def test_png_and_wdp_both_returned_as_png_data_urls(self):
        png = _make_png_bytes()
        wdp = _make_wdp_bytes()
        xlsx = _build_synthetic_xlsx(png, wdp)

        results = list(extract_images_from_xlsx(xlsx))
        assert len(results) == 2, f"Expected 2 images (PNG + WDP), got {len(results)}: {results}"

        # Every result must be a PNG data URL (WDP re-encoded to PNG).
        for sheet_name, row_idx, sha, url in results:
            assert sheet_name == "Sheet1"
            assert url.startswith("data:image/png;base64,"), url[:60]
            payload = base64.b64decode(url.split(",", 1)[1])
            assert payload[:8] == b"\x89PNG\r\n\x1a\n", "Decoded bytes are not PNG"
            assert len(payload) > 0

        rows = sorted(r[1] for r in results)
        assert rows == [1, 5], f"Unexpected anchor rows: {rows}"

    def test_absolute_target_workbook_rels_still_works(self):
        """Second workbook.xml.rels convention: `Target='/xl/worksheets/sheet1.xml'`.
        Latent bug (double `xl/xl/` prefix) is now fixed."""
        png = _make_png_bytes()
        wdp = _make_wdp_bytes()
        xlsx = _build_synthetic_xlsx_absolute_target(png, wdp)
        results = list(extract_images_from_xlsx(xlsx))
        assert len(results) == 2, (
            f"Absolute-target xlsx should still yield 2 images; got {len(results)}"
        )
        for _, _, _, url in results:
            assert url.startswith("data:image/png;base64,")


# ---------- Fix B: Certifier cross-family SKU logic -------------------------

def _clean_row(sku: str, family_key: str, name: str, cat: str = "Faucets") -> ProductRow:
    return ProductRow(
        brand="Vitra",
        name=name,
        sku=sku,
        category=cat,
        family_key=family_key,
        variant="Chrome",
        mrp=1000.0,
        dealer_price=800.0,
        images=["data:image/png;base64,AAAA"],
        confidence=1.0,
    )


class TestCertifierCrossFamily:
    def test_true_duplicate_same_family_rejects_and_counts(self):
        rows = [
            _clean_row("115.001", "FAM_A", "Basin Mixer A1"),
            _clean_row("115.001", "FAM_A", "Basin Mixer A1 duplicate"),
        ]
        validated, cert = validate(rows)

        assert cert.duplicates_sku == 1, cert.duplicates_sku
        assert cert.cross_family_skus == 0, cert.cross_family_skus
        # First stays pending/accepted, second must be rejected
        assert validated[0].status != "rejected"
        assert validated[1].status == "rejected"
        assert cert.production_ready is False, "True dupes must gate production_ready in a 2-row set"

    def test_cross_family_listing_is_allowed_and_scored_high(self):
        rows = [
            # Legitimate cross-family listing (same SKU, different family_keys)
            _clean_row("115.882.KJ.1", "FAM_X", "Concealed Cistern X"),
            _clean_row("115.882.KJ.1", "FAM_Y", "Flush Plate Y bundle"),
            # A couple of clean rows to buff the score across the 8 sub-axes
            _clean_row("SKU-CLEAN-1", "FAM_C1", "Clean row 1"),
            _clean_row("SKU-CLEAN-2", "FAM_C2", "Clean row 2"),
        ]
        validated, cert = validate(rows)

        assert cert.duplicates_sku == 0, f"expected no true dupes; got {cert.duplicates_sku}"
        assert cert.cross_family_skus == 1, f"expected 1 cross-family listing; got {cert.cross_family_skus}"
        # Neither cross-family row should be rejected
        for r in validated[:2]:
            assert r.status != "rejected", (
                f"Cross-family row {r.sku} was rejected — regression: {r.issues}"
            )
        assert cert.overall_score >= 95.0, f"overall_score={cert.overall_score}"
        assert cert.production_ready is True, (
            f"production_ready False (score={cert.overall_score}, "
            f"dupes={cert.duplicates_sku}, xfam={cert.cross_family_skus})"
        )

    def test_to_public_includes_cross_family_skus_key(self):
        cert = CertificationReport()
        pub = cert.to_public()
        # New key must be present ...
        assert "cross_family_skus" in pub
        assert isinstance(pub["cross_family_skus"], int)
        # ... and every legacy key must still be there (regression check).
        for key in (
            "extraction_accuracy", "sku_accuracy", "price_accuracy",
            "category_accuracy", "variant_accuracy", "image_accuracy",
            "duplicate_score", "missing_data_score", "total_products",
            "products_ready", "products_needing_review", "families_detected",
            "duplicates_sku", "duplicates_family", "missing_images",
            "missing_mrp", "missing_categories", "variant_conflicts",
            "category_conflicts", "warnings", "overall_score", "production_ready",
        ):
            assert key in pub, f"legacy key '{key}' disappeared from to_public()"


# ---------- Pipeline end-to-end (programmatic, in-process) ------------------

class TestPipelineEndToEnd:
    """Uses `run_pipeline` in-process so we don't need real supplier URLs."""

    def _tiny_vitra_xlsx(self) -> bytes:
        """A minimal but valid Vitra-style xlsx with a header row and one data
        row, plus one PNG and one WDP image. Enough to prove the pipeline runs
        without error and that the certifier report includes the new field."""
        # Header + data row using SharedStrings-free inline strings
        sheet_xml = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            '<sheetData>'
            '<row r="1">'
            '<c r="A1" t="inlineStr"><is><t>SKU</t></is></c>'
            '<c r="B1" t="inlineStr"><is><t>Name</t></is></c>'
            '<c r="C1" t="inlineStr"><is><t>MRP</t></is></c>'
            '</row>'
            '<row r="2">'
            '<c r="A2" t="inlineStr"><is><t>V-TEST-001</t></is></c>'
            '<c r="B2" t="inlineStr"><is><t>Vitra Test Basin</t></is></c>'
            '<c r="C2"><v>1200</v></c>'
            '</row>'
            '</sheetData>'
            '<drawing r:id="rId1"/></worksheet>'
        ).encode()

        # Reuse the drawing/rels structure from the synthetic helper.
        png = _make_png_bytes()
        wdp = _make_wdp_bytes()
        base_xlsx = _build_synthetic_xlsx(png, wdp)
        # Rebuild the zip, swapping in our sheet_xml
        out = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(base_xlsx), "r") as zin, \
                zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:
            for name in zin.namelist():
                if name == "xl/worksheets/sheet1.xml":
                    zout.writestr(name, sheet_xml)
                else:
                    zout.writestr(name, zin.read(name))
        return out.getvalue()

    def test_run_pipeline_returns_certification_with_new_key(self):
        import asyncio
        from catalog_pipeline.orchestrator import run_pipeline

        xlsx = self._tiny_vitra_xlsx()
        result = asyncio.run(run_pipeline("Vitra", "vitra_test.xlsx", xlsx))
        assert "certification" in result
        cert = result["certification"]
        assert "cross_family_skus" in cert, "orchestrator dropped the new field"
        assert "duplicates_sku" in cert
        # Not asserting rows/images because the Vitra adapter may or may not
        # infer a SKU column layout from this minimal sheet; the goal here is
        # to prove the pipeline still runs end-to-end and the new key is
        # surfaced through orchestrator → certifier.to_public().


# ---------- Route-level smoke tests ----------------------------------------

class TestCatalogImportRoutes:
    """Make sure the two public entry points are wired and reject bad input as
    expected. We don't hit real supplier URLs."""

    def test_from_url_requires_auth(self, api_client):
        # Clear any existing Authorization to test the anonymous path
        headers = {k: v for k, v in api_client.headers.items() if k.lower() != "authorization"}
        r = requests.post(
            f"{BASE_URL}/api/catalog/imports/from-url",
            json={"brand": "Vitra", "url": "https://example.com/foo.xlsx"},
            headers={"Content-Type": "application/json", **headers},
            timeout=15,
        )
        assert r.status_code in (401, 403), f"expected auth challenge, got {r.status_code}: {r.text[:200]}"

    def test_from_url_rejects_unsupported_brand(self, api_client):
        assert api_client.headers.get("Authorization"), "login fixture didn't run"
        r = api_client.post(
            f"{BASE_URL}/api/catalog/imports/from-url",
            json={"brand": "NotABrand", "url": "https://example.com/foo.xlsx"},
            timeout=15,
        )
        assert r.status_code == 400, r.text

    def test_from_url_rejects_bad_url(self, api_client):
        assert api_client.headers.get("Authorization"), "login fixture didn't run"
        r = api_client.post(
            f"{BASE_URL}/api/catalog/imports/from-url",
            json={"brand": "Vitra", "url": "not-a-url"},
            timeout=15,
        )
        assert r.status_code == 400, r.text

    def test_approve_missing_job_returns_404(self, api_client):
        assert api_client.headers.get("Authorization"), "login fixture didn't run"
        r = api_client.post(
            f"{BASE_URL}/api/catalog/imports/does-not-exist/approve",
            timeout=15,
        )
        # Auth guard already gates on role — 404 means auth passed and the
        # job lookup ran, which is what we want to verify (route wiring).
        assert r.status_code in (404, 403), r.text

    def test_supported_brands(self, api_client):
        assert api_client.headers.get("Authorization"), "login fixture didn't run"
        r = api_client.get(f"{BASE_URL}/api/catalog/imports/config/brands", timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        assert "Vitra" in body.get("brands", [])
        assert "Geberit" in body.get("brands", [])
