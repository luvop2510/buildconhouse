"""Reorganize the first-floor GROHE and HANSGROHE catalog taxonomy.

The business supplied the target labels in ``GROHE NAME.xlsx`` and
``HANSGROHE NAME.xlsx``.  Category documents are intentionally created per
brand here: the catalog's historic category records are shared between brands,
but the requested labels differ (for example, GROHE ``KITCHEN`` versus
HANSGROHE ``kitchen``).  A category's slug remains unique per floor, so the
brand prefix makes these display labels coexist safely.

The three GROHE SKU workbooks are the source of truth for the split of the
former ``Trigger & Tank`` group.  Products in other GROHE groups that are not
named by the supplied taxonomy are deliberately left unchanged rather than
being guessed into an unrelated category.
"""
from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4


FLOOR_ID = "first-floor"
GROHE_BRAND_ID = "94292e11-6b64-41b4-8151-f30d66c674ad"
HANSGROHE_BRAND_ID = "9b72519c-bfb4-4576-9e79-e85072ab4216"

GROHE_TARGETS = {
    "SHOWER": ("Showers", "Shower"),
    "RSH AǪUA TILE (2)": ("RSH Aqua Tile Shower",),
    "SINGLE LEVER": ("Single Lever",),
    "plate": ("Plate",),
    "THERMOSTAT": ("Thermostat", "Thermostats"),
    "SPOUT": ("Spout",),
    "b jet (2)": ("Body Jet",),
    "HAND SHOWER SET": ("Handshower",),
    "WALL MOUNTED": ("Wall Mounted",),
    "KITCHEN": ("Kitchen", "Kitchen Tap"),
    "BASIN MIXER SMALL": ("Short Body Basin Mixer",),
    "BASIN MIXER TALL": ("Tall Body Basin Mixer",),
    "BAU LINE": ("Bau Line",),
    "WC": ("Water Closets",),
    # Angle valves and urinal flush hardware have no separate requested label.
    "TRIGGER": ("Angle Valve",),
    "FLUSH TANKS": ("Concealed Cisterns", "Flush Plates", "Urinals"),
}

HANSGROHE_TARGETS = {
    "SHOWERS": ("Showers",),
    "SLD": ("Single Lever",),
    "THM": ("Thermostat",),
    "handshower": ("Hand Showers",),
    "Showerhose": ("Shower Hose",),
    "Holder": ("Holder",),
    "rail": ("rail",),
    "Spout": ("Spouts",),
    "WBM": ("WBM",),
    "HFAV": ("HFAV",),
    "BM": ("BM",),
    "TBM": ("TBM",),
    "kitchen": ("Kitchen",),
    "3hole": ("Three Hole Mixers",),
    "Ceramic": ("Ceramic",),
}

# Article numbers from the three supplied GROHE workbooks.  Normalize both
# the source lists and stored SKU before comparison because legacy records use
# mixed casing and occasional whitespace around the ``+`` bundle separator.
TRIGGER_SKUS = {
    "2201600M", "2201700M", "27513GN1", "22041GN0", "27513GL1",
    "22041GL0", "27513AL1", "22041AL0", "27513A01", "22041A00",
    "27513DA1", "22041DA0", "1000212", "1000213", "27513DC1",
    "22041DC1", "27513001", "26354000", "26352000", "2201100M",
    "22940000", "1025302431", "22074KF0", "1023422430", "22013000",
}

FLUSH_TANKS_SKUS = {
    "38986000", "3853610I", "3916500I", "38505000", "38844000",
    "38765000+40911000", "38732000", "38732A00", "37624AL0",
    "37601AL0+40911000", "38732AL0", "38732GL0", "37624GN0",
    "37601GN0+40911000", "38732GN0", "38505KF0", "38844KF0",
    "38732KF0", "37601KF0+40911000", "38732DA0", "37624DL0",
    "37601DL0+40911000", "38732DL0",
}

KITCHEN_SKUS = {
    "31615000", "31613000", "31191001", "31593002", "32168000",
    "31375000", "30551000", "32918000", "30274000", "30270AL0",
    "30270A00", "32294002", "32661003", "30270000", "31358002",
    "31360001", "30219002", "32950000", "23958003", "2201600M",
    "2201700M",
}


def _normal_sku(value: object) -> str:
    return "".join(str(value or "").upper().split())


def _slug(brand: str, name: str) -> str:
    cleaned = "".join(char.lower() if char.isalnum() else "-" for char in name)
    return f"{brand}-{'-'.join(part for part in cleaned.split('-') if part)}"


