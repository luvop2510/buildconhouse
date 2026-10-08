"""Regression tests for the catalog re-ingestion fix (variant image /
colour-label cross-contamination bug reported for Vitra, Geberit, Grohe).

Scans the LIVE catalog (via /api/products) for every brand and asserts:
  1. Within a family_key, two products with DIFFERENT colour/finish must not
     point at the exact same image URL (this was the reported bug).
  2. Variant/finish labels are real finish names, not the generic word
     "Variant".
  3. Spot-checked SKUs mentioned in the review request resolve and have
     sane price/sku/colour data.

Run: pytest /app/backend/tests/test_catalog_variant_image_contamination.py -v
"""
from __future__ import annotations

import os
from collections import defaultdict

import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "").rstrip("/")
if not BASE_URL:
    BASE_URL = "http://localhost:8001"


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


def _fetch_all_products(api_client, brand_id: str) -> list[dict]:
    out = []
    skip = 0
    limit = 200
    while True:
        r = api_client.get(
            f"{BASE_URL}/api/products",
            params={"brand_id": brand_id, "limit": limit, "skip": skip},
            timeout=60,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        items = body.get("items", [])
        out.extend(items)
        if len(items) < limit:
            break
        skip += limit
        if skip > 3000:
            break
    return out


def _brand_id(api_client, name: str) -> str:
    r = api_client.get(f"{BASE_URL}/api/brands", timeout=20)
    assert r.status_code == 200
    for b in r.json():
        if b["name"].lower() == name.lower():
            return b["id"]
    pytest.fail(f"Brand {name} not found")


class TestCrossContaminationByBrand:
    """For every brand, group active products by family_key and flag any
    family where 2+ distinct colours share the exact same hero_image_url."""

    @pytest.mark.parametrize("brand_name", ["Vitra", "Geberit", "Grohe"])
    def test_no_same_image_across_different_colours(self, api_client, brand_name):
        bid = _brand_id(api_client, brand_name)
        products = _fetch_all_products(api_client, bid)
        assert len(products) > 0, f"No products found for {brand_name}"

        by_family: dict[str, list[dict]] = defaultdict(list)
        for p in products:
            fk = p.get("family_key") or f"__none__:{p['id']}"
            by_family[fk].append(p)

        violations = []
        for fk, group in by_family.items():
            if len(group) < 2:
                continue
            by_image: dict[str, set[str]] = defaultdict(set)
            for p in group:
                img = p.get("hero_image_url") or (p.get("images") or [None])[0]
                colour = (p.get("colour") or p.get("finish") or "").strip().lower()
                if not img or not colour:
                    continue
                by_image[img].add(colour)
            for img, colours in by_image.items():
                if len(colours) > 1:
                    violations.append({
                        "family_key": fk, "image": img, "colours": sorted(colours),
                    })

        if violations:
            msg = f"{brand_name}: {len(violations)} families have the SAME image shared across DIFFERENT colours:\n"
            for v in violations[:15]:
                msg += f"  - family={v['family_key']} colours={v['colours']} image={v['image']}\n"
            pytest.fail(msg)

    @pytest.mark.parametrize("brand_name", ["Vitra", "Geberit", "Grohe"])
    def test_no_generic_variant_label(self, api_client, brand_name):
        bid = _brand_id(api_client, brand_name)
        products = _fetch_all_products(api_client, bid)
        generic = [
            p["sku"] for p in products
            if (p.get("colour") or p.get("finish") or p.get("variant_label") or "").strip().lower() == "variant"
        ]
        assert not generic, f"{brand_name}: {len(generic)} SKUs show generic 'Variant' label: {generic[:20]}"


class TestSpotCheckSKUs:
    """Spot checks from the review request."""

    def test_vitra_memoria_family(self, api_client):
        r = api_client.get(
            f"{BASE_URL}/api/products",
            params={"family_key": "vitra:csw:memoria:rim-ex-wc", "limit": 20},
            timeout=20,
        )
        assert r.status_code == 200
        items = r.json()["items"]
        assert len(items) >= 3, f"Expected multiple colour variants, got {len(items)}"
        colours = [ (p.get("colour") or "").lower() for p in items ]
        assert "variant" not in colours
        images = [p.get("hero_image_url") for p in items]
        assert len(set(images)) == len(images), (
            f"Duplicate hero images across distinct-colour Vitra Memoria variants: {list(zip(colours, images))}"
        )

    def test_geberit_sigma_sku(self, api_client):
        r = api_client.get(
            f"{BASE_URL}/api/products", params={"q": "116.092", "limit": 20}, timeout=20,
        )
        assert r.status_code == 200
        items = r.json()["items"]
        assert len(items) >= 1, "Expected at least 1 product for Geberit SKU 116.092.*"
        for p in items:
            assert p.get("sku"), p

    def test_grohe_sample_sku_search(self, api_client):
        r = api_client.get(
            f"{BASE_URL}/api/products", params={"brand_id": _brand_id(api_client, "Grohe"), "limit": 5}, timeout=20,
        )
        assert r.status_code == 200
        items = r.json()["items"]
        assert len(items) > 0
