"""Base classes + shared types for the catalog ingestion framework."""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Iterable, Optional
from uuid import uuid4


MISSING = "[MISSING DATA]"

ALLOWED_CATEGORIES = [
    "Faucets", "Basins", "Water Closets", "Showers", "Bathtubs",
    "Accessories", "Flush Plates", "Urinals", "Kitchen Sinks",
    "Concealed Cisterns", "Bidets", "Thermostats",
]


@dataclass
class ProductRow:
    row_id: str = field(default_factory=lambda: str(uuid4()))
    brand: str = MISSING
    name: str = MISSING
    sku: str = MISSING
    category: str = MISSING
    subcategory: str = MISSING
    series: str = MISSING
    family_key: str = MISSING       # SKUs that share a family_key are variants of each other
    variant: str = MISSING          # short label distinguishing this variant (finish / size / colour)
    finish: str = MISSING
    finish_code: str = MISSING
    colour: str = MISSING
    material: str = MISSING
    dimensions: str = MISSING
    size: str = MISSING            # tile nominal size, e.g. "600X600" — distinct from `dimensions`
    description: str = MISSING
    mrp: Any = MISSING              # float or MISSING
    dealer_price: Any = MISSING     # float or MISSING
    warranty: str = MISSING
    collection: str = MISSING
    accessories: list[str] = field(default_factory=list)
    images: list[str] = field(default_factory=list)  # data-URLs (base64) or absolute URLs
    image_meta: list[dict] = field(default_factory=list)   # {width, height, quality, source_format}
    image_quality: str = "missing"                          # "excellent"|"good"|"acceptable"|"poor"|"missing"
    image_page: Optional[int] = None
    specs: dict[str, Any] = field(default_factory=dict)     # freeform key/value spec extras
    tags: list[str] = field(default_factory=list)
    must_buy_concealed: bool = False
    concealed_sku: Optional[str] = None
    concealed_skus: list[str] = field(default_factory=list)
    confidence: float = 1.0
    issues: list[str] = field(default_factory=list)
    status: str = "pending"         # pending | accepted | rejected

    def to_public(self) -> dict[str, Any]:
        return {
            "row_id": self.row_id, "brand": self.brand, "name": self.name, "sku": self.sku,
            "category": self.category, "subcategory": self.subcategory, "series": self.series,
            "family_key": self.family_key, "variant": self.variant, "finish": self.finish,
            "finish_code": self.finish_code, "colour": self.colour, "material": self.material,
            "dimensions": self.dimensions, "size": self.size, "description": self.description,
            "mrp": self.mrp, "dealer_price": self.dealer_price, "warranty": self.warranty,
            "collection": self.collection, "accessories": self.accessories,
            "images": self.images, "image_meta": self.image_meta,
            "image_quality": self.image_quality, "image_page": self.image_page,
            "specs": self.specs, "tags": self.tags,
            "must_buy_concealed": self.must_buy_concealed,
            "concealed_sku": self.concealed_sku,
            "concealed_skus": self.concealed_skus,
            "confidence": self.confidence, "issues": self.issues, "status": self.status,
        }


@dataclass
class ExtractionReport:
    brand: str
    filename: str
    source_type: str
    pages: int = 0
    raw_rows: int = 0
    parsed_rows: int = 0
    images_found: int = 0
    images_mapped: int = 0
    warnings: list[str] = field(default_factory=list)


class BrandAdapter:
    """Adapter interface implemented per supplier."""
    brand: str = "generic"
    supported_extensions: tuple[str, ...] = (".xlsx", ".xls", ".pdf", ".csv")

    def extract(self, data: bytes, filename: str) -> tuple[list[ProductRow], ExtractionReport]:  # pragma: no cover
        raise NotImplementedError

    # Utility ---------------------------------------------------------------

    @staticmethod
    def to_number(v: Any) -> Any:
        if v in (None, "", MISSING):
            return MISSING
        try:
            s = str(v).replace("₹", "").replace(",", "").replace(" ", "")
            return float(s) if s else MISSING
        except (TypeError, ValueError):
            return MISSING


def dedupe_iter(items: Iterable[str]) -> list[str]:
    """Preserve order, drop dupes and empties."""
    seen: set[str] = set()
    out: list[str] = []
    for x in items:
        if x and x not in seen:
            seen.add(x)
            out.append(x)
    return out
