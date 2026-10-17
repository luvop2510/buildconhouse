"""Repeated variant/rough-in hydration stays bounded to related products."""
import asyncio

from services import catalog_service as catalog


def product(identity, **values):
    return {"id": identity, "sku": identity, "floor_id": "first-floor", "brand_id": "vitra",
            "category_id": "wc", "name": identity, "price": 100, "active": True, **values}


def test_hydration_builds_one_index_and_keeps_floor_brand_finish_guards(monkeypatch):
    selected = product("normal", finish="White", specs={"configuration_group": "style", "configuration_label": "Normal"}, concealed_part={"sku": "BODY"})
    matching = product("bidet", finish="White", specs={"configuration_group": "style", "configuration_label": "Bidet"})
    body = product("body", sku="BODY")
    others = [product("foreign-floor", floor_id="ground-floor", sku="BODY", finish="White", specs={"configuration_group": "style"}),
              product("foreign-brand", brand_id="other", finish="White", specs={"configuration_group": "style"}),
              product("black", finish="Black", specs={"configuration_group": "style"})]
    snapshot = catalog._build_snapshot([selected, matching, body, *others, *[product(f"unrelated-{n}") for n in range(1000)]], [], [], [], [])
    scans = []
    original = catalog._hydration_products
    monkeypatch.setattr(catalog, "_hydration_products", lambda current: (scans.append(True), original(current))[1])
    for _ in range(10):
        hydrated = catalog.hydrate_product(selected, snapshot)
        assert {option["id"] for option in hydrated["configuration_options"]} == {"normal", "bidet"}
        assert hydrated["concealed_part"]["product_id"] == "body"
    assert len(scans) == 1


def test_immediate_edit_rebuilds_indexes_and_usage_preserves_them(monkeypatch):
    selected = product("normal", finish="White", specs={"configuration_group": "style"}, concealed_part={"sku": "BODY"})
    matching = product("bidet", finish="White", specs={"configuration_group": "style"})
    body = product("body", sku="BODY")
    snapshot = catalog._build_snapshot([selected, matching, body], [], [], [], [])
    monkeypatch.setattr(catalog, "_snapshot", snapshot)
    monkeypatch.setattr(catalog, "schedule_catalog_refresh", lambda: None)
    assert len(catalog.hydrate_product(selected, snapshot)["configuration_options"]) == 2
    catalog.patch_product_in_snapshot("bidet", {"specs": {"configuration_group": "other"}})
    catalog.patch_product_in_snapshot("body", {"sku": "RENAMED"})
    hydrated = catalog.hydrate_product(selected, snapshot)
    assert hydrated["configuration_options"] == []
    assert hydrated["concealed_part"]["product_id"] is None
    asyncio.run(catalog.note_product_usage("user", ["normal"], "2026-10-13T00:00:00Z"))
    assert catalog._snapshot.hydration_by_sku is snapshot.hydration_by_sku
    assert catalog._snapshot.hydration_by_configuration is snapshot.hydration_by_configuration
    assert catalog._snapshot.usage_by_user["user"]["normal"]["count"] == 1
