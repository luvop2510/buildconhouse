from scripts.catalog_image_enrichment import _looks_like_image_url, image_dimensions


def test_sku_verified_recovery_accepts_a_safe_scalable_svg_master():
    vector = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 480"><path d="M0 0h1v1H0z"/></svg>'

    assert _looks_like_image_url("https://assets.example.test/product-26456000.svg")
    assert image_dimensions(vector, "image/svg+xml") == (640, 480)


def test_sku_verified_recovery_rejects_active_svg_content():
    unsafe = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'

    try:
        image_dimensions(unsafe, "image/svg+xml")
    except ValueError as error:
        assert "active" in str(error)
    else:
        raise AssertionError("active SVG must not be accepted")