async def _target_categories(db, *, brand: str, names: tuple[str, ...]) -> dict[str, str]:
    now = datetime.now(timezone.utc).isoformat()
    targets: dict[str, str] = {}
    for name in names:
        slug = _slug(brand, name)
        existing = await db.categories.find_one(
            {"floor_id": FLOOR_ID, "slug": slug}, {"_id": 0, "id": 1},
        )
        if existing:
            targets[name] = existing["id"]
            continue
        category_id = str(uuid4())
        await db.categories.insert_one({
            "id": category_id,
            "name": name,
            "slug": slug,
            "floor_id": FLOOR_ID,
            "parent_id": None,
            "icon": None,
            "created_at": now,
            "updated_at": now,
        })
        targets[name] = category_id
    return targets


async def _move_named_groups(db, *, brand_id: str, mappings: dict[str, tuple[str, ...]], targets: dict[str, str]) -> None:
    categories = [row async for row in db.categories.find(
        {"floor_id": FLOOR_ID, "name": {"$in": sorted({name for names in mappings.values() for name in names})}},
        {"_id": 0, "id": 1, "name": 1},
    )]
    ids_by_name = {row["name"]: row["id"] for row in categories}
    now = datetime.now(timezone.utc).isoformat()
    for target_name, source_names in mappings.items():
        source_ids = [ids_by_name[name] for name in source_names if name in ids_by_name]
        if source_ids:
            await db.products.update_many(
                {"brand_id": brand_id, "floor_id": FLOOR_ID, "category_id": {"$in": source_ids}},
                {"$set": {"category_id": targets[target_name], "updated_at": now}},
            )


async def _split_grohe_trigger_and_tanks(db, targets: dict[str, str]) -> None:
    """Move the old combined group using the supplied article-number lists."""
    combined = await db.categories.find_one(
        {"floor_id": FLOOR_ID, "name": "Trigger & Tank"}, {"_id": 0, "id": 1},
    )
    if not combined:
        return
    now = datetime.now(timezone.utc).isoformat()
    products = [row async for row in db.products.find(
        {"brand_id": GROHE_BRAND_ID, "floor_id": FLOOR_ID, "category_id": combined["id"]},
        {"_id": 0, "id": 1, "sku": 1},
    )]
    for product in products:
        sku = _normal_sku(product.get("sku"))
        # All remaining items in the former combined group are trigger-side
        # products; the supplied flush workbook explicitly identifies tank/
        # plate records and therefore takes precedence for a future overlap.
        target_id = targets["FLUSH TANKS"] if sku in FLUSH_TANKS_SKUS else targets["TRIGGER"]
        await db.products.update_one(
            {"id": product["id"], "brand_id": GROHE_BRAND_ID, "category_id": combined["id"]},
            {"$set": {"category_id": target_id, "updated_at": now}},
        )


async def _move_grohe_workbook_skus(db, targets: dict[str, str]) -> None:
    """Apply explicit workbook assignments that cross a legacy group boundary."""
    source_targets = {
        **{sku: "TRIGGER" for sku in TRIGGER_SKUS},
        **{sku: "FLUSH TANKS" for sku in FLUSH_TANKS_SKUS},
        # The kitchen workbook repeats two angle-valve article numbers.  Its
        # explicit kitchen placement wins when those future catalog records
        # are imported, while the currently stored trigger records keep their
        # own workbook identities.
        **{sku: "KITCHEN" for sku in KITCHEN_SKUS},
    }
    products = [row async for row in db.products.find(
        {"brand_id": GROHE_BRAND_ID, "floor_id": FLOOR_ID},
        {"_id": 0, "id": 1, "sku": 1},
    )]
    now = datetime.now(timezone.utc).isoformat()
    for product in products:
        target_name = source_targets.get(_normal_sku(product.get("sku")))
        if target_name:
            await db.products.update_one(
                {"id": product["id"], "brand_id": GROHE_BRAND_ID},
                {"$set": {"category_id": targets[target_name], "updated_at": now}},
            )


async def up(db) -> None:
    grohe_targets = await _target_categories(db, brand="grohe", names=tuple(GROHE_TARGETS))
    hansgrohe_targets = await _target_categories(db, brand="hansgrohe", names=tuple(HANSGROHE_TARGETS))

    await _move_named_groups(
        db, brand_id=GROHE_BRAND_ID, mappings=GROHE_TARGETS, targets=grohe_targets,
    )
    await _split_grohe_trigger_and_tanks(db, grohe_targets)
    await _move_grohe_workbook_skus(db, grohe_targets)
    await _move_named_groups(
        db, brand_id=HANSGROHE_BRAND_ID, mappings=HANSGROHE_TARGETS, targets=hansgrohe_targets,
    )
