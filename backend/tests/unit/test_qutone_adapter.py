import io

from openpyxl import Workbook
from openpyxl.drawing.image import Image as XLImage
from PIL import Image as PILImage

from catalog_pipeline.adapters.qutone import normalize_finish, parse_rate_per_sqft, sku_for, family_key_for, QutoneAdapter
from catalog_pipeline.base import MISSING


def test_normalize_finish_covers_observed_supplier_values():
    cases = {
        "MATT": "Matt", "GLOSSY": "Glossy", "CHIFFON": "Chiffon",
        "DOVE": "Dove", "SILK": "Silk", "STRUCTURE-MATT": "Structure Matt", "NOVA": "Nova",
        "matt": "Matt",  # case-insensitive
        " GLOSSY ": "Glossy",  # whitespace-tolerant
    }
    for raw, expected_label in cases.items():
        label, code, note = normalize_finish(raw)
        assert label == expected_label, f"{raw!r} -> {label!r}, expected {expected_label!r}"
        assert code and code.isupper()
        assert note is None


def test_normalize_finish_flags_unrecognized_values_for_manual_review():
    label, code, note = normalize_finish("SOME NEW FINISH NOBODY HAS SEEN")
    assert label is None
    assert code is None
    assert note and "manual review" in note.lower()


def test_parse_rate_per_sqft_handles_the_real_source_format():
    assert parse_rate_per_sqft("225 PER SQFT") == (225.0, None)
    assert parse_rate_per_sqft("160 per sqft") == (160.0, None)
    assert parse_rate_per_sqft("1,250 PER SQFT") == (1250.0, None)


def test_parse_rate_per_sqft_flags_unrecognized_formats_without_crashing():
    value, note = parse_rate_per_sqft("TBD")
    assert value is None
    assert note and "RATE" in note


def test_sku_and_family_key_are_deterministic_across_calls():
    sku1 = sku_for("IMARBLE 2.0", "PANAMA DOVE", "1200X2400", "MT")
    sku2 = sku_for("IMARBLE 2.0", "PANAMA DOVE", "1200X2400", "MT")
    assert sku1 == sku2 == "QUTONE-IMARBLE20-PANAMADOVE-1200X2400-MT"

    fk1 = family_key_for("IMARBLE 2.0", "PANAMA DOVE")
    fk2 = family_key_for("IMARBLE 2.0", "PANAMA DOVE")
    assert fk1 == fk2 == "qutone:imarble-2-0:panama-dove"


def test_sku_differs_by_size_and_finish_within_same_family():
    base = sku_for("IMARBLE 2.0", "PANAMA DOVE", "1200X2400", "MT")
    diff_finish = sku_for("IMARBLE 2.0", "PANAMA DOVE", "1200X2400", "GL")
    diff_size = sku_for("IMARBLE 2.0", "PANAMA DOVE", "1200X1800", "MT")
    assert len({base, diff_finish, diff_size}) == 3


def _build_workbook(*, with_image_on_row2: bool = True) -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.title = "Sheet1"
    ws.append(["SR.", "company NAME", "PRODUCT NAME", "IMAGE", "PRODUCT SIZE", "SERIES NAME", "FINISHES", "BOX IN PIS", "BOX SQFT", "RATE"])
    ws.append([1, "QUTONE", "PANAMA DOVE", None, "1200X2400", "IMARBLE 2.0", "MATT", 1, 31, "225 PER SQFT"])
    ws.append([2, "QUTONE", "PANAMA DOVE", None, "1200X2400", "IMARBLE 2.0", "GLOSSY", 1, 31, "225 PER SQFT"])
    ws.append([3, "QUTONE", "PANAMA DOVE", None, "1200X1800", "IMARBLE 2.0", "WEIRDFINISH", 2, 46.5, "160 PER SQFT"])
    ws.append([4, "QUTONE", "PANAMA SAINT", None, "1200X2400", "IMARBLE 2.0", "MATT", 1, 31, "not a rate"])

    if with_image_on_row2:
        buf = io.BytesIO()
        PILImage.new("RGB", (240, 360), color=(200, 100, 50)).save(buf, format="JPEG")
        buf.seek(0)
        img = XLImage(buf)
        img.anchor = "D2"
        ws.add_image(img)

    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


