"""GROHE PDF adapter.
SKU: 8-digit numeric (e.g. 24397000).
Prices: ₹ followed by a large number.
Product name usually contains series + size (M-Size / L-Size / XL-Size) + finish description.
"""
from __future__ import annotations
import logging
import re

from ..base import MISSING, BrandAdapter, ExtractionReport, ProductRow

logger = logging.getLogger("forge.catalog_pipeline.grohe")

# GROHE article numbers are normally numeric, but the 2026 list also contains
# valid finish/article forms such as ``20635SD0``.  Requiring at least one
# digit keeps headings and words out while preserving those real SKUs.
SKU_RE = re.compile(r"^(?=.*\d)[A-Z0-9]{7,10}$", re.IGNORECASE)
CONCEALED_SKU_RE = re.compile(r"\b(?=.*\d)([A-Z0-9]{7,10})\b", re.IGNORECASE)
PRICE_RE = re.compile(r"[`₹]\s*([\d,]+)")
SIZE_RE = re.compile(r"\b([MLXS]{1,2}|X{1,2}L)-Size\b", re.IGNORECASE)

# Detect finish tokens
FINISH_TOKENS = [
    "Chrome", "Matt Black", "Warm Sunset", "Cool Sunrise", "SuperSteel",
    "Brushed Cool Sunrise", "Brushed Warm Sunset", "Brushed Nickel",
    "Hard Graphite", "Moon White", "Nickel", "Gold",
]
CATEGORY_HINTS = {
    "Bathroom Fittings": "Faucets",
    "Bath Fittings": "Faucets",
    "Showers": "Showers",
    "Shower Systems": "Showers",
    "Hand Showers": "Showers",
    "Shower Railsets": "Showers",
    "Kitchen": "Faucets",
    "Sinks": "Kitchen Sinks",
    "Bath Tubs": "Bathtubs",
    "Bathtubs": "Bathtubs",
    "Urinals": "Urinals",
    "Flushing Systems": "Flush Plates",
    "Sensor Faucets": "Faucets",
    "Thermostats & Smart Control Mixers": "Faucets",
    "Accessories": "Accessories",
    "Bathroom Accessories": "Accessories",
    "Shower Accessories": "Accessories",
}


