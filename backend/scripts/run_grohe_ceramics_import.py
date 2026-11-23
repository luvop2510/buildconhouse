"""Preview, apply or verify GROHE ceramics on the Sanitary floor."""

from __future__ import annotations

import argparse
import asyncio
from collections import Counter
import hashlib
import json
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

from catalog_pipeline.grohe_ceramics import extract_images, load_manifest
from models import CatalogEntry, CatalogImportJob, Category, Product, ProductMedia, now_iso

FLOOR = "first-floor"
ACTOR = "system:grohe-ceramics-2026-import"
ASSET_SCOPE = "ceramics-2026"
PDF_MIME = "application/pdf"


def import_id(brand_id, identity):
    return str(uuid5(NAMESPACE_URL, f"buildcon/{FLOOR}/{brand_id}/{ASSET_SCOPE}/{identity}"))


def find_category(categories, brand_id, name):
    matches = [row for row in categories if row["name"].strip().casefold() == name.casefold()]
    for candidates in (
        [row for row in matches if row.get("brand_id") == brand_id],
        [row for row in matches if not row.get("brand_id") and row.get("slug") == f"grohe-{name.lower()}"],
        [row for row in matches if not row.get("brand_id")],
    ):
        if len(candidates) > 1:
            raise ValueError(f"Multiple Sanitary {name} categories match GROHE.")
        if candidates:
            return candidates[0]
    return None


async def scope(database, rows, *, session=None):
    brands = await database.brands.find(
        {"floor_id": FLOOR, "name": {"$regex": r"^\s*grohe\s*$", "$options": "i"}},
        {"_id": 0}, session=session,
    ).to_list(2)
    if len(brands) != 1:
        raise ValueError("Expected exactly one existing GROHE brand on the Sanitary floor.")
    brand = brands[0]
    if brand.get("catalog_authoritative") and not brand.get("catalog_source"):
        raise ValueError("The authoritative GROHE brand is missing its catalogue source identity.")
    namespace = {"floor_id": FLOOR, "brand_id": brand["id"]}
    categories = await database.categories.find({"floor_id": FLOOR}, {"_id": 0}, session=session).to_list()
    categories = {name: find_category(categories, brand["id"], name) for name in ("WC", "Basin", "Accessories")}
    if not categories["WC"]:
        raise ValueError("The existing Sanitary GROHE WC category is required.")
    add_basin = categories["Basin"] is None
    if add_basin:
        categories["Basin"] = Category(
            id=import_id(brand["id"], "category:Basin"), name="Basin", slug="grohe-basin", **namespace,
        ).model_dump()

    articles = {row["sku"] for row in rows}
    existing = {}
    async for product in database.products.find(namespace, {"_id": 0}, session=session):
        sku = str(product.get("sku", "")).strip().upper()
        if sku in articles:
            if sku in existing:
                raise ValueError(f"Multiple existing products match article {sku}.")
            existing[sku] = product
    return brand, categories, namespace, existing, add_basin


def category_for(row, categories):
    category = categories[row["category"]]
    if category:
        return category
    # Use the parent product category when the floor has no Accessories category.
    return categories["Basin" if row["product_type"] == "Basin Waste" else "WC"]


