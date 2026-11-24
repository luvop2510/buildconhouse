from services.catalogue_changes import effective_mrp, preview_rows
from services.catalog_service import _product_listing


def source(sku, fields, *, image_hashes=None, row=2):
    return {"sku": sku, "fields": fields, "row": row, "sheet": "Products", "errors": [],
            "image_hashes": image_hashes or []}


def current(sku, **fields):
    return {"id": f"product:{sku}", "sku": sku, "updated_at": "saved", "category_id": "cat",
            "name": "Original", "mrp": 140, "price": 95, "images": ["legacy"], **fields}


def test_price_preview_and_listing_preserve_offer_on_supplier_placement():
    job = {"_id": "price-job", "operation": "prices", "floor_id": "first-floor"}
    entries = [{"entry_id": "one", "mrp": 130}, {"entry_id": "two", "mrp": 130}]
    product = current("001", catalog_entries=entries)
    valid, missing, stale, ambiguous, unchanged = preview_rows(
        job, [
            source("001", {"current_mrp": 130, "new_mrp": 165, "price": 12, "name": "Other"}, image_hashes=["rejected-image"]),
            source("01", {"new_mrp": 25}, row=3),
            source("STALE", {"current_mrp": 139, "new_mrp": 150}, row=4),
            source("AMBIGUOUS", {"new_mrp": 150}, row=5),
            source("BLANK", {"current_mrp": 140}, row=6),
        ], {"001": product, "STALE": current("STALE"), "BLANK": current("BLANK"),
            "AMBIGUOUS": current("AMBIGUOUS", catalog_entries=[{"mrp": 140}, {"mrp": 170}])},
        {}, {"catalogue_prices"},
    )
    assert valid["action"] == "price" and valid["previous_mrp"] == 130
    assert valid["delta"] == {"mrp": 165, "catalog_mrp_only_override": True}
    assert valid["image_hashes"] == []
    patched = {**product, **valid["delta"]}
    assert effective_mrp(patched) == 165
    assert patched["price"] == 95 and patched["name"] == "Original" and patched["images"] == ["legacy"]
    for entry in entries:
        before, after = _product_listing(product, entry), _product_listing(patched, entry)
        assert before["price"] == after["price"] == 130
        assert before["mrp"] == 130 and after["mrp"] == 165
    assert missing["action"] == stale["action"] == ambiguous["action"] == "rejected"
    assert "no matching product" in missing["errors"][0]
    assert "changed" in stale["errors"][0]
    assert "conflicting" in ambiguous["errors"][0]
    assert unchanged["action"] == "unchanged"


def test_add_ignores_existing_and_rejects_conflicting_duplicate_source_rows():
    job = {"_id": "add-job", "operation": "add", "floor_id": "first-floor"}
    fields = {"name": "Basin", "category": "Basins", "mrp": 100}
    existing, new, duplicate, conflict = preview_rows(
        job, [source("001", fields), source("002", fields, row=3), source("003", fields, row=4),
              source("003", {**fields, "mrp": 300}, row=5)],
        {"001": current("001")}, {"basins": {"id": "cat", "name": "Basins"}},
        {"catalogue_products_add"},
    )
    assert existing["action"] == "unchanged" and existing["delta"] == {}
    assert new["action"] == "add" and new["sku"] == "002"
    assert new["category"]["id"] == "cat"
    assert duplicate["action"] == conflict["action"] == "rejected"
    assert "Duplicate article" in duplicate["errors"][0]
    assert "Duplicate article" in conflict["errors"][0]


def test_sync_checks_new_tile_measurements_and_preserves_existing_specs():
    job = {"_id": "tile-job", "operation": "sync", "floor_id": "ground-floor", "create_categories": True}
    existing, new = preview_rows(
        job, [source("OLD", {"specs": {"pcs_per_box": "3"}, "price": 100}), source("NEW", {
            "name": "New", "category": "Tile", "mrp": 100, "size": "600x600", "specs": {"price_unit": "sqft"},
        }, row=3)],
        {"OLD": current("OLD", specs={"direction": "long", "pcs_per_box": "5"})}, {},
        {"catalogue_categories", "catalogue_products_add", "catalogue_products_edit"},
    )
    assert existing["action"] == "rejected"
    assert "permission" in existing["errors"][0]
    assert existing["delta"]["specs"] == {"direction": "long", "pcs_per_box": "3"}
    assert new["action"] == "rejected"
    assert set(new["errors"]) == {"Pieces per Box is required for a new product.", "Square Feet per Box is required for a new product."}
