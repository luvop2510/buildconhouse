"""Apply a reviewed Ground Floor MCM preview using private source and recovery records."""
from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
from io import BytesIO
import json
from pathlib import Path
import sys
from uuid import UUID, uuid5

import httpx
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from preview_mcm_catalogue import (
    BRAND, FLOOR, compare, name_key, read_source, write_report,
)
from services.product_image_normalizer import normalize_product_image

MCM_NAMESPACE = UUID("010c4663-07c9-457f-ab68-6eefff17c810")
WORKBOOK_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def scope_for(brand):
    return {"floor_id": FLOOR, "brand_id": brand["id"]}


def validate_review(database, preview, current, source_digest, *, create_brand):
    if (preview.get("mode") != "dry-run" or preview.get("database") != database.name
            or preview.get("source_sha256") != source_digest):
        raise ValueError("The preview, target database and workbook must match.")
    if current["other_brand_near_matches"] or current["comparison"]["ambiguous_matches"]:
        raise ValueError("Ambiguous or cross-brand identities require resolution before applying.")
    if any(preview.get(key) != value for key, value in current.items()):
        raise ValueError("The live catalogue differs from the reviewed preview. Generate a fresh preview.")
    if current["brand"] is None:
        if not create_brand or current["brand_matches_all_floors"]:
            raise ValueError("A new Ground Floor MCM brand requires explicit creation and a unique brand identity.")


async def require_scoped_indexes(database):
    for collection, scope in (
        (database.brands, {"floor_id", "slug"}),
        (database.products, {"floor_id", "brand_id", "sku"}),
    ):
        indexes = await collection.index_information()
        if not any(index.get("unique") and set(dict(index["key"])) == scope for index in indexes.values()):
            raise ValueError(f"Expected the existing unique catalogue scope index on {collection.name}.")


async def ensure_immutable(storage, bucket, key, data, mime):
    from media_storage.base import StorageObjectExists

    if not await storage.exists(bucket=bucket, key=key):
        try:
            await storage.upload(bucket=bucket, key=key, data=data, content_type=mime, upsert=False)
        except StorageObjectExists:
            pass
    saved = await storage.download(bucket=bucket, key=key)
    if saved != data:
        raise ValueError(f"Persistent object bytes differ from the reviewed source at {key}.")


async def stage_artwork(storage, bucket, rows, plan, *, verify_public=True):
    from services.media_quality import quality_from_dimensions

    assets = {}
    for row, detail in zip(rows, plan["rows"], strict=True):
        if not detail["image_change"]:
            continue
        digest = detail["normalized_image_sha1"]
        if digest in assets:
            continue
        header, payload = row.images[0].split(",", 1)
        blob, mime = normalize_product_image(
            base64.b64decode(payload, validate=True), header.removeprefix("data:").split(";", 1)[0],
        )
        if hashlib.sha1(blob).hexdigest() != digest:
            raise ValueError(f"Image differs from preview on workbook row {detail['excel_row']}.")
        with Image.open(BytesIO(blob)) as image:
            width, height = image.size
            image.verify()
        extension = {"image/jpg": "jpg", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}[mime]
        key = f"mcm/workbook-assets/{hashlib.sha256(blob).hexdigest()}.{extension}"
        url = storage.get_public_url(bucket=bucket, key=key)
        assets[digest] = (
            blob,
            {"bucket": bucket, "storage_key": key, "public_url": url, "sha1": digest,
             "width": width, "height": height, "quality": quality_from_dimensions(width, height, mime),
             "mime": mime, "size_bytes": len(blob)},
        )

    workers = asyncio.Semaphore(8)
    async with httpx.AsyncClient(timeout=20) as web:
        async def publish(blob, meta):
            async with workers:
                await ensure_immutable(storage, bucket, meta["storage_key"], blob, meta["mime"])
                if verify_public:
                    preview = await web.get(meta["public_url"])
                    if preview.status_code != 200 or preview.content != blob:
                        raise ValueError(f"Public image preview could not be verified at {meta['storage_key']}.")

        outcomes = await asyncio.gather(*(publish(blob, meta) for blob, meta in assets.values()), return_exceptions=True)
        for outcome in outcomes:
            if isinstance(outcome, BaseException):
                raise outcome
    return {digest: meta for digest, (_, meta) in assets.items()}


def product_fields(row, *, current=None):
    specs = dict((current or {}).get("specs") or {})
    specs.update(row.specs)
    # Quotation inputs use the supplied square-foot coverage and unit. Keep the
    # legacy alias consistent where a previous MCM record exposed it.
    if "rate_unit" in specs:
        specs["rate_unit"] = "sqft"
    if "rate_per_sqft" in specs:
        specs["rate_per_sqft"] = row.mrp
    fields = {"name": row.name, "size": row.size, "finish": row.finish, "mrp": row.mrp,
              "price": row.mrp, "specs": specs}
    if not current or not current.get("family_name"):
        fields["family_name"] = row.name
    if not current or not current.get("family_key"):
        fields["family_key"] = row.family_key
    if current and ("price_status" in current or "price_unknown" in current):
        fields.update(price_status="known", price_unknown=False)
    return fields


