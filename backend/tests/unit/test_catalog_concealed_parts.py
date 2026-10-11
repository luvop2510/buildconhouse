"""Exact persisted concealed associations survive every catalog read shape."""
from services.catalog_service import _build_snapshot, hydrate_product


def product(product_id, sku, *, brand="brand-a", floor="first-floor", **values):
    return {"id": product_id, "sku": sku, "name": product_id, "floor_id": floor,
            "brand_id": brand, "category_id": "mixers", "price": 100, "mrp": 120,
            "active": True, "images": [], **values}


def hydrate(selected, *others):
    return hydrate_product(selected, _build_snapshot([selected, *others], [], [], [], []))


def test_selected_id_wins_over_same_sku_at_another_brand_and_refreshes_price():
    trim = product("trim", "TRIM", concealed_part={"sku": "BODY", "product_id": "body-b", "unit_price": 1, "name": "Old body", "qty": 2})
    result = hydrate(trim, product("body-a", "BODY"), product("body-b", "BODY", brand="brand-b", price=350, name="Chosen body"))
    assert result["concealed_part"]["product_id"] == "body-b"
    assert result["concealed_part"]["name"] == "Chosen body"
    assert result["concealed_part"]["unit_price"] == 350
    assert result["concealed_part"]["qty"] == 2


def test_sku_only_legacy_association_prefers_its_brand_and_rejects_ambiguity():
    trim = product("trim", "TRIM", concealed_part={"sku": "BODY"})
    result = hydrate(trim, product("body-b", "BODY", brand="brand-b"), product("body-a", "BODY"))
    assert result["concealed_part"]["product_id"] == "body-a"
    ambiguous = hydrate(trim, product("body-b", "BODY", brand="brand-b"), product("body-c", "BODY", brand="brand-c"))
    assert ambiguous["concealed_part"]["product_id"] is None


def test_saved_id_is_not_replaced_by_an_unrelated_matching_sku():
    trim = product("trim", "TRIM", concealed_part={"sku": "BODY", "product_id": "retired"})
    result = hydrate(trim, product("retired", "BODY", active=False), product("other-body", "BODY"))
    assert result["concealed_part"]["product_id"] is None
    foreign = hydrate(trim, product("retired", "BODY", floor="ground-floor"), product("other-body", "BODY"))
    assert foreign["concealed_part"]["product_id"] is None


def test_family_sibling_without_association_exposes_explicit_null():
    trim = product("trim", "TRIM", family_key="trim-family", finish="Chrome", concealed_part={"sku": "BODY", "product_id": "body"})
    black = product("black", "BLACK", family_key="trim-family", finish="Black")
    result = hydrate(trim, black, product("body", "BODY"))
    assert next(row for row in result["variants"] if row["id"] == "black")["concealed_part"] is None
    assert result["concealed_part"]["product_id"] == "body"
