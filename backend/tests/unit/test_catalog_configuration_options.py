from services.catalog_service import CatalogSnapshot, _configuration_options


def _snapshot(products):
    return CatalogSnapshot(
        products=tuple(products), product_by_id={p["id"]: p for p in products},
        products_by_family={}, media_by_product={}, media_by_family={},
        media_rows_by_product={}, media_rows_by_family={}, brands=(), categories=(),
        global_usage={}, usage_by_user={}, loaded_at=0,
    )


def test_configuration_options_stay_on_the_selected_finish():
    base = {"floor_id": "first-floor", "brand_id": "vitra", "category_id": "wc", "price": 100, "mrp": 100}
    group = "vitra:csw:configuration:memoria:rim-ex-wc"
    white = {**base, "id": "white-normal", "sku": "WHITE-NORMAL", "finish": "White", "specs": {"configuration_group": group, "configuration_label": "Without bidet"}}
    white_bidet = {**base, "id": "white-bidet", "sku": "WHITE-BIDET", "finish": "White", "price": 110, "mrp": 110, "specs": {"configuration_group": group, "configuration_label": "With bidet"}}
    black_bidet = {**base, "id": "black-bidet", "sku": "BLACK-BIDET", "finish": "Matt Black", "price": 150, "mrp": 150, "specs": {"configuration_group": group, "configuration_label": "With bidet"}}

    options = _configuration_options(white, _snapshot([white, white_bidet, black_bidet]))

    assert [(option["sku"], option["label"]) for option in options] == [
        ("WHITE-BIDET", "With bidet"), ("WHITE-NORMAL", "Without bidet"),
    ]
