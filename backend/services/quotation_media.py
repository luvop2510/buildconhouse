"""Resolve quotation photos using current, floor-scoped catalogue records."""

from models import QuotationLineItem
from services import catalog_service


def _belongs_to_sibling(url: str, product: dict, catalogue: catalog_service.CatalogSnapshot) -> bool:
    def registered(candidate: dict) -> bool:
        return url in (candidate.get("images") or []) or any(
            media.get("public_url") == url for media in catalogue.media_rows_by_product.get(candidate["id"], ())
        )

    return bool(product.get("family_key")) and not registered(product) and any(
        sibling["id"] != product["id"] and registered(sibling)
        for sibling in catalog_service._family_siblings(catalogue, product)
    )


async def canonicalize_item_images(items, floor_id: str | None = None, *, include_candidates: bool = False) -> list[dict]:
    """Resolve the exact SKU, retaining the saved photo as a historical fallback."""
    rows = [item.model_dump() if isinstance(item, QuotationLineItem) else dict(item) for item in (items or [])]
    for row in rows:
        row.pop("image_candidates", None)
    ids = {str(row["product_id"]) for row in rows if row.get("product_id")}
    if not ids or not floor_id:
        return rows

    # Use the warm snapshot or one bounded batch read on a cold process.
    catalogue = await catalog_service.snapshot_for_product_ids(list(ids))
    photos_by_product: dict[str, list[str]] = {}
    for row in rows:
        product_id = str(row.get("product_id"))
        product = catalogue.product_by_id.get(product_id)
        if not product:
            continue
        if product.get("floor_id") != floor_id:
            row.update(image=None, seat_cover_image_urls=[], dimension_image_urls=[])
            continue
        if str(product.get("sku") or "").strip() != str(row.get("sku") or "").strip():
            continue

        if product_id not in photos_by_product:
            photos_by_product[product_id] = catalog_service.product_photo_urls(product, catalogue)
        photos = photos_by_product[product_id]

        saved = row.get("image")
        if include_candidates:
            # Older quotation pickers could snapshot the representative card
            # photo when the selected SKU had no photo of its own.
            if isinstance(saved, str) and saved and saved not in photos and _belongs_to_sibling(saved, product, catalogue):
                saved = None
            row["image"] = photos[0] if photos else saved
            alternatives = list(dict.fromkeys(
                url for url in (*photos[1:], saved) if isinstance(url, str) and url and url != row["image"]
            ))
            if alternatives:
                row["image_candidates"] = alternatives
        elif photos and saved not in photos:
            row["image"] = photos[0]

    return rows
