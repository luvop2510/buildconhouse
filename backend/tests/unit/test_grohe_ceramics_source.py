from collections import Counter

import pytest

from catalog_pipeline.grohe_ceramics import extract_images, load_manifest


def test_reviewed_catalogue_preserves_exact_articles_prices_and_finish_pairs():
    manifest = load_manifest()
    rows = {row["sku"]: row for row in manifest["products"]}
    assert manifest["priced_listing_count"] == len(rows) == 82
    assert Counter(row["category"] for row in rows.values()) == {"WC": 27, "Basin": 49, "Accessories": 6}
    assert {row["sku"] for row in rows.values() if row.get("availability") == "Coming Soon"} == {
        "102486SH00", "103848SH00",
    }
    assert set(rows["39577001"]["additional_source_occurrences"][0]) >= {"printed_page", "image_xref"}
    assert len({row["image_sha256"] for row in rows.values()}) == 80
    assert rows["39328I0H"]["image_sha256"] == rows["39328000"]["image_sha256"]
    assert rows["1136662430"]["finish"] == "Matte Black"
    assert rows["105536SH00"]["finish"] == "White"
    assert {sku: row["mrp"] + rows[row["seat_cover_sku"]]["mrp"]
            for sku, row in rows.items() if row.get("seat_cover_sku")} == {
        "1136662430": 51500, "1136682430": 39000, "105536SH00": 45000, "101001SH00": 34000,
        "102486SH00": 24000, "3957300H": 51980, "39328I0H": 28250, "39328000": 28250,
    }
    for sku in ("1137782430", "39244000", "103848SH00", "39354SH1"):
        assert rows[sku]["seat_cover_included"] and "seat_cover_sku" not in rows[sku]
    assert rows["39354SH1"]["must_buy_skus"] == ["46944001"]
    assert rows["102915SH00"]["must_buy_skus"] == ["1029950200"]
    with pytest.raises(ValueError, match="differs from the reviewed"):
        extract_images(b"different PDF", manifest)