def product_fields(row, previous, category, brand, source_name):
    description = "\n".join((row["name"], *row.get("notes", [])))
    old_price = previous.get("price")
    preserve_dealer_price = old_price is not None and old_price != previous.get("mrp")
    specs = {**(previous.get("specs") or {}), "source_catalog": source_name,
             "source_page": row["pdf_page"], "printed_source_page": row["printed_page"],
             "source_article": row["article_label"]}
    if row.get("availability"):
        specs["availability"] = row["availability"]
    if row.get("notes"):
        specs["catalogue_notes"] = "\n".join(row["notes"])
    placements = [
        {**entry, "category_id": category["id"], "category_name": category["name"],
         "subcategory": row["product_type"], "name": row["name"], "description": description,
         "mrp": row["mrp"], "price_status": "known",
         **({"source_status_note": row["availability"]} if row.get("availability") else {})}
        for entry in previous.get("catalog_entries") or []
    ] or [CatalogEntry(
        entry_id=f"grohe:ceramics-2026:{row['sku']}", source_catalog=source_name,
        sheet_name=f"Printed page {row['printed_page']}", sheet_order=row["printed_page"],
        row_number=row["source_order"], source_order=row["source_order"],
        category_id=category["id"], category_name=category["name"], subcategory=row["product_type"],
        name=row["name"], description=description, source_sku=row["sku"],
        article_raw=row["article_label"], price_raw=row["mrp"], mrp=row["mrp"],
        price_status="known", source_status_note=row.get("availability"),
    ).model_dump()]
    fields = {
        "name": row["name"], "sku": row["sku"], "description": description,
        "category_id": category["id"], "subcategory": row["product_type"], "series": row["series"],
        "family_key": previous.get("family_key") or f"grohe:ceramics:{row['sku'].lower()}",
        "family_name": previous.get("family_name") or row["name"],
        "mrp": row["mrp"], "price": old_price if preserve_dealer_price else row["mrp"],
        "catalog_mrp_override": preserve_dealer_price or bool(previous.get("catalog_mrp_override")),
        "price_status": "known", "active": True, "catalog_entries": placements, "specs": specs,
        "catalog_source": (brand["catalog_source"] if brand.get("catalog_authoritative")
                           else previous.get("catalog_source") or source_name),
    }
    if row["finish"]:
        fields.update(finish=row["finish"], colour=row["colour"])
        if previous.get("variant_label") in (None, "", previous.get("finish")):
            fields["variant_label"] = row["finish"]
    if row["dimensions"]:
        fields.update(dimensions=row["dimensions"], size=row["dimensions"])
    return fields


def set_relationships(row, item, planned):
    previous, fields = item["previous"], item["fields"]
    specs = fields["specs"]
    cover_sku = row.get("seat_cover_sku")
    accessory_skus = [*row.get("must_buy_skus", []), *row.get("compatible_accessory_skus", [])]
    if row.get("must_buy_skus"):
        specs["must_buy_accessory_skus"] = row["must_buy_skus"]
    if cover_sku or row.get("seat_cover_included"):
        specs.pop("grohe_seat_cover_sku", None)
        defaults = [part for part in specs.get("default_included_parts") or [] if part.get("role") != "seat_cover"]
        if cover_sku:
            accessory_skus.append(cover_sku)
            specs["grohe_seat_cover_sku"] = cover_sku
            cover = planned[cover_sku]
            seat = cover["fields"]
            defaults.append({
                "role": "seat_cover", "sku": cover_sku, "product_id": cover["id"], "name": seat["name"],
                "unit_price": seat["price"], "mrp": seat["mrp"], "qty": 1, "description": seat["description"],
                "image": cover["media"]["public_url"], "finish": seat.get("finish"),
                "category_id": seat["category_id"],
            })
        if defaults or "default_included_parts" in specs:
            specs["default_included_parts"] = defaults

    compatible_skus = [*accessory_skus, *row.get("compatible_basin_skus", [])]
    for field, skus in (("accessory_ids", accessory_skus), ("compatible_ids", compatible_skus)):
        if skus:
            fields[field] = list(dict.fromkeys([
                *(previous.get(field) or []), *(planned[sku]["id"] for sku in skus),
            ]))


