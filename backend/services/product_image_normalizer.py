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


class ProductImageNormalizationError(ValueError):
    """Raised when a declared product image cannot be decoded safely."""


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
    if normalized_mime == "image/gif":
        # Re-encoding an animated image as a still image would be destructive.
        # Current supplier tile imports contain raster JPEG/PNG/WebP assets.
        return data, mime
    try:
        with Image.open(BytesIO(data)) as opened:
            orientation = opened.getexif().get(274, 1)
            if orientation == 1 and not force_landscape:
                return data, mime
            image = ImageOps.exif_transpose(opened)
            image.load()
    except (UnidentifiedImageError, OSError, ValueError) as exc:
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
