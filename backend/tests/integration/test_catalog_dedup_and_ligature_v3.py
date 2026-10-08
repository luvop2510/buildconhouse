"""Follow-up regression tests for the duplicate-image-suppression fix and
Geberit ligature normalization fix (iteration_9 follow-up to iteration_8's
3 findings: Vitra White/Matt-White duplicate image, Grohe Nova Cosmopolitan
Flush Plate 4-way duplicate image, Geberit ligature text corruption).

Covers:
  1. Vitra Memoria Rim-ex WC family: "White" must show NO image (placeholder),
     "Matt White"/"Matt Black"/"Matt Taupe" must each show their OWN distinct
     real image (deterministic lowest-SKU-keeps-image rule).
  2. Grohe Nova Cosmopolitan Flush Plate (SKU prefix 37601) family: exactly
     1 of the 4 colour-code siblings keeps a real image, the other 3 are None.
  3. Geberit ligature normalization: scans ALL live Geberit products for any
     of the raw Unicode ligature glyphs (fi/fl/ff/ffi/ffl) that the fix was
     supposed to normalize away.
  4. General regression: catalog list/search/brands/categories endpoints
     still respond 200 for all 3 brands after the hydration-layer change.

Run: pytest /app/backend/tests/test_catalog_dedup_and_ligature_v3.py -v
"""
from __future__ import annotations

import os

import pytest
import requests

BASE_URL = os.environ.get("EXPO_BACKEND_URL") or os.environ.get("EXPO_PUBLIC_BACKEND_URL", "")
if not BASE_URL:
    BASE_URL = "http://localhost:8001"
BASE_URL = BASE_URL.rstrip("/")

_LIGATURES = ("\ufb01", "\ufb02", "\ufb00", "\ufb03", "\ufb04")


@pytest.fixture(scope="module")
def api_client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    r = s.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": "owner@forge.app", "password": os.environ["FORGE_TEST_OWNER_PASSWORD"]},
        timeout=40,
    )
    assert r.status_code == 200, r.text
    tok = r.json().get("access_token") or r.json().get("token")
    assert tok
    s.headers["Authorization"] = f"Bearer {tok}"
    return s


def _brand_id(api_client, name: str) -> str:
    r = api_client.get(f"{BASE_URL}/api/brands", timeout=20)
    assert r.status_code == 200
    for b in r.json():
        if b["name"].lower() == name.lower():
            return b["id"]
    pytest.fail(f"Brand {name} not found")


class TestVitraMemoriaDuplicateSuppression:
    """1: Vitra White/Matt White must no longer share the identical photo."""

    def test_white_has_no_image_others_have_distinct_images(self, api_client):
        r = api_client.get(
            f"{BASE_URL}/api/products",
            params={"family_key": "vitra:csw:memoria:rim-ex-wc", "limit": 20},
            timeout=20,
        )
        assert r.status_code == 200
        items = {p["colour"]: p for p in r.json()["items"]}
        assert "White" in items and "Matt White" in items

        white = items["White"]
        matt_white = items["Matt White"]
        assert white.get("hero_image_url") is None, (
            f"Expected 'White' to show NO image (placeholder) since it was a "
            f"byte-identical duplicate of 'Matt White', got {white.get('hero_image_url')}"
        )
        assert matt_white.get("hero_image_url"), "Matt White must keep its own real image"

        # Every non-placeholder image among siblings must be distinct.
        real_images = [p["hero_image_url"] for p in items.values() if p.get("hero_image_url")]
        assert len(real_images) == len(set(real_images)), (
            f"Distinct-colour siblings still sharing an identical image: {real_images}"
        )
        # Matt Black / Matt Taupe must also keep their own real, distinct images.
        for colour in ("Matt Black", "Matt Taupe /Sand Beige"):
            assert items.get(colour, {}).get("hero_image_url"), f"{colour} missing its own image"


class TestGroheNovaCosmopolitanDuplicateSuppression:
    """2: Grohe Nova Cosmopolitan Flush Plate 4 colour codes -> only 1 keeps image."""

    def test_only_one_of_four_colour_codes_keeps_image(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/products", params={"q": "37601", "limit": 20}, timeout=20)
        assert r.status_code == 200
        items = r.json()["items"]
        assert len(items) >= 4, f"Expected >=4 colour-code siblings for SKU 37601*, got {len(items)}"

        with_image = [p for p in items if p.get("hero_image_url")]
        without_image = [p for p in items if not p.get("hero_image_url")]
        assert len(with_image) == 1, (
            f"Expected exactly 1 of {len(items)} siblings to keep the real image, "
            f"got {len(with_image)}: {[p['sku'] for p in with_image]}"
        )
        assert len(without_image) == len(items) - 1


class TestGeberitLigatureNormalization:
    """3: no raw ligature glyphs should remain in Geberit colour/finish/name text."""

    def test_no_ligature_glyphs_in_any_geberit_product(self, api_client):
        gid = _brand_id(api_client, "Geberit")
        violations = []
        skip = 0
        while True:
            r = api_client.get(
                f"{BASE_URL}/api/products", params={"brand_id": gid, "limit": 200, "skip": skip}, timeout=30,
            )
            assert r.status_code == 200
            items = r.json()["items"]
            for p in items:
                for field in ("colour", "finish", "name", "description"):
                    val = str(p.get(field) or "")
                    if any(lig in val for lig in _LIGATURES):
                        violations.append((p["sku"], field, val))
            if len(items) < 200:
                break
            skip += 200
        assert not violations, (
            f"{len(violations)} Geberit fields still contain raw ligature glyphs "
            f"(fix appears to be code-only; live DB was not re-ingested): {violations[:10]}"
        )

    def test_geberit_sigma_116092_family_colour_text_is_clean(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/products", params={"q": "116.092", "limit": 20}, timeout=20)
        assert r.status_code == 200
        items = r.json()["items"]
        assert len(items) >= 1
        for p in items:
            colour = str(p.get("colour") or "")
            assert not any(lig in colour for lig in _LIGATURES), (
                f"SKU {p['sku']} colour still has a raw ligature glyph: {colour!r}"
            )


class TestGeneralRegression:
    """4: catalog list/search/detail still function for all 3 brands."""

    @pytest.mark.parametrize("brand_name", ["Vitra", "Geberit", "Grohe"])
    def test_brand_products_list_loads(self, api_client, brand_name):
        bid = _brand_id(api_client, brand_name)
        r = api_client.get(f"{BASE_URL}/api/products", params={"brand_id": bid, "limit": 20}, timeout=20)
        assert r.status_code == 200
        body = r.json()
        assert body["total"] > 0
        assert len(body["items"]) > 0

    def test_catalog_hierarchy_loads(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/catalog/hierarchy", timeout=20)
        assert r.status_code == 200

    def test_families_endpoint_loads(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/products/families", params={"limit": 20}, timeout=20)
        assert r.status_code == 200
        assert r.json()["total"] > 0

    def test_variant_switch_sku_price_and_image_are_consistent(self, api_client):
        """Switching variant (White -> Matt White) must update SKU + price
        together with image/placeholder — never a stale mismatch."""
        r = api_client.get(
            f"{BASE_URL}/api/products",
            params={"family_key": "vitra:csw:memoria:rim-ex-wc", "limit": 20},
            timeout=20,
        )
        items = {p["colour"]: p for p in r.json()["items"]}
        white, matt_white = items["White"], items["Matt White"]
        assert white["sku"] != matt_white["sku"]
        assert white["price"] != matt_white["price"]
        # image state differs too (None vs real) — already asserted above,
        # here we just confirm SKU/price change together with product id.
        assert white["id"] != matt_white["id"]