async def plan_import(database, storage, bucket, manifest, assets, *, session=None):
    from services.media_quality import quality_from_dimensions
    from services.media_service import make_storage_key

    rows = [dict(row, source_order=i) for i, row in enumerate(manifest["products"], 1)]
    brand, categories, namespace, existing, add_basin = await scope(database, rows, session=session)
    planned = {}
    for row in rows:
        previous = existing.get(row["sku"], {})
        product_id = previous.get("id") or import_id(brand["id"], f"product:{row['sku']}")
        fields = product_fields(row, previous, category_for(row, categories), brand, manifest["source"])
        image, mime = assets[row["image_xref"]]
        digest = hashlib.sha1(image).hexdigest()
        fields["specs"]["grohe_ceramics_image_sha1"] = digest
        key = make_storage_key(
            brand_slug=brand["slug"], family_key=ASSET_SCOPE, product_id=None, source_type="supplier",
            role="hero", sha1=digest, mime=mime,
        )
        width, height = row["image_size"]
        media = {
            "id": import_id(brand["id"], f"media:{product_id}:{digest}"), **namespace,
            "product_id": product_id, "family_key": fields["family_key"], "source_type": "supplier",
            "role": "hero", "bucket": bucket, "storage_key": key,
            "public_url": storage.get_public_url(bucket=bucket, key=key),
            "width": width, "height": height, "quality": quality_from_dimensions(width, height, mime),
            "sha1": digest, "mime": mime, "size_bytes": len(image), "is_primary": True, "sort_order": -1,
            "uploaded_by": ACTOR, "notes": f"{manifest['source']} printed page {row['printed_page']} · {row['sku']}",
        }
        planned[row["sku"]] = {"id": product_id, "previous": previous, "fields": fields, "media": media}
    existing_media = {}
    async for media in database.product_media.find(
        {**namespace, "product_id": {"$in": [item["id"] for item in planned.values()]}, "source_type": "supplier"},
        {"_id": 0}, session=session,
    ):
        existing_media.setdefault(media["product_id"], []).append(media)
    for row in rows:
        item = planned[row["sku"]]
        set_relationships(row, item, planned)
        item["previous_media"] = existing_media.get(item["id"], [])
        item["media_changed"] = (
            not any(all(image.get(key) == value for key, value in item["media"].items())
                    for image in item["previous_media"])
            or any(image.get("is_primary") and image["id"] != item["media"]["id"]
                   for image in item["previous_media"])
        )
        item["change"] = (
            "added" if not item["previous"] else
            "updated" if (item["media_changed"] or any(
                item["previous"].get(key) != value for key, value in item["fields"].items()
            )) else "unchanged"
        )
    return brand, categories, namespace, planned, add_basin


def report(manifest, plan):
    brand, categories, _, planned, add_basin = plan
    changes = Counter(item["change"] for item in planned.values())
    return {
        "floor": FLOOR, "brand_id": brand["id"], "basin_category_id": categories["Basin"]["id"],
        "create_basin_category": add_basin, "printed_pages": manifest["printed_page_range"],
        "priced_listings": manifest["priced_listing_count"], "articles": len(planned),
        "products_by_type": dict(Counter(row["category"] for row in manifest["products"])),
        "products_added": changes["added"], "products_updated": changes["updated"],
        "unchanged": changes["unchanged"], "wc_pairings": sum(bool(row.get("seat_cover_sku")) for row in manifest["products"]),
        "coming_soon": [row["sku"] for row in manifest["products"] if row.get("availability")],
        "exact_pdf_images": len(planned),
        "unique_pdf_images": len({item["media"]["sha1"] for item in planned.values()}),
    }


