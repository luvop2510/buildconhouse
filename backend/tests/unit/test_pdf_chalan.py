"""Contract tests for the on-demand Sanitary Bathroom Chalan PDF."""
from __future__ import annotations

from io import BytesIO

from pypdf import PdfReader

from pdf_chalan import build_chalan_pdf, chalan_pdf_filename


LONG_ADDRESS = (
    "402, Shreeji Trade Centre, Opposite the old municipal water works, "
    "Kalawad Road, near the university main gate"
)
LONG_PRODUCT_NAME = (
    "Wall-hung rimless ceramic water closet with concealed fixation kit, "
    "soft-close seat cover and extended projection"
)


def _chalan() -> dict:
    return {
        "number": "CH-1052",
        "created_at": "2026-07-22T10:00:00+00:00",
        "dispatched_at": "2026-08-04T15:45:00+00:00",
        "items": [
            {
                "po_item_id": "i1",
                "name": LONG_PRODUCT_NAME,
                "size": "540 x 360 x 350 mm",
                "qty": 2.5,
                "unit": "PCS",
            },
        ],
        "transport": "Shree Maruti Roadways - insured door delivery",
        "remarks": "Handle with care; call the customer before unloading.",
        "receiver_name": "Nileshbhai Pokiya",
        "sender_name": "Kajaria Dispatch Supervisor",
        "reference_number": "REF-9",
    }


def _po() -> dict:
    return {
        "number": "FPO-2026-0042",
        "customer_name": "Nileshbhai Pokiya",
        "supplier_name": "Kajaria Bathware",
        "brand_name": "Kerovit",
        "items": [
            {
                "id": "i1",
                "name": LONG_PRODUCT_NAME,
                "brand_name": "Kerovit",
                "size": "540 x 360 x 350 mm",
                "finish": "Gloss White",
                "unit_cost": 1234.5,
            },
        ],
    }


def _customer() -> dict:
    return {
        "name": "Nileshbhai Pokiya",
        "phone": "+91 98765 43210",
        "address": LONG_ADDRESS,
        "city": "Rajkot",
        "state": "Gujarat",
        "pincode": "360005",
    }


def _branding() -> dict:
    return {
        "footer_company_name": "Buildcon House Private Limited",
        "company_address": "150 Feet Ring Road, Rajkot, Gujarat 360005",
        "footer_email": "dispatch@buildconhouse.example",
        "footer_phone": "+91 99099 06652",
        "signature_name": "Aarav Kapoor",
        "signature_title": "Authorised Signatory",
    }


def _pdf_text(pdf_bytes: bytes) -> str:
    reader = PdfReader(BytesIO(pdf_bytes))
    return "\n".join(page.extract_text() or "" for page in reader.pages)


def _normalized(text: str) -> str:
    return " ".join(text.split())


def test_build_chalan_pdf_extracts_complete_contract_and_wraps_long_text():
    pdf_bytes = build_chalan_pdf(_chalan(), _po(), _customer(), _branding())
    text = _normalized(_pdf_text(pdf_bytes))

    assert isinstance(pdf_bytes, bytes)
    assert pdf_bytes.startswith(b"%PDF-")
    first_page = PdfReader(BytesIO(pdf_bytes)).pages[0]
    assert float(first_page.mediabox.width) > float(first_page.mediabox.height)
    for expected in (
        "CHALAN",
        "CHALAN NO.",
        "CH-1052",
        "ORDER NO.",
        "FPO-2026-0042",
        "DISPATCH DATE",
        "04-08-2026",
        "CUSTOMER",
        "Nileshbhai Pokiya",
        "ADDRESS",
        LONG_ADDRESS,
        "Rajkot, Gujarat, 360005",
        "PHONE",
        "+91 987-654-32-10",
        "BRAND",
        "Kerovit",
        "PRODUCT",
        LONG_PRODUCT_NAME,
        "SIZE",
        "540 x 360 x 350 mm",
        "FINISH",
        "Gloss White",
        "QTY",
        "2.5",
        "BOX / PIECES",
        "Piece",
        "RATE",
        "₹ 1,234.50",
        "1,234.50",
        "TOTAL",
        "₹ 3,086.25",
        "3,086.25",
        "TRANSPORT",
        "Shree Maruti Roadways - insured door delivery",
        "REMARKS",
        "Handle with care; call the customer before unloading.",
        "RECEIVER NAME / SIGNATURE",
        "SUPPLIER REPRESENTATIVE / SIGNATURE",
        "Kajaria Dispatch Supervisor",
        "Buildcon House Private Limited",
        "150 Feet Ring Road, Rajkot, Gujarat 360005",
        "dispatch@buildconhouse.example",
        "Aarav Kapoor, Authorised Signatory",
    ):
        assert expected in text


def test_build_chalan_pdf_handles_missing_optional_fields_with_safe_fallbacks():
    chalan = {
        "number": "CH-0001",
        "created_at": "2026-07-22T10:00:00+00:00",
        "items": [{"po_item_id": "missing", "name": "Basin", "qty": 1, "unit": "PCS"}],
    }
    po = {"number": "FPO-0001", "customer_name": "PO Customer"}

    pdf_bytes = build_chalan_pdf(chalan, po, {})
    text = _normalized(_pdf_text(pdf_bytes))

    assert pdf_bytes.startswith(b"%PDF-")
    assert "PO Customer" in text
    assert "22-07-2026" in text
    assert "Basin" in text
    assert "TRANSPORT" in text
    assert "REMARKS" in text
    assert "RECEIVER NAME / SIGNATURE" in text
    assert "SUPPLIER REPRESENTATIVE / SIGNATURE" in text
    assert "Buildcon House" in text
    assert "None" not in text


def test_build_chalan_pdf_does_not_present_partial_subtotal_as_grand_total():
    chalan = _chalan()
    chalan["items"] = [
        {"po_item_id": "priced", "name": "Priced Basin", "qty": 2, "unit": "PCS"},
        {"po_item_id": "missing-rate", "name": "Unpriced Tap", "qty": 1, "unit": "PCS"},
    ]
    po = _po()
    po["items"] = [
        {"id": "priced", "name": "Priced Basin", "unit_cost": 100},
        {"id": "missing-rate", "name": "Unpriced Tap"},
    ]

    text = _normalized(_pdf_text(build_chalan_pdf(chalan, po, _customer())))
    grand_total_text = text.split("GRAND TOTAL", 1)[1].split("TRANSPORT", 1)[0]

    assert "INCOMPLETE" in grand_total_text
    assert "200.00" not in grand_total_text


def test_chalan_pdf_filename_format():
    filename = chalan_pdf_filename(_chalan(), "Nileshbhai Pokiya")
    assert filename == "CH-1052 Nileshbhai Pokiya 22-07-2026.pdf"
