#!/usr/bin/env python3
"""Compress complete Inter fonts and verify decoded data against original TTFs.

Requires FontTools 4.66.1 and Brotli 1.2.0. Run with the isolated interpreter
documented in the audit; --check validates existing files without writing.
No glyph subsetting, design replacement, or TTF modifications occur.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path

import brotli
import fontTools
from fontTools.pens.recordingPen import RecordingPen
from fontTools.ttLib import TTFont
from fontTools.ttLib.woff2 import WOFF2FlavorData

ROOT = Path(__file__).resolve().parents[1]
AUDIT = ROOT / "docs/audits/2026-10-06-inter-web-font-compression.json"
FAMILIES = ("Inter-Regular", "Inter-Medium", "Inter-SemiBold", "Inter-Bold")
REPRESENTATION_TABLES = {"head"}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def drawing(font: TTFont, name: str) -> list:
    pen = RecordingPen()
    font.getGlyphSet()[name].draw(pen)
    return pen.value


def glyph_data(font: TTFont, name: str) -> dict:
    glyph = font["glyf"][name]
    data = {
        "contours": glyph.numberOfContours,
        "bounds": tuple(getattr(glyph, field, None)
                        for field in ("xMin", "yMin", "xMax", "yMax")),
        "instructions": bytes(glyph.program.getBytecode())
        if hasattr(glyph, "program") else b"",
    }
    if glyph.isComposite():
        data["components"] = [
            (component.getComponentInfo(), component.flags)
            for component in glyph.components
        ]
    elif glyph.numberOfContours > 0:
        data["coordinates"] = tuple(tuple(point) for point in glyph.coordinates)
        data["contour_ends"] = tuple(glyph.endPtsOfContours)
        data["point_flags"] = tuple(glyph.flags)
    return data


def validate(source: bytes, compressed: bytes) -> dict:
    original = TTFont(io.BytesIO(source), recalcTimestamp=False)
    decoded = TTFont(io.BytesIO(compressed), recalcTimestamp=False)
    require(decoded.flavor == "woff2", "Output is not WOFF2")
    require("glyf" in original, "Unsupported non-TrueType outline data")
    require(set(original.keys()) == set(decoded.keys()), "Font tables differ")
    names = original.getGlyphOrder()
    require(names == decoded.getGlyphOrder(), "Glyph order or count differs")
    for name in names:
        require(glyph_data(original, name) == glyph_data(decoded, name),
                f"Unequal outline, component, bounds, flags, or hinting: {name}")
        require(drawing(original, name) == drawing(decoded, name),
                f"Unequal glyph/component drawing: {name}")
    require(original["hmtx"].metrics == decoded["hmtx"].metrics,
            "Horizontal advances or bearings differ")
    original_cmaps = [(table.platformID, table.platEncID, table.language,
                       table.format, table.cmap)
                      for table in original["cmap"].tables if table.isUnicode()]
    decoded_cmaps = [(table.platformID, table.platEncID, table.language,
                      table.format, table.cmap)
                     for table in decoded["cmap"].tables if table.isUnicode()]
    require(original_cmaps == decoded_cmaps, "Unicode cmap differs")
    unicode_points = set().union(*(set(table[-1]) for table in original_cmaps))
    raw_equal = []
    representation_changes = []
    for tag in original.keys():
        if tag == "GlyphOrder":
            continue
        left, right = original.reader[tag], decoded.reader[tag]
        if left == right:
            raw_equal.append(tag)
        else:
            require(tag in REPRESENTATION_TABLES, f"Unequal table: {tag}")
            representation_changes.append(tag)
    # Glyph/metric transforms are disabled to retain all glyph flags exactly.
    # WOFF2 marks head.flags bit 11 and changes the checksum adjustment.
    # All other head values,
    # including timestamps, unitsPerEm, dimensions, and format, must match.
    head_changes = {}
    for field, value in original["head"].__dict__.items():
        other = decoded["head"].__dict__.get(field)
        if value != other:
            require(field in {"checkSumAdjustment", "flags"},
                    f"Unequal head value: {field}")
            if field == "flags":
                require((value ^ other) == 0x0800,
                        "Unexpected head flags change")
            head_changes[field] = {"source": value, "decoded": other}
    required_exact = {"cmap", "hmtx", "hhea", "maxp", "OS/2", "name", "post",
                      "prep", "gasp", "GDEF", "GPOS", "GSUB", "STAT",
                      "glyf", "loca"}
    require(required_exact.issubset(raw_equal), "Required exact tables differ")
    return {
        "glyph_count": len(names),
        "unicode_count": len(unicode_points),
        "unicode_cmap_count": len(original_cmaps),
        "name_record_count": len(original["name"].names),
        "licensing_name_record_count": sum(
            record.nameID in {0, 13, 14} for record in original["name"].names),
        "checks": {
            "woff2_container": True,
            "table_set_preserved": True,
            "glyph_count_and_order_preserved": True,
            "every_glyph_outline_and_contour_preserved": True,
            "every_component_transform_and_flags_preserved": True,
            "every_glyph_and_component_drawing_preserved": True,
            "glyph_bounds_and_hinting_instructions_preserved": True,
            "glyf_and_loca_table_bytes_preserved": True,
            "all_unicode_cmaps_preserved": True,
            "all_cmap_table_bytes_preserved": True,
            "horizontal_advances_and_bearings_preserved": True,
            "metrics_and_os2_table_bytes_preserved": True,
            "naming_and_licensing_metadata_bytes_preserved": True,
            "gdef_gpos_gsub_shaping_table_bytes_preserved": True,
            "stat_and_post_table_bytes_preserved": True,
            "prep_and_gasp_table_bytes_preserved": True,
            "head_values_preserved_except_documented_woff2_fields": True,
            "no_subsetting_or_design_replacement": True,
        },
        "byte_identical_decoded_tables": sorted(raw_equal),
        "representation_only_table_changes": sorted(representation_changes),
        "head_representation_changes": head_changes,
        "unsupported_or_unequal_semantic_data": [],
    }


def run(check: bool) -> None:
    require(fontTools.__version__ == "4.66.1", "Use FontTools 4.66.1")
    require(brotli.__version__ == "1.2.0", "Use Brotli 1.2.0")
    files, outputs, baseline = [], {}, {}
    for family in FAMILIES:
        source_path = ROOT / f"assets/fonts/{family}.ttf"
        web_path = source_path.with_suffix(".woff2")
        source = source_path.read_bytes()
        baseline[source_path] = source
        font = TTFont(io.BytesIO(source), recalcTimestamp=False)
        font.flavor = "woff2"
        # Default glyph transforms normalize repeated OVERLAP_SIMPLE flags.
        # Untransformed WOFF2 still compresses with Brotli and preserves the
        # original glyf/loca table data, including every point/component flag.
        font.flavorData = WOFF2FlavorData(transformedTables=set())
        buffer = io.BytesIO()
        font.save(buffer)
        compressed = buffer.getvalue()
        if check:
            require(web_path.read_bytes() == compressed,
                    f"Output differs from reproducible conversion: {web_path.name}")
        validation = validate(source, compressed)
        validation["checks"]["reproducible_conversion"] = True
        validation["checks"]["original_ttf_bytes_unchanged"] = True
        files.append({
            "family": family,
            "source_path": str(source_path.relative_to(ROOT)),
            "web_path": str(web_path.relative_to(ROOT)),
            "source_bytes": len(source), "web_bytes": len(compressed),
            "source_sha256": sha256(source), "web_sha256": sha256(compressed),
            **validation,
        })
        outputs[web_path] = compressed
    require(all(path.read_bytes() == data for path, data in baseline.items()),
            "An original TTF changed during validation")
    manifest = {
        "format": {"source": "TrueType TTF", "web": "WOFF2",
                   "fonttools_version": fontTools.__version__,
                   "brotli_version": brotli.__version__,
                   "subsetting": False, "recalc_timestamp": False,
                   "glyph_and_metric_transforms": False},
        "command": "output/operations/font-compression-runtime/bin/python "
                   "scripts/compress-app-fonts.py --check",
        "source_total_bytes": sum(row["source_bytes"] for row in files),
        "web_total_bytes": sum(row["web_bytes"] for row in files),
        "verification_scope": "All glyph outlines, component transforms/flags, "
            "contour coordinates/flags, drawings, bounds, hinting instructions, "
            "Unicode cmaps, advances/bearings and complete naming/licensing, "
            "metrics and shaping tables compared after decoding. No browser "
            "rasterization, shaping-engine execution or physical-device test claimed.",
        "conversion_caveat": "Decoded SFNT bytes are not globally identical: "
            "head checksum adjustment and bit 11 change for the compressed "
            "representation. Glyph/metric transforms are disabled to preserve "
            "all original flags. Validated font design, semantic data and every "
            "other complete table's original bytes are preserved.",
        "unsupported_or_unequal_semantic_data": [],
        "files": files,
    }
    encoded = json.dumps(manifest, indent=2) + "\n"
    if check:
        require(AUDIT.read_text() == encoded, "Audit differs from verified fonts")
    else:
        for path, data in outputs.items():
            path.write_bytes(data)
        AUDIT.write_text(encoded)
    print(f"{'Verified' if check else 'Compressed and verified'} {len(files)} fonts: "
          f"{manifest['source_total_bytes']} -> {manifest['web_total_bytes']} bytes")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true",
                        help="Validate existing WOFF2 files and audit without writing")
    run(parser.parse_args().check)
