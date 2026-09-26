from scripts.recover_vitra_official_masters import official_asset_url


def test_official_asset_url_extracts_direct_master_from_vitra_preview_meta_tag():
    page = (
        '<meta property="og:image" content="https://img-salsify.mncdn.com/mnpadding/515/515/FFFFFF/images/q_auto:low/a1b2/4518B403H0090_Cut_Out.jpg" />'
        '<span>Product Code: 4518B403H0090</span>'
    )

    assert official_asset_url(page, "4518B403H0090") == "https://img-salsify.mncdn.com/images/a1b2/4518B403H0090_Cut_Out.jpg"


def test_official_asset_url_rejects_missing_sku_and_non_salsify_assets():
    page = '<meta property="og:image" content="https://example.test/image.jpg" />'

    assert official_asset_url(page, "4518B403H0090") is None


def test_official_asset_url_rejects_sibling_variant_on_exact_sku_page():
    page = (
        '<meta property="og:image" content="https://img-salsify.mncdn.com/mnpadding/515/515/FFFFFF/images/q_auto:low/a1b2/191_001H209.jpg" />'
        '<span>Product Code: 191-401H209</span>'
    )

    assert official_asset_url(page, "191-401H209") is None
