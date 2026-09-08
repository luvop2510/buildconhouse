from services.media_quality import quality_from_dimensions


def test_quality_uses_longest_edge_for_portrait_media():
    assert quality_from_dimensions(240, 720, "image/jpeg") == "good"


def test_decorative_strip_is_never_promoted_by_its_long_edge():
    assert quality_from_dimensions(15, 1195, "image/png") == "poor"


def test_quality_boundaries_are_consistent_with_catalog_contract():
    assert quality_from_dimensions(319, 100, "image/png") == "poor"
    assert quality_from_dimensions(320, 160, "image/png") == "acceptable"
    assert quality_from_dimensions(640, 160, "image/png") == "good"
    assert quality_from_dimensions(1024, 160, "image/png") == "excellent"


def test_missing_dimensions_never_claim_quality():
    assert quality_from_dimensions(None, 800, "image/jpeg") == "missing"
    assert quality_from_dimensions(800, 0, "image/jpeg") == "missing"


def test_vector_media_is_resolution_independent():
    assert quality_from_dimensions(None, None, "image/svg+xml") == "excellent"
