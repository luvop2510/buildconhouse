"""Compare exact family-page output/CPU using an already captured catalog.

Run from backend/ with the hermetic CI environment. This script never reads or
writes Mongo; --source is a local capture containing products/brands/categories.
"""
from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
import statistics
import subprocess
import sys
from time import perf_counter
from types import ModuleType

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from services import catalog_service as updated  # noqa: E402


async def measure(module, source, samples):
    snapshot = module._build_snapshot(source["products"], [], source["brands"], source["categories"], [])
    token = module._snapshot_override.set(snapshot)
    try:
        brand_ids = {row["name"]: row["id"] for row in source["brands"]}
        timings, outputs = {}, {}
        for brand in ("Vitra", "Grohe", "Hansgrohe"):
            elapsed = []
            for _ in range(samples):
                start = perf_counter()
                output = await module.list_family_groups(
                    brand_id=brand_ids[brand], category_id=None, subcategory=None, series=None,
                    q=None, limit=60, skip=0, floor_ids=["first-floor"],
                )
                elapsed.append((perf_counter() - start) * 1000)
            timings[brand] = {"median_ms": statistics.median(elapsed), "samples_ms": elapsed, "cards": len(output["items"])}
            outputs[brand] = output
        return timings, outputs
    finally:
        module._snapshot_override.reset(token)


async def main(args):
    code = subprocess.run(
        ["git", "show", f"{args.baseline_ref}:backend/services/catalog_service.py"],
        check=True, capture_output=True, text=True,
    ).stdout
    before = ModuleType("catalog_hydration_baseline")
    sys.modules[before.__name__] = before
    exec(compile(code, f"{args.baseline_ref}:catalog_service.py", "exec"), before.__dict__)
    source = json.loads(args.source.read_text())
    previous, previous_output = await measure(before, source, args.samples)
    current, current_output = await measure(updated, source, args.samples)
    result = {
        "scope": f"Captured {len(source['products'])}-product Sanitary Bathroom snapshot; 60-card first family pages; media omitted identically; pure service CPU excludes network/DB/HTTP/browser; {args.samples} sequential samples including first index build.",
        "baseline_ref": args.baseline_ref,
        "before": previous, "after": current, "exact_output_parity": previous_output == current_output,
    }
    if not result["exact_output_parity"]:
        raise AssertionError("Benchmark changed catalog response output")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"output": str(args.output), "exact_output_parity": True,
                      "medians_ms": {brand: [previous[brand]["median_ms"], current[brand]["median_ms"]] for brand in previous}}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--baseline-ref", default="a8e106e4")
    parser.add_argument("--samples", default=10, type=int)
    args = parser.parse_args()
    if args.samples < 1:
        parser.error("--samples must be positive")
    asyncio.run(main(args))
