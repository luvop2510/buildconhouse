"""Supplier source fidelity and stock-safe payload contracts; no database access."""
from collections import defaultdict
from copy import deepcopy
import json

import pytest

from models import Product
from scripts.reconcile_supplier_workbooks import (
    DEFAULT_MANIFEST, canonical_article, category_slug, entry_for,
    product_payload, validate_manifest,
)


@pytest.fixture
def source():
    return json.loads(DEFAULT_MANIFEST.read_text())


def row(**changes):
    value = {
        "occurrence_id": "hansgrohe:1:5", "brand": "Hansgrohe", "brand_order": 0,
        "workbook": "HANSGROHE MRP 2027-28.xlsx", "sheet": "SHOWERS",
        "category_exact": "SHOWERS", "sheet_order": 1, "row": 5,
        "source_order": 1, "serial_raw": 1, "article": "10628000",
        "article_raw": 10628000, "description_exact": "AX ShowerHeaven Chrome",
        "section_heading_exact": "HG & AXOR Showers ", "price": 1234.50,
        "price_raw": 1234.50, "source_status_note": None,
        "source_cells": {"C": {"value": "Supplier row note"}},
    }
    return {**value, **changes}


def categories_for(rows):
    return {(r["brand"], r["sheet"]): {"id": category_slug(r["brand"], r["sheet"])} for r in rows}


def test_real_manifest_has_every_placement_and_canonical_identity(source):
    rows = validate_manifest(source)
    assert len(rows) == 2255
    assert len({(r["brand"], canonical_article(r)) for r in rows}) == 2095
    assert len({(r["brand"], r["sheet"]) for r in rows}) == 30
    assert [r["brand"] for r in rows] == sorted([r["brand"] for r in rows], key=lambda name: {"Hansgrohe": 0, "Grohe": 1}[name])


@pytest.mark.parametrize("article,expected", [("1800187", "01800187"), ("1500180", "01500180"), ("1400180", "01400180")])
def test_leading_zero_aliases_match_existing_identity_but_retain_source_article(article, expected):
    original = row(article=article, article_raw=int(article))
    assert canonical_article(original) == expected
    assert entry_for(original, "category")["source_sku"] == article
    assert canonical_article({**original, "brand": "Grohe"}) == article


def test_explicit_canonical_identity_does_not_erase_raw_article():
    original = row(article="1800187", article_raw=1800187, canonical_article="01800187")
    payload = product_payload([original], categories_for([original]), {})
    assert payload["sku"] == "01800187"
    assert payload["catalog_entries"][0]["article_raw"] == 1800187
    assert payload["catalog_entries"][0]["source_sku"] == "1800187"


def test_category_identity_keeps_brand_and_exact_worksheet_name_distinct():
    labels = ["BASIN MIXER", "Basin Mixer", "Basin Mixer ", "Basin_Mixer", "Básin Mixer"]
    assert len({category_slug("Hansgrohe", label) for label in labels}) == len(labels)
    assert category_slug("Hansgrohe", "SHOWERS") != category_slug("Grohe", "SHOWERS")


def test_repeated_sku_keeps_all_source_categories_prices_and_positions():
    rows = [row(price=None, price_raw=None), row(occurrence_id="hansgrohe:2:9", sheet="SPECIAL ",
            category_exact="SPECIAL ", sheet_order=2, row=9, source_order=2,
            description_exact=" Different supplier description ", price=9876.25, price_raw=9876.25)]
    payload = product_payload(rows, categories_for(rows), {})
    assert payload["mrp"] == 9876.25
    assert payload["price_status"] == "known"
    assert [entry["entry_id"] for entry in payload["catalog_entries"]] == [r["occurrence_id"] for r in rows]
    assert [entry["category_name"] for entry in payload["catalog_entries"]] == ["SHOWERS", "SPECIAL "]
    assert [entry["mrp"] for entry in payload["catalog_entries"]] == [None, 9876.25]
    assert payload["catalog_entries"][1]["name"] == " Different supplier description "


def test_source_zero_price_is_known_and_takes_precedence_over_later_occurrence():
    rows = [row(price=0), row(occurrence_id="hansgrohe:1:6", source_order=2, price=400)]
    payload = product_payload(rows, categories_for(rows), {"mrp": 900, "price": 700})
    assert payload["mrp"] == payload["price"] == 0
    assert payload["price_status"] == "known"