def test_extracts_all_rows_with_deterministic_sku():
    data = _build_workbook()
    rows, report = QutoneAdapter().extract(data, "QUTONE 2026.xlsx")
    assert report.parsed_rows == 4
    assert len(rows) == 4
    rows2, _ = QutoneAdapter().extract(data, "QUTONE 2026.xlsx")
    assert [r.sku for r in rows] == [r.sku for r in rows2]


def test_family_key_groups_same_product_and_series_across_finishes_and_sizes():
    data = _build_workbook()
    rows, _ = QutoneAdapter().extract(data, "QUTONE 2026.xlsx")
    dove_rows = [r for r in rows if r.name.startswith("PANAMA DOVE")]
    assert len(dove_rows) == 3
    assert len({r.family_key for r in dove_rows}) == 1
    assert {r.name for r in dove_rows} == {dove_rows[0].to_public()["family_name"]} == {"PANAMA DOVE"}
    saint = next(r for r in rows if r.name.startswith("PANAMA SAINT"))
    assert saint.family_key != dove_rows[0].family_key


def test_size_and_pricing_fields_map_correctly():
    data = _build_workbook()
    rows, _ = QutoneAdapter().extract(data, "QUTONE 2026.xlsx")
    r = rows[0]
    assert r.size == "1200X2400"
    assert r.mrp == 225.0
    assert r.dealer_price == 225.0
    assert r.specs["pcs_per_box"] == "1"
    assert r.specs["sqft_per_box"] == 31
    assert r.category == "Tiles"
    assert r.brand == "Qutone"


def test_unrecognized_finish_is_flagged_not_dropped():
    data = _build_workbook()
    rows, _ = QutoneAdapter().extract(data, "QUTONE 2026.xlsx")
    weird = next(r for r in rows if r.size == "1200X1800")
    assert weird.finish_code == MISSING
    assert any("needs manual review" in issue for issue in weird.issues)


def test_malformed_rate_is_flagged_and_priced_at_zero_not_dropped():
    data = _build_workbook()
    rows, _ = QutoneAdapter().extract(data, "QUTONE 2026.xlsx")
    saint = next(r for r in rows if r.name.startswith("PANAMA SAINT"))
    assert saint.mrp == 0.0
    assert any("RATE" in issue for issue in saint.issues)
    assert saint.specs.get("needs_pricing") is True


def test_row_without_embedded_image_is_flagged_missing():
    data = _build_workbook(with_image_on_row2=False)
    rows, report = QutoneAdapter().extract(data, "QUTONE 2026.xlsx")
    assert report.images_mapped == 0
    assert all(not r.images for r in rows)
    assert all(any("No image mapped" in issue for issue in r.issues) for r in rows)


def test_row_with_embedded_image_is_mapped_with_correct_dimensions():
    data = _build_workbook(with_image_on_row2=True)
    rows, report = QutoneAdapter().extract(data, "QUTONE 2026.xlsx")
    assert report.images_mapped == 1
    imaged = [r for r in rows if r.images]
    assert len(imaged) == 1
    assert imaged[0].image_meta[0]["width"] == 240
    assert imaged[0].image_meta[0]["height"] == 360


def test_qutone_is_registered_in_the_adapter_registry():
    from catalog_pipeline.adapters import get_adapter

    adapter = get_adapter("qutone")
    assert isinstance(adapter, QutoneAdapter)


def test_qutone_case_insensitive_lookup():
    from catalog_pipeline.adapters import get_adapter

    assert get_adapter("Qutone").brand == "Qutone"
    assert get_adapter("QUTONE").brand == "Qutone"
