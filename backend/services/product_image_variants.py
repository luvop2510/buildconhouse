"""Bounded WebP display derivatives; original supplier files stay untouched."""
from io import BytesIO

from PIL import Image, ImageOps

WIDTHS = (320, 640, 1024, 1600, 2048)
PREFIX = "_image_variants/v1/"
MIN_BYTES = 16 * 1024
MAX_PIXELS = 32_000_000


def variant_key(key: str, width: int) -> str:
    if width not in WIDTHS:
        raise ValueError("Unsupported image display width")
    return f"{PREFIX}w{width}/{key}.webp"


def create_image_variants(data: bytes, mime: str) -> dict[int, bytes]:
    if len(data) < MIN_BYTES or mime not in {"image/png", "image/jpeg", "image/webp"}:
        return {}
    with Image.open(BytesIO(data)) as source:
        if getattr(source, "is_animated", False) or source.width * source.height > MAX_PIXELS:
            return {}
        # Keep high-bit-depth technical images in their original representation.
        if source.mode not in {"RGB", "RGBA", "P", "L", "LA"}:
            return {}
        profile = source.info.get("icc_profile")
        source.draft("RGB", (2048, 2048))
        oriented = ImageOps.exif_transpose(source)
        oriented.thumbnail((2048, 2048), Image.Resampling.LANCZOS, reducing_gap=3.0)
        base = oriented.convert("RGBA" if "A" in oriented.getbands() or "transparency" in oriented.info else "RGB")
        results = {}
        for width in WIDTHS:
            image = base.copy()
            image.thumbnail((width, width), Image.Resampling.LANCZOS, reducing_gap=3.0)
            out = BytesIO()
            image.save(out, "WEBP", quality=90 if width >= 1024 else 85, method=4,
                       **({"icc_profile": profile} if profile else {}))
            encoded = out.getvalue()
            # Tiny or already efficient originals are served directly.
            if len(encoded) < len(data) * 0.9:
                results[width] = encoded
        return results
