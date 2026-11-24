from io import BytesIO

import fitz
from openpyxl import Workbook, load_workbook
from openpyxl.drawing.image import Image as WorkbookImage
from PIL import Image
import pytest

from catalog_pipeline.self_service_files import FLOORS, read_catalogue, write_template


def test_price_export_round_trips_articles_and_blank_new_mrp(tmp_path):
    path = tmp_path / "price.xlsx"
    path.write_bytes(write_template("first-floor", "prices", [
        {"sku": "000125A", "name": "Basin Mixer", "mrp": 11_350},
        {"sku": "=Literal-article", "name": "+Literal name", "mrp": 12_070},
    ]))
    book = load_workbook(path)
    sheet = book["Price Updates"]
    assert sheet["A2"].number_format == "@"
    assert sheet["A3"].data_type == sheet["B3"].data_type == "s"
    assert not sheet["D2"].value
    sheet["D2"] = "₹12,500"
    sheet.append([41, "Numeric supplier article", None, 125_000])
    sheet["A4"].number_format = "000000"
    sheet.append(["FORMULA", "Calculated", 12.0, "=C5+12"])
    sheet.append(["LARGE", "Bad numeric", 12.0, "-1,200"])
    sheet.append(["UNCERTAIN", "Blank price without reference", None, None])
    book.active = book["Instructions"]
    book.save(path)
    book.close()

    source = read_catalogue(path, floor_id="first-floor", operation="prices")
    assert source.rows[:3] == [
        {"row": 2, "sheet": "Price Updates", "sku": "000125A", "fields": {"current_mrp": 11_350, "new_mrp": 12_500}, "errors": [], "image_hashes": []},
        {"row": 3, "sheet": "Price Updates", "sku": "=Literal-article", "fields": {"current_mrp": 12_070}, "errors": [], "image_hashes": []},
        {"row": 4, "sheet": "Price Updates", "sku": "000041", "fields": {"new_mrp": 125_000}, "errors": [], "image_hashes": []},
    ]
    assert "formula" in source.rows[3]["errors"][0]
    assert "non-negative" in source.rows[4]["errors"][0]
    assert source.rows[5]["fields"] == {} and source.rows[5]["errors"] == []
    assert not source.images


def test_csv_price_only_validates_department_and_never_maps_offer(tmp_path):
    path = tmp_path / "source.csv"
    path.write_text(
        "Article No.,Brand,Department,MRP,Offer Price,Other Vendor Notes\n"
        '000140,Biana,Sanitary,"₹1,25,000",1,sales notes\n'
        "000150,Other,Kitchen,125,100,other note\n",
        encoding="utf-8-sig",
    )
    source = read_catalogue(path, floor_id="first-floor", operation="prices", brand="BIANA")
    good, bad = source.rows
    assert good["sku"] == "000140"
    assert good["fields"] == {"new_mrp": 125_000}
    assert not good["errors"]
    assert bad["row"] == 3
    assert bad["errors"] == [
        "Brand: Does not match the selected brand.",
        "Department: Does not match the selected department.",
    ]


def test_xlsx_deduplicates_embedded_images_and_ignores_other_sheets(tmp_path):
    path = tmp_path / "embedded.xlsx"
    book = Workbook()
    selected = book.active
    selected.title = "Import"
    selected.append(["Article No.", "Product Name", "Category", "MRP", "Product Image", "Dimension Diagram"])
    selected.append(["001A", "Mixer", "Mixer", 400])
    selected.append([None])
    selected.append(["002A", "Shower", "Shower", 500])
    book.create_sheet("Ignored").append(["Unsupported worksheet"])
    photo = _png("blue")
    selected.add_image(WorkbookImage(BytesIO(photo)), "E2")
    selected.add_image(WorkbookImage(BytesIO(photo)), "E4")
    selected.add_image(WorkbookImage(BytesIO(_png("red"))), "F2")
    book.save(path)

    result = read_catalogue(path, floor_id="first-floor", operation="add", sheet="Import")
    first, second = result.rows
    assert (first["row"], second["row"]) == (2, 4)
    assert not first["errors"] and not second["errors"]
    assert len(result.images) == 2
    assert first["image_hashes"][0] == second["image_hashes"][0]
    assert first["image_roles"] == {first["image_hashes"][1]: "dimension"}
    assert result.images[second["image_hashes"][0]].mime == "image/png"