def test_update_payload_preserves_stock_id_media_and_unrelated_existing_fields():
    original = row()
    old = {"id": "existing-id", "stock": 19, "images": ["existing-photo"],
           "concealed_part": {"sku": "12345678"}, "dimensions": "1200 mm",
           "specs": {"supplier_custom_attribute": "keep"}, "mrp": 800, "price": 700}
    before = deepcopy(old)
    payload = product_payload([original], categories_for([original]), old)
    assert old == before
    assert not ({"id", "stock", "images", "image_meta", "concealed_part", "dimensions", "created_at"} & payload.keys())
    assert payload["specs"]["supplier_custom_attribute"] == "keep"


def test_missing_source_price_keeps_existing_price_only_on_canonical_record():
    original = row(price=None, price_raw=None)
    payload = product_payload([original], categories_for([original]), {"mrp": 800, "price": 700})
    assert (payload["mrp"], payload["price"], payload["price_status"]) == (800, 700, "existing")
    assert payload["catalog_entries"][0]["mrp"] is None
    assert payload["catalog_entries"][0]["price_status"] == "unspecified"


def test_new_item_missing_description_and_price_is_still_represented():
    original = row(description_exact=None, price=None, price_raw=None)
    payload = product_payload([original], categories_for([original]), {})
    assert payload["name"] == "Article 10628000"
    assert payload["active"] is True
    assert payload["price_status"] == "unspecified"
    assert payload["catalog_entries"][0]["name"] is None
    assert payload["specs"]["source_description_unspecified"] is True


def test_source_family_and_raw_notes_are_retained_in_search():
    original = row(variant_family_candidate="hansgrohe:12345", source_status_note="Supplier discontinued")
    payload = product_payload([original], categories_for([original]), {"family_key": "old-family"})
    assert payload["family_key"] == "hansgrohe:12345"
    assert "Supplier row note" in payload["catalog_search_text"]
    assert payload["catalog_entries"][0]["source_status_note"] == "Supplier discontinued"


@pytest.mark.parametrize("stem", ["27572", "22009", "19571", "19506", "32468", "13255"])
def test_distinct_grohe_model_revisions_do_not_become_color_alternatives(source, stem):
    rows = [r for r in source["ordered_occurrences"] if r["brand"] == "Grohe" and r["article"].startswith(stem)]
    assert len({canonical_article(r) for r in rows}) > 1
    categories = categories_for(rows)
    families = {}
    for original in rows:
        payload = product_payload([original], categories, {})
        families[canonical_article(original)] = payload["family_key"]
    assert len(set(families.values())) == len(families)


def test_true_ten_character_grohe_finish_family_remains_linked(source):
    rows = [r for r in source["ordered_occurrences"] if r.get("variant_family_candidate") == "grohe:106866"]
    assert len({canonical_article(r) for r in rows}) == 6
    categories = categories_for(rows)
    families = {product_payload([original], categories, {})["family_key"] for original in rows}
    assert families == {"grohe:106866"}


def test_product_model_roundtrip_preserves_every_manifest_entry_before_insert(source):
    """Exercise the same typed serialization used only for new database records.

    Losing even a None-valued source field aborts the transaction's equality
    check; nonempty source notes must also survive new-product insertion.
    """
    grouped = defaultdict(list)
    for original in source["ordered_occurrences"]:
        grouped[(original["brand"], canonical_article(original))].append(original)
    categories = categories_for(source["ordered_occurrences"])
    for rows in grouped.values():
        payload = product_payload(rows, categories, {})
        stored = Product(floor_id="first-floor", brand_id="brand-id", **payload).model_dump()
        assert stored["catalog_entries"] == payload["catalog_entries"], rows[0]["occurrence_id"]
        assert stored["catalog_search_text"] == payload["catalog_search_text"]


@pytest.mark.parametrize("change", ["duplicate_occurrence", "out_of_order", "negative_price", "empty_article"])
def test_manifest_rejects_inputs_that_would_omit_or_misorder_a_supplier_item(change):
    rows = [row(), row(occurrence_id="hansgrohe:1:6", source_order=2)]
    if change == "duplicate_occurrence":
        rows[1]["occurrence_id"] = rows[0]["occurrence_id"]
    elif change == "out_of_order":
        rows.reverse()
    elif change == "negative_price":
        rows[0]["price"] = -1
    else:
        rows[0]["article"] = ""
    with pytest.raises(ValueError):
        validate_manifest({"ordered_occurrences": rows})