def extract_concealed_requirements(data: bytes) -> dict[str, list[str]]:
    """Return position-validated ``trim SKU -> concealed SKU(s)`` mappings.

    The price book is a two-column layout.  Its text streams sometimes overlap,
    so a plain-text or page-wide nearest-neighbour scan can assign a requirement
    to the product in the other column.  We retain only labels that have an
    explicit ``Must Buy Concealed`` phrase and associate each with the closest
    preceding article number in the *same* column.  If the PDF paints two
    different requirements on top of one another, that product is deliberately
    excluded from automatic labelling.
    """
    try:
        import fitz  # PyMuPDF
        document = fitz.open(stream=data, filetype="pdf")
    except Exception:
        return {}

    mappings: dict[str, set[tuple[str, ...]]] = {}
    try:
        for page in document:
            # ``get_text('words')`` may expose an image/object more than once;
            # collapse exact duplicates before checking for source conflicts.
            words = sorted(
                {
                    (round(x0, 1), round(y0, 1), text.strip())
                    for x0, y0, _x1, _y1, text, *_rest in page.get_text("words")
                    if text and text.strip()
                },
                key=lambda value: (value[1], value[0]),
            )
            midpoint = page.rect.width / 2
            products = [
                (x, y, text.upper(), "left" if x < midpoint else "right")
                for x, y, text in words
                # Article numbers appear in the dedicated product-code strip,
                # never in the requirement text to the right of it.
                if SKU_RE.fullmatch(text) and (110 <= x <= 220 or 680 <= x <= 820)
            ]
            for must_x, must_y, must_word in words:
                if must_word.lower() != "must":
                    continue
                side = "left" if must_x < midpoint else "right"
                line = [
                    (x, text) for x, y, text in words
                    if abs(y - must_y) <= 2.5
                    and (x < midpoint if side == "left" else x >= midpoint)
                    and x >= must_x
                ]
                # A second "Must" begins another requirement on the same
                # visual row (for example an optional Caesarstone upgrade).
                # Do not let its article number bleed into this requirement.
                next_label = next(
                    (index for index, (_x, text) in enumerate(line[1:], start=1)
                     if text.lower() == "must"),
                    len(line),
                )
                line = line[:next_label]
                line_text = " ".join(text for _x, text in line)
                if not re.search(r"\bmust\s+buy\b", line_text, re.IGNORECASE) or not re.search(
                    r"\bconcealed\b", line_text, re.IGNORECASE
                ):
                    continue
                concealed_at = next(
                    index for index, (_x, text) in enumerate(line)
                    if text.lower() == "concealed"
                )
                required = tuple(dict.fromkeys(
                    match.group(1).upper()
                    for _x, text in line[concealed_at + 1 :]
                    for match in CONCEALED_SKU_RE.finditer(text)
                ))
                # Each unambiguous "Concealed" label in this catalogue has
                # one required article. Multiple values at precisely the same
                # coordinates are an overlapping PDF paint operation; skip it
                # instead of presenting a fabricated composite requirement.
                if len(required) != 1:
                    continue
                candidate = max(
                    (
                        (sku_y, sku)
                        for _sku_x, sku_y, sku, sku_side in products
                        if sku_side == side and 0 < must_y - sku_y <= 105
                    ),
                    default=None,
                )
                if candidate:
                    mappings.setdefault(candidate[1], set()).add(required)
    finally:
        document.close()

    # Distinct values for a SKU are an ambiguous source overlay, not a reason
    # to choose arbitrarily.  One unambiguous tuple may contain multiple parts.
    return {
        sku: list(next(iter(requirements)))
        for sku, requirements in mappings.items()
        if len(requirements) == 1
    }


def _sniff_series(text: str, series_pool: list[str]) -> str:
    """Guess series (Allure / Grohtherm / Essence …) from product line text."""
    for s in series_pool:
        if s and s.lower() in text.lower():
            return s
    return MISSING


def _family_key_from_sku(sku: str, fallback: str) -> str:
    """Group Grohe finish variants using the article number prefix.

    The final three article-number characters distinguish the finish/colour;
    the preceding characters identify the underlying product.  Retain the
    description-derived fallback only for malformed values.
    """
    normalized = re.sub(r"\s+", "", sku or "")
    if len(normalized) > 3 and re.fullmatch(r"[A-Za-z0-9]+", normalized):
        return f"grohe:sku:{normalized[:-3].lower()}"
    return fallback


