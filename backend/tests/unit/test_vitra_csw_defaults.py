from catalog_pipeline.vitra_csw_defaults import build_seat_cover_pairs


def test_pairs_cover_only_same_series_and_finish():
    rows = [
        {"status": "accepted", "sku": "WC-WHITE", "series": "Memoria", "finish": "White", "category": "Water Closets", "name": "Memoria Rim-Ex WC"},
        {"status": "accepted", "sku": "WC-BLACK", "series": "Memoria", "finish": "Matt Black", "category": "Water Closets", "name": "Memoria Rim-Ex WC with bidet"},
        {"status": "accepted", "sku": "COVER-WHITE", "series": "Memoria", "finish": "White", "category": "Water Closets", "name": "Memoria Seat Cover"},
        {"status": "accepted", "sku": "COVER-BLACK", "series": "Memoria", "finish": "Matt Black", "category": "Water Closets", "name": "Memoria Seat Cover"},
        {"status": "accepted", "sku": "BUNDLED", "series": "M-Line", "finish": "White", "category": "Water Closets", "name": "M-Line WC with seat cover"},
    ]
    pairs, unmatched = build_seat_cover_pairs(rows)
    assert pairs == [("WC-WHITE", "COVER-WHITE"), ("WC-BLACK", "COVER-BLACK")]
    assert unmatched == []