async def save_plan(database, manifest, plan, source_meta, session):
    from pymongo import InsertOne, UpdateMany, UpdateOne

    brand, categories, namespace, planned, add_basin = plan
    if add_basin:
        await database.categories.insert_one(categories["Basin"], session=session)
    changed = [item for item in planned.values() if item["change"] != "unchanged"]
    if not changed:
        return None
    job = CatalogImportJob(
        filename=manifest["source"], source_type="pdf", supplier_name=brand["name"], floor_id=FLOOR,
        total_rows=len(planned), accepted_rows=len(changed), created_by=ACTOR, status="imported", **source_meta,
    ).model_dump()
    stamp = now_iso()
    product_writes, media_writes, snapshots = [], [], []
    updates_expected = 0
    for item in changed:
        previous, fields = item["previous"], item["fields"]
        version = int(previous.get("catalog_version") or 0) + 1
        updates = {**fields, "updated_at": stamp, "catalog_version": version, "catalog_import_id": job["id"],
                   "catalog_updated_by": ACTOR}
        if not previous or any(previous.get(key) != fields[key] for key in ("price", "mrp")):
            updates["catalog_price_updated_at"] = stamp
        if previous:
            product_writes.append(UpdateOne({**namespace, "id": item["id"]}, {"$set": updates}))
            updates_expected += 1
        else:
            product = Product(id=item["id"], **namespace, **fields).model_dump()
            product_writes.append(InsertOne({**product, **updates}))
        if item["media_changed"]:
            media = item["media"]
            media_writes.append(UpdateMany(
                {**namespace, "product_id": item["id"], "source_type": "supplier",
                 "id": {"$ne": media["id"]}, "is_primary": True},
                {"$set": {"is_primary": False}},
            ))
            persisted = ProductMedia(**media, updated_at=stamp).model_dump()
            created_at = persisted.pop("created_at")
            media_writes.append(UpdateOne(
                {**namespace, "product_id": item["id"], "id": media["id"]},
                {"$set": persisted, "$setOnInsert": {"created_at": created_at}}, upsert=True,
            ))
        snapshots.append({
            **namespace, "job_id": job["id"], "product_id": item["id"], "was_new": not previous,
            "previous": previous or None, "previous_media": item["previous_media"],
            "catalog_version": version, "actor_id": ACTOR, "created_at": stamp,
        })
        job["rows"].append({"row_id": fields["sku"], "sku": fields["sku"], "status": "accepted",
                            "product_id": item["id"], "change_type": item["change"], "import_state": "succeeded"})
    result = await database.products.bulk_write(product_writes, ordered=False, session=session)
    if result.matched_count != updates_expected:
        raise ValueError("An existing reviewed GROHE product changed during publication.")
    if media_writes:
        await database.product_media.bulk_write(media_writes, session=session)
    await database.catalog_import_snapshots.insert_many(snapshots, session=session)
    await database.catalog_imports.insert_one(job, session=session)
    return job["id"]


async def ensure_asset(storage, *, bucket, key, data, mime):
    from media_storage.base import StorageObjectExists

    if not await storage.exists(bucket=bucket, key=key):
        try:
            headers = {"cache_control": "private, no-store"} if mime == PDF_MIME else {}
            await storage.upload(bucket=bucket, key=key, data=data, content_type=mime, upsert=False, **headers)
        except StorageObjectExists:
            pass
    if await storage.download(bucket=bucket, key=key) != data:
        raise ValueError(f"Persistent GROHE image or source bytes differ at {key}.")


async def verify_public_images(plan):
    import httpx

    expected = {item["media"]["public_url"]: item["media"]["sha1"] for item in plan[3].values()}
    async with httpx.AsyncClient(timeout=20, follow_redirects=True, limits=httpx.Limits(max_connections=8)) as web:
        async def check(url, digest):
            response = await web.get(url)
            response.raise_for_status()
            if hashlib.sha1(response.content).hexdigest() != digest:
                raise ValueError("A public GROHE catalogue image differs from its embedded source.")
        await asyncio.gather(*(check(url, digest) for url, digest in expected.items()))
    return len(expected)


