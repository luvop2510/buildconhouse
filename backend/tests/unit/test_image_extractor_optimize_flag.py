# backend/tests/unit/test_image_extractor_optimize_flag.py
"""The pipeline retains a 2048px master and recompresses (JPEG/WebP q=90)
images over 60KB or with alpha (image_extractor.py::_optimize,
called unconditionally from _decode_supplier_image). Qutone's explicit
requirement is "preserve original quality, do not compress, do not
resize" — this proves the new opt-out actually bypasses that step, and
that the default (used by every existing brand) is unchanged."""
from __future__ import annotations
import base64
import hashlib
import io

from PIL import Image

from catalog_pipeline.image_extractor import _decode_supplier_image, _resolve_relative


def _make_large_jpeg_bytes(size=(2000, 2000)) -> bytes:
    im = Image.new("RGB", size, color=(120, 60, 200))
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=95)
    return buf.getvalue()


def _decode_data_url(data_url: str) -> bytes:
    _, b64 = data_url.split(",", 1)
    return base64.b64decode(b64)


def test_optimize_true_retains_a_2048px_master_and_recompresses_large_images():
    raw = _make_large_jpeg_bytes()
    result = _decode_supplier_image(raw, "jpeg", optimize=True)
    assert result is not None
    assert max(result.width, result.height) == 2000  # probed dims always describe the SOURCE, pre-optimize
    stored = _decode_data_url(result.data_url)
    stored_im = Image.open(io.BytesIO(stored))
    assert max(stored_im.size) == 2000
    assert len(stored) < len(raw)


def test_optimize_true_caps_oversized_source_at_2048px():
    raw = _make_large_jpeg_bytes((4096, 2048))
    result = _decode_supplier_image(raw, "jpeg", optimize=True)

    assert result is not None
    stored = _decode_data_url(result.data_url)
    stored_im = Image.open(io.BytesIO(stored))
    assert max(stored_im.size) == 2048


def test_optimize_false_preserves_original_bytes_exactly():
    raw = _make_large_jpeg_bytes()
    result = _decode_supplier_image(raw, "jpeg", optimize=False)
    assert result is not None
    assert max(result.width, result.height) == 2000
    stored = _decode_data_url(result.data_url)
    assert stored == raw
    assert result.sha1 == hashlib.sha1(raw).hexdigest()[:16]


def test_optimize_defaults_to_true_for_backward_compatibility_with_existing_brands():
    raw = _make_large_jpeg_bytes()
    result_default = _decode_supplier_image(raw, "jpeg")
    result_explicit_true = _decode_supplier_image(raw, "jpeg", optimize=True)
    assert result_default.bytes_len == result_explicit_true.bytes_len
    assert result_default.bytes_len < len(raw)


def test_resolve_relative_handles_relative_targets_like_real_supplier_files():
    """Every observed real supplier file (incl. QUTONE 2026.xlsx) uses
    relationship Targets like "../drawings/drawing1.xml" — must keep working."""
    assert _resolve_relative("xl/worksheets/", "../drawings/drawing1.xml") == "xl/drawings/drawing1.xml"


def test_resolve_relative_handles_absolute_targets():
    """OOXML also permits a Target starting with "/", meaning "absolute from
    the package root" — openpyxl-written workbooks emit this form. The old
    implementation ignored the leading "/" and concatenated it onto `base`
    anyway, producing a bogus path that silently dropped every image on the
    sheet (caught by a bare `except KeyError`, no warning surfaced)."""
    assert _resolve_relative("xl/worksheets/", "/xl/drawings/drawing1.xml") == "xl/drawings/drawing1.xml"