def _png(colour):
    result = BytesIO()
    Image.new("RGB", (320, 320), colour).save(result, "PNG")
    return result.getvalue()


def test_tiles_use_effective_department_specs_and_validate_measurements(tmp_path):
    path = tmp_path / "tiles.csv"
    path.write_text(
        "Article No.,Product Name,Category,MRP,Size,Price Unit,Pieces per Box,Square Feet per Box,Rate per Square Foot\n"
        "009A,White,Porcelain,425,600x600,Per Sqft,4,15.5,400\n"
        "012B,Black,Porcelain,475,600x600,Sqft,0,,\n"
    )
    result = read_catalogue(path, floor_id="ground-floor", operation="add")
    assert result.rows[0]["fields"] == {
        "name": "White", "category": "Porcelain", "mrp": 425, "size": "600x600",
        "specs": {"price_unit": "sqft", "pcs_per_box": "4", "sqft_per_box": 15.5, "rate_per_sqft": 400},
    }
    assert not result.rows[0]["errors"]
    assert "Pieces per Box: Enter a positive whole number." in result.rows[1]["errors"]
    assert "Square Feet per Box is required" in " ".join(result.rows[1]["errors"])
    other = read_catalogue(path, floor_id="third-floor", operation="add")
    assert "This field is available on the Tiles template only" in " ".join(other.rows[0]["errors"])
    for floor in FLOORS:
        workbook = load_workbook(BytesIO(write_template(floor, "add")))
        tile_header = any(cell.value == "Price Unit" for cell in workbook["Products"][1])
        assert tile_header == (floor == "ground-floor")
        workbook.close()


def test_pdf_printed_and_physical_ranges_are_distinct(tmp_path):
    path = tmp_path / "supplier.pdf"
    with fitz.open() as document:
        for index, sku in enumerate(("001", "002", "003")):
            page = document.new_page()
            page.insert_text((80, 80), f"Article No. MRP\n{sku} {9_000 + index}")
        document.set_page_labels([{"startpage": 0, "style": "D", "firstpagenum": 404}])
        document.save(path)
    selected = read_catalogue(path, floor_id="first-floor", operation="prices", printed_pages=(405, 405))
    assert [(row["row"], row["sku"], row["fields"]["new_mrp"]) for row in selected.rows] == [(2, "002", 9001)]
    first = read_catalogue(path, floor_id="first-floor", operation="prices", physical_pages=(1, 1))
    assert first.rows[0]["sku"] == "001"
    with pytest.raises(ValueError, match="mapped uniquely"):
        read_catalogue(path, floor_id="first-floor", operation="prices", printed_pages=(1, 1))
    with pytest.raises(ValueError, match="either physical or printed"):
        read_catalogue(path, floor_id="first-floor", operation="prices", physical_pages=(1, 1), printed_pages=(404, 404))


def test_pdf_printed_footer_requires_unique_evidence(tmp_path):
    path = tmp_path / "printed.pdf"
    with fitz.open() as document:
        for footer in (405, 405, 406):
            page = document.new_page()
            page.insert_text((80, 80), "Article No. MRP\n00A 295")
            page.insert_text((80, page.rect.height - 30), str(footer))
        document.save(path)
    selected = read_catalogue(path, floor_id="first-floor", operation="prices", printed_pages=(406, 406))
    assert selected.rows[0]["row"] == 3
    with pytest.raises(ValueError, match="mapped uniquely"):
        read_catalogue(path, floor_id="first-floor", operation="prices", printed_pages=(405, 405))
