"""Exclude the discontinued catalog brand without modifying other suppliers."""
from collections.abc import Mapping


def removed_brand_identity(value) -> bool:
    """Match a brand identity only; descriptions and family names are unrelated."""
    return isinstance(value, str) and value.strip().casefold() == "axor"


def removed_brand_document(row: Mapping) -> bool:
    return removed_brand_identity(row.get("name")) or removed_brand_identity(row.get("slug"))


def removed_supplier_row(row: Mapping) -> bool:
    """Mixed supplier workbooks explicitly classify each row by collection."""
    return any(removed_brand_identity(row.get(field)) for field in ("collection", "brand", "brand_name"))