async def apply_import(database, storage, bucket, private, manifest, assets, source, initial, *, verify_public=True):
    from pymongo.read_concern import ReadConcern
    from pymongo.write_concern import WriteConcern
    from services.mutation_admission import admission, finish_on_cancel

    for collection, fields in ((database.categories, {"floor_id", "slug"}),
                               (database.products, {"floor_id", "brand_id", "sku"})):
        indexes = await collection.index_information()
        if not any(index.get("unique") and set(dict(index["key"])) == fields for index in indexes.values()):
            raise ValueError(f"Expected the existing unique catalogue scope index on {collection.name}.")
    source_hash = manifest["pdf_sha256"]
    source_key = f"catalog-imports/grohe/{source_hash[:2]}/{source_hash}/source.pdf"
    await storage.require_private_bucket(private)
    await ensure_asset(storage, bucket=private, key=source_key, data=source, mime=PDF_MIME)
    media_by_sku = {sku: item["media"] for sku, item in initial[3].items()}
    files = {media_by_sku[row["sku"]]["storage_key"]: assets[row["image_xref"]]
             for row in manifest["products"]}
    limit = asyncio.Semaphore(8)

    async def stage(key, image, mime):
        async with limit:
            await ensure_asset(storage, bucket=bucket, key=key, data=image, mime=mime)

    staged = await asyncio.gather(*(stage(key, *asset) for key, asset in files.items()), return_exceptions=True)
    for result in staged:
        if isinstance(result, BaseException):
            raise result
    if verify_public:
        await verify_public_images(initial)
    source_meta = {"source_bucket": private, "source_storage_key": source_key,
                   "source_sha256": source_hash, "source_size_bytes": len(source)}

    async def commit(session):
        current = await plan_import(database, storage, bucket, manifest, assets, session=session)
        # Ignore generated category timestamps when comparing the same planned creation.
        if (current[0]["id"] != initial[0]["id"] or current[3:] != initial[3:]
                or {key: (value or {}).get("id") for key, value in current[1].items()}
                != {key: (value or {}).get("id") for key, value in initial[1].items()}):
            raise ValueError("The GROHE catalogue changed during staging. Preview and retry the import.")
        return await save_plan(database, manifest, current, source_meta, session)

    async def transaction():
        async with await database.client.start_session() as session:
            return await session.with_transaction(
                commit, read_concern=ReadConcern("snapshot"), write_concern=WriteConcern("majority"),
            )

    if all(item["change"] == "unchanged" for item in initial[3].values()) and not initial[4]:
        return None
    async with admission(database, exclusive=True, operation=ACTOR):
        return await finish_on_cancel(transaction())


async def run(args, source, manifest, assets):
    if args.env_file:
        from dotenv import load_dotenv
        load_dotenv(args.env_file)
    from db import client, db
    from media_storage.factory import get_media_storage, private_bucket, public_bucket

    if db.name != args.database:
        raise ValueError("The configured database differs from the explicitly selected target database.")
    storage = get_media_storage()
    try:
        plan = await plan_import(db, storage, public_bucket(), manifest, assets)
        evidence = {"database": db.name, "source_sha256": manifest["pdf_sha256"], **report(manifest, plan)}
        if args.apply:
            job_id = await apply_import(db, storage, public_bucket(), private_bucket(), manifest, assets, source, plan)
            evidence.update(job_id=job_id)
        if args.apply or args.verify:
            saved = await plan_import(db, storage, public_bucket(), manifest, assets)
            if saved[4] or any(item["change"] != "unchanged" for item in saved[3].values()):
                raise ValueError("The stored GROHE catalogue does not match the reviewed products or media.")
            evidence.update(public_image_urls_verified=(len({item["media"]["public_url"] for item in saved[3].values()})
                                                         if args.apply else await verify_public_images(saved)))
        print(json.dumps(evidence, indent=2))
    finally:
        await storage.close()
        client.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--env-file", type=Path)
    parser.add_argument("--database")
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--apply", action="store_true")
    action.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    if (args.apply or args.verify) and not args.database:
        parser.error("--apply and --verify require the expected --database")
    manifest = load_manifest()
    source = args.source.read_bytes()
    assets = extract_images(source, manifest)
    if args.database:
        asyncio.run(run(args, source, manifest, assets))
    else:
        print(json.dumps({
            "source_sha256": manifest["pdf_sha256"], "articles": len(manifest["products"]),
            "priced_listings": manifest["priced_listing_count"], "distinct_original_images": len(assets),
            "products_by_type": Counter(row["category"] for row in manifest["products"]),
        }, indent=2))


if __name__ == "__main__":
    main()
