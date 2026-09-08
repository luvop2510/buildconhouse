"""Shared, non-destructive media-quality classification.

Quality describes the usable source resolution. It is primarily based on the
longest edge so a portrait product photo is not mislabelled as a thumbnail,
but an image with an extremely narrow short edge is still not usable media.
"""
from __future__ import annotations

from typing import Optional


def quality_from_dimensions(width: Optional[int], height: Optional[int], mime: Optional[str] = None) -> str:
    """Classify known dimensions without decoding, resizing, or guessing."""
    if (mime or "").lower() == "image/svg+xml":
        return "excellent"
    if not width or not height or width < 1 or height < 1:
        return "missing"
    # Decorative strips and extraction artefacts can be thousands of pixels
    # tall while only a few pixels wide. Do not promote them to gallery-grade
    # media merely because of that long edge. This still accepts ordinary
    # portrait product photography (for example 240×720).
    if min(width, height) < 160:
        return "poor"
    longest_edge = max(width, height)
    if longest_edge >= 1024:
        return "excellent"
    if longest_edge >= 640:
        return "good"
    if longest_edge >= 320:
        return "acceptable"
    return "poor"