class GroheAdapter(BrandAdapter):
    brand = "Grohe"
    supported_extensions = (".pdf",)

    def extract(self, data: bytes, filename: str) -> tuple[list[ProductRow], ExtractionReport]:
        report = ExtractionReport(brand=self.brand, filename=filename, source_type="pdf")
        rows: list[ProductRow] = []
        try:
            from pypdf import PdfReader  # type: ignore
        except Exception as e:
            report.warnings.append(f"pypdf missing: {e}")
            return rows, report

        try:
            reader = PdfReader(io.BytesIO(data))
        except Exception as e:
            report.warnings.append(f"pdf open failed: {e}")
            return rows, report

        report.pages = len(reader.pages)

        concealed_requirements = extract_concealed_requirements(data)

        # Pass 1 — walk text pages, capture section headings + product lines
        current_category = MISSING
        current_series = MISSING
        # Common Grohe series we'll auto-detect
        SERIES_POOL = [
            "Allure Brilliant", "Allure", "Atrio Private", "Atrio", "Grohtherm Cube",
            "Grohtherm", "Essence", "Eurosmart Cosmopolitan", "Eurosmart", "Eurocube",
            "Cubeo", "Lineare", "Bau", "Rainshower SmartActive", "Rainshower",
            "SmartControl", "Vitalio", "Grandera",
        ]

        for page_idx, page in enumerate(reader.pages, start=1):
            try:
                text = page.extract_text() or ""
            except Exception:
                continue
            lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
            report.raw_rows += len(lines)

            i = 0
            while i < len(lines):
                line = lines[i]

                # Section heading
                if len(line) < 40 and line in CATEGORY_HINTS:
                    current_category = CATEGORY_HINTS[line]
                    i += 1
                    continue

                # Series heading
                if len(line) < 80 and SKU_RE.match(line) is None and PRICE_RE.search(line) is None:
                    guessed = _sniff_series(line, SERIES_POOL)
                    if guessed != MISSING:
                        current_series = guessed

                # Multi-line product block: SKU · Name · Price
                if SKU_RE.match(line):
                    sku = line
                    name = lines[i + 1] if i + 1 < len(lines) else MISSING
                    price_line = lines[i + 2] if i + 2 < len(lines) else ""
                    mrp = MISSING
                    pm = PRICE_RE.search(price_line)
                    if pm:
                        mrp = self.to_number(pm.group(1))
                    else:
                        # sometimes price is same line as name
                        pm2 = PRICE_RE.search(name)
                        if pm2:
                            mrp = self.to_number(pm2.group(1))
                            name = PRICE_RE.sub("", name).strip()

                    if not name or name == MISSING or SKU_RE.match(name) or PRICE_RE.search(name):
                        # this block doesn't look like a real product
                        i += 1
                        continue

                    size_m = SIZE_RE.search(name)
                    size = size_m.group(0) if size_m else MISSING

                    finish = MISSING
                    for t in FINISH_TOKENS:
                        if t.lower() in name.lower():
                            finish = t
                            break

                    series = current_series if current_series != MISSING else _sniff_series(name, SERIES_POOL)

                    base = SIZE_RE.sub("", name)
                    for t in FINISH_TOKENS:
                        base = re.sub(re.escape(t), "", base, flags=re.IGNORECASE)
                    fallback_family_key = f"grohe:{(series or MISSING).lower()}:{re.sub(r'[^a-z0-9]+', '-', base.lower()).strip('-')[:60]}"
                    family_key = _family_key_from_sku(sku, fallback_family_key)

                    pr = ProductRow(
                        brand=self.brand, name=name, sku=sku,
                        category=current_category, series=series, family_key=family_key,
                        variant=f"{size} {finish}".strip() if finish != MISSING else size,
                        finish=finish, dimensions=size if size != MISSING else MISSING,
                        mrp=mrp, dealer_price=MISSING, image_page=page_idx,
                        confidence=0.94 if mrp != MISSING and current_category != MISSING else 0.6,
                    )
                    concealed_skus = concealed_requirements.get(sku, [])
                    if concealed_skus:
                        pr.must_buy_concealed = True
                        pr.concealed_sku = concealed_skus[0]
                        pr.concealed_skus = concealed_skus
                        # Retain a human-readable representation for legacy
                        # clients while structured fields drive all new code.
                        pr.specs["Must Buy Concealed"] = ", ".join(concealed_skus)
                    if pr.mrp == MISSING:
                        pr.issues.append("Missing MRP")
                    if pr.category == MISSING:
                        pr.issues.append("Category needs manual assignment")
                    rows.append(pr)
                    i += 3
                    continue
                i += 1

        # Never map "first image on page" to every SKU on that page.  That
        # legacy heuristic produced correct-looking but often wrong product
        # photos.  This pricing PDF is therefore data-only; existing verified
        # Supabase media stays untouched and a future import needs exact,
        # position-validated source imagery before it can attach new media.
        report.warnings.append(
            "Embedded PDF images were deliberately not imported: page-level image mapping is not SKU-safe."
        )

        report.parsed_rows = len(rows)
        return rows, report