async def save_batch(database, rows, approved, assets, source, actor_id, session):
    from models import Brand, CatalogImportJob, Product, ProductMedia, now_iso

    brand = approved["brand"]
    created_brand = brand is None
    if created_brand:
        brand = Brand(name=BRAND, slug="mcm", floor_id=FLOOR).model_dump()
    scope = scope_for(brand)
    categories = await database.categories.find(
        {"floor_id": FLOOR, "slug": "tiles", "brand_id": None}, {"_id": 0}, session=session,
    ).to_list(2)
    if len(categories) != 1:
        raise ValueError("Exactly one shared Ground Floor Tiles category is required.")
    category = categories[0]
    existing = await database.products.find(scope, {"_id": 0}, session=session).to_list()
    by_id = {item["id"]: item for item in existing}
    siblings = {}
    for item in existing:
        key = name_key(item["name"], item.get("size"))
        siblings.setdefault(key, set()).add((item.get("family_key"), item.get("category_id")))
    job = CatalogImportJob(
        filename=source["filename"], source_type="excel", supplier_name=brand["name"],
        floor_id=FLOOR, created_by=actor_id, status="imported", total_rows=len(rows),
        accepted_rows=len(rows), **{key: val for key, val in source.items() if key != "filename"},
    ).model_dump()
    at = now_iso()
    snapshots, inserted, replacements, media_writes, prior_primaries = [], [], [], [], []
    for row, detail in zip(rows, approved["rows"], strict=True):
        if detail["status"] == "unchanged":
            continue
        product_id = detail.get("product_id")
        previous = by_id.get(product_id)
        desired = product_fields(row, current=previous)
        category_id = category["id"]
        if not previous:
            group = siblings.get(name_key(row.name, row.size), set())
            if group:
                if len(group) != 1:
                    raise ValueError("Existing size variants have multiple catalogue family or category identities.")
                family_key, category_id = next(iter(group))
                if not family_key or not category_id:
                    raise ValueError("An existing size variant has no safe catalogue family or category.")
                desired["family_key"] = family_key
            sku = row.sku
            product_id = str(uuid5(MCM_NAMESPACE, f"{FLOOR}/{brand['id']}/{sku}"))
        else:
            sku = previous["sku"]

        revision = int((previous or {}).get("catalog_version") or 0) + 1
        fields = {
            **desired, "updated_at": at, "catalog_version": revision, "catalog_import_id": job["id"],
            "catalog_updated_by": actor_id,
        }
        if not previous or detail["price_change"]:
            fields["catalog_price_updated_at"] = at
        media_before = []
        if detail["image_change"]:
            image = assets[detail["normalized_image_sha1"]]
            if previous:
                media_before = await database.product_media.find(
                    {**scope, "product_id": product_id}, {"_id": 0}, session=session,
                ).to_list()
            old_asset = next((
                item for item in media_before if item.get("sha1") == image["sha1"]
                and item.get("source_type") == "supplier" and item.get("role") == "hero"
            ), None)
            media_id = (old_asset or {}).get("id") or str(uuid5(MCM_NAMESPACE, f"{product_id}/{image['sha1']}"))
            # Keep original references in the snapshot and gallery. A supplier
            # import never demotes owner/manufacturer photos or assigns a sibling's artwork.
            if any(item.get("source_type") == "supplier" and item.get("is_primary") and item["id"] != media_id
                   for item in media_before):
                prior_primaries.append((product_id, media_id))
            media = ProductMedia(
                **image, **scope, id=media_id, product_id=product_id, family_key=desired.get("family_key", (previous or {}).get("family_key")),
                source_type="supplier", role="hero", is_primary=True, sort_order=-1,
                uploaded_by=actor_id,
            ).model_dump()
            if old_asset:
                media["created_at"] = old_asset.get("created_at", media["created_at"])
            media_writes.append(media)
            fields["image_quality"] = image["quality"]
        snapshots.append({
            "job_id": job["id"], **scope, "product_id": product_id, "was_new": previous is None,
            "previous": previous, "previous_media": media_before, "catalog_version": revision,
            "actor_id": actor_id, "created_at": at,
        })
        if previous:
            replacements.append((product_id, fields))
        else:
            product = Product(id=product_id, sku=sku, category_id=category_id, **scope, **desired).model_dump()
            inserted.append({**product, **fields})
        job["rows"].append({
            **detail, "sku": sku, "product_id": product_id, "status": "accepted",
            "import_state": "succeeded", "change_type": detail["status"], "imported_at": at,
        })

    if created_brand:
        await database.brands.insert_one(brand, session=session)
    if inserted:
        await database.products.insert_many(inserted, session=session)
    for product_id, fields in replacements:
        result = await database.products.update_one({**scope, "id": product_id}, {"$set": fields}, session=session)
        if result.matched_count != 1:
            raise ValueError("A reviewed MCM product changed during publication.")
    for product_id, media_id in prior_primaries:
        await database.product_media.update_many(
            {**scope, "product_id": product_id, "source_type": "supplier", "id": {"$ne": media_id}, "is_primary": True},
            {"$set": {"is_primary": False}}, session=session,
        )
    if media_writes:
        from pymongo import UpdateOne
        await database.product_media.bulk_write(
            [UpdateOne({**scope, "product_id": m["product_id"], "id": m["id"]}, {"$set": m}, upsert=True) for m in media_writes],
            session=session,
        )
    await database.catalog_import_snapshots.insert_many(snapshots, session=session)
    job.update(
        accepted_rows=len(snapshots), brand_created=created_brand, brand_id=brand["id"],
        import_progress={"completed": len(snapshots), "failed": 0, "total": len(snapshots)},
        import_finished_at=at,
    )
    await database.catalog_imports.insert_one(job, session=session)
    return {
        "job_id": job["id"], "brand_id": brand["id"], "created_brand": created_brand,
        "created_products": len(inserted), "updated_products": len(replacements),
        "linked_images": len(media_writes), "unique_artwork_objects_verified": len(assets),
        "products": [{"id": row["product_id"], "sku": row["sku"], "change": row["change_type"]} for row in job["rows"]],
    }


