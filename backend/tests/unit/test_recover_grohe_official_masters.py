from scripts.recover_grohe_official_masters import official_asset_url


def test_official_asset_url_accepts_only_direct_sku_scoped_grohe_assets():
    html = (
        '<img src="/_next/image?url=https%3A%2F%2Fcdn.cloud.grohe.com%2Fprod%2F20%2F26%2F26566GN0%2F1500%2F26566GN0.jpg&amp;w=1024" />'
        '<img src="https://cdn.cloud.grohe.com/prod/20/26/26566000/1500/26566000.jpg" />'
    )

    assert official_asset_url(html, "26566GN0") == "https://cdn.cloud.grohe.com/prod/20/26/26566GN0/1500/26566GN0.jpg"


def test_official_asset_url_rejects_a_different_sku_and_non_direct_transform():
    html = (
        'https://cdn.cloud.grohe.com/prod/20/26/26566000/1500/26566000.jpg '
        'https://cdn.cloud.grohe.com/prod/20/26/26566GN0/1500/thumb.webp'
    )

    assert official_asset_url(html, "26566GN0") is None
