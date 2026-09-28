from pathlib import Path


def test_runtime_image_copies_catalog_pipeline_and_imports_server():
    dockerfile = (Path(__file__).resolve().parents[2] / "Dockerfile").read_text()

    assert "COPY catalog_pipeline ./catalog_pipeline" in dockerfile
    assert "COPY buildcon_logo.png buildcon_cover_logo.png ./" in dockerfile
    assert "import server; from services.quotation_ppt import ASSET_DIR, PARTNER_LOGOS; assert server.app" in dockerfile
    assert '(ASSET_DIR / "buildcon_cover_logo.png").is_file()' in dockerfile
    assert "ENVIRONMENT='development'" in dockerfile