async def apply_reviewed(database, storage, *, rows, data, preview, filename, public_bucket, private_bucket,
                         actor_id, create_brand=False, verify_public=True):
    from pymongo.read_concern import ReadConcern
    from pymongo.write_concern import WriteConcern
    from services.mutation_admission import admission, finish_on_cancel

    source_digest = hashlib.sha256(data).hexdigest()
    current = await compare(database, rows)
    validate_review(database, preview, current, source_digest, create_brand=create_brand)
    if all(row["status"] == "unchanged" for row in current["rows"]):
        return {"skipped": "Every reviewed MCM row is unchanged.", "unchanged": len(rows)}

    await require_scoped_indexes(database)
    await storage.require_private_bucket(private_bucket)
    source_key = f"catalog-imports/mcm/{source_digest[:2]}/{source_digest}/source.xlsx"
    await ensure_immutable(storage, private_bucket, source_key, data, WORKBOOK_MIME)
    assets = await stage_artwork(storage, public_bucket, rows, current, verify_public=verify_public)
    source = {
        "filename": filename, "source_bucket": private_bucket, "source_storage_key": source_key,
        "source_sha256": source_digest, "source_size_bytes": len(data),
    }

    async def commit(session):
        fresh = await compare(database, rows, session=session)
        validate_review(database, preview, fresh, source_digest, create_brand=create_brand)
        return await save_batch(database, rows, fresh, assets, source, actor_id, session)

    async def transaction():
        async with await database.client.start_session() as session:
            return await session.with_transaction(
                commit, read_concern=ReadConcern("snapshot"), write_concern=WriteConcern("majority"),
            )

    # Creation is additive. The unique floor/slug and scoped SKU indexes
    # prevent a competing publication from creating a second identity.
    # Existing-brand reconciliation uses exclusive admission for variant
    # matching and protection against concurrent catalogue changes.
    async with admission(database, exclusive=current["brand"] is not None):
        return await finish_on_cancel(transaction())


async def main(args):
    if args.env_file:
        from dotenv import load_dotenv
        load_dotenv(args.env_file)
    from db import client, db
    from media_storage.factory import get_media_storage, private_bucket, public_bucket

    if args.database != db.name:
        raise ValueError("The configured database differs from the requested apply target.")
    if args.receipt.resolve() == args.preview.resolve():
        raise ValueError("Write the apply receipt separately from the reviewed preview.")
    data, rows = read_source(args.workbook)
    preview = json.loads(args.preview.read_text(encoding="utf-8"))
    storage = get_media_storage()
    try:
        owner = await db.users.find_one({"role": "owner", "active": True, "is_deleted": {"$ne": True}}, {"_id": 0, "id": 1})
        if not owner:
            raise ValueError("An active catalogue owner account is required for the import audit.")
        receipt = await apply_reviewed(
            db, storage, rows=rows, data=data, preview=preview, filename=args.workbook.name,
            public_bucket=public_bucket(), private_bucket=private_bucket(), actor_id=owner["id"],
            create_brand=args.create_brand,
        )
        write_report(args.receipt, {"database": db.name, "source_sha256": hashlib.sha256(data).hexdigest(), **receipt})
        print(json.dumps({key: value for key, value in receipt.items() if key != "products"}, indent=2))
    finally:
        await storage.close()
        client.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workbook", type=Path)
    parser.add_argument("--env-file", type=Path)
    parser.add_argument("--preview", required=True, type=Path)
    parser.add_argument("--receipt", required=True, type=Path)
    parser.add_argument("--database", required=True)
    parser.add_argument("--create-brand", action="store_true")
    asyncio.run(main(parser.parse_args()))
