"""Current catalog previews for floor-bound purchase line snapshots."""
from services.catalog_service import get_catalog_snapshot, product_hero_image, snapshot_for_product_ids


async def hydrate_purchase_images(rows: list[dict]) -> None:
    if not any(row.get("product_id") and row.get("floor_id") for row in rows):
        return
    snapshot = await get_catalog_snapshot()
    if getattr(snapshot, "database_backed", False):
        snapshot = await snapshot_for_product_ids(list({row["product_id"] for row in rows if row.get("product_id")}), list({row["floor_id"] for row in rows if row.get("floor_id")}))
    previews: dict[str, str | None] = {}
    for row in rows:
        product_id = row.get("product_id")
        product = snapshot.product_by_id.get(product_id) if product_id else None
        if not product or product.get("floor_id") != row.get("floor_id"):
            continue
        recorded_sku = str(row.get("sku") or "").strip()
        current_sku = str(product.get("sku") or "").strip()
        # A renamed/reassigned catalog ID no longer proves this historic
        # line's selected SKU. Ignore surrounding whitespace, preserve case.
        if recorded_sku and current_sku and recorded_sku != current_sku:
            continue
        if product_id not in previews:
            previews[product_id] = product_hero_image(product, snapshot)
        hero = previews[product_id]
        if hero:
            row["image_snapshot"] = row.get("image")
            row["image"] = hero
