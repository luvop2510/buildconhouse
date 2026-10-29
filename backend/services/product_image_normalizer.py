"""Orientation-safe preparation for product photography.

Media must retain the supplier's intended orientation.  Responsive catalog
and quotation frames use an aspect-preserving ``contain`` fit, so rotating or
cropping a portrait product just to manufacture a landscape raster destroys
the product presentation.
"""
from __future__ import annotations

from io import BytesIO
from math import ceil

from PIL import Image, ImageOps, UnidentifiedImageError


NORMALIZABLE_IMAGE_MIMES = frozenset({"image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"})
PRODUCT_IMAGE_ASPECT_RATIO = 16 / 10
MAX_IMAGE_PIXELS = 20_000_000
MAX_IMAGE_DIMENSION = 8000


class ProductImageNormalizationError(ValueError):
    """Raised when a declared product image cannot be decoded safely."""


def _require_image_budget(width: int, height: int) -> None:
    if (width <= 0 or height <= 0 or width > MAX_IMAGE_DIMENSION
            or height > MAX_IMAGE_DIMENSION or width * height > MAX_IMAGE_PIXELS):
        raise ProductImageNormalizationError("The uploaded image exceeds the decoded image size limit")


def normalize_product_image(data: bytes, mime: str, *, force_landscape: bool = False) -> tuple[bytes, str]:
    """Bake EXIF orientation and optionally place an image on a wide canvas.

    A forced landscape asset is *never* rotated or cropped: doing either can
    change the intended orientation of a tile design.  Portrait and square
    rasters are centred on a neutral 16:10 white canvas instead, so the stored
    product asset itself is genuinely horizontal while retaining every source
    pixel.
    """
    normalized_mime = "image/jpeg" if mime == "image/jpg" else mime
    if normalized_mime not in NORMALIZABLE_IMAGE_MIMES:
        return data, mime
    try:
        with Image.open(BytesIO(data)) as opened:
            # Check header dimensions before EXIF processing, load, transpose,
            # conversion or the no-reencode path. Encoded byte limits alone
            # do not bound the raster allocated by any ingestion path.
            _require_image_budget(opened.width, opened.height)
            if normalized_mime == "image/gif":
                # Preserve animations after validating their canvas budget.
                return data, mime
            orientation = opened.getexif().get(274, 1)
            width, height = opened.size
            if orientation in {5, 6, 7, 8}:
                width, height = height, width
            if force_landscape and width <= height:
                _require_image_budget(ceil(height * PRODUCT_IMAGE_ASPECT_RATIO), height)
            if orientation == 1 and not force_landscape:
                return data, mime
            image = ImageOps.exif_transpose(opened)
            image.load()
    except ProductImageNormalizationError:
        raise
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as exc:
        raise ProductImageNormalizationError("The uploaded image could not be decoded") from exc

    image = image.convert("RGBA") if "A" in image.getbands() else image.convert("RGB")
    if force_landscape and image.width <= image.height:
        canvas = Image.new("RGB", (ceil(image.height * PRODUCT_IMAGE_ASPECT_RATIO), image.height), "white")
        x = (canvas.width - image.width) // 2
        if image.mode == "RGBA":
            canvas.paste(image, (x, 0), image)
        else:
            canvas.paste(image, (x, 0))
        image = canvas
    elif image.mode == "RGBA":
        # JPEG cannot represent transparency; composite deterministically.
        canvas = Image.new("RGB", image.size, "white")
        canvas.paste(image, (0, 0), image)
        image = canvas
    out = BytesIO()
    if normalized_mime == "image/webp":
        image.save(out, format="WEBP", quality=90, method=6)
        return out.getvalue(), "image/webp"
    if normalized_mime == "image/png":
        image.save(out, format="PNG", optimize=True)
        return out.getvalue(), "image/png"
    image.save(out, format="JPEG", quality=90, optimize=True)
    return out.getvalue(), "image/jpeg"
