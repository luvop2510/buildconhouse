"""Read-only catalog performance probe using the configured Mongo database.

Run from backend/: python scripts/benchmark_catalog_performance.py --output report.json
This only reads source collections and catalog services. It never starts server
bootstrap, runs migrations, creates sessions or writes database records. Output
contains operational counts/mode/timings only. Requires the normal backend env.
The default acceptance budget applies to warmed local service computation;
it does not measure browser, authentication or production HTTP latency.
"""
from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
import resource
import statistics
import sys
from time import perf_counter

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from db import client  # noqa: E402
from services import catalog_service as catalog  # noqa: E402


async def timed(call):
    start = perf_counter()
    result = await call()
    return result, round((perf_counter() - start) * 1000, 3)


async def benchmark(*, samples=5, budget_ms=200, allow_database_mode=False):
    snapshot, warmup_ms = await timed(catalog.refresh_catalog_snapshot)
    diagnostics = catalog.catalog_diagnostics()
    result = {
        "methodology": "Read-only configured Mongo source; warmed local catalog service timing. Excludes auth, HTTP and browser. First call is recorded separately; no records exported.",
        "snapshot_warmup_ms": warmup_ms,
        "catalog": diagnostics,
        "products_retained": len(snapshot.products),
        "service_budget_ms": budget_ms,
        "floors": {},
        "failures": [],
    }
    if diagnostics["mode"] != "memory" and not allow_database_mode:
        result["failures"].append("Catalog exceeds its warm snapshot budget; database paging requires explicit performance acceptance")
    for floor in ("first-floor", "ground-floor", "second-floor", "third-floor"):
        probes = {
            "families": lambda: catalog.list_family_groups(
                brand_id=None, category_id=None, subcategory=None, series=None,
                q=None, limit=60, skip=0, floor_ids=[floor],
            ),
            "hierarchy": lambda: catalog.hierarchy_rows([floor]),
            "brands": lambda: catalog.list_brands_with_counts([floor]),
            "categories": lambda: catalog.list_categories_with_counts(None, [floor]),
        }
        measurements = {}
        for name, probe in probes.items():
            _, first_ms = await timed(probe)
            runs = [await timed(probe) for _ in range(samples)]
            times = [elapsed for _, elapsed in runs]
            response = runs[-1][0]
            count = len(response["items"]) if name == "families" else len(response[0]) if name == "hierarchy" else len(response)
            measurements[name] = {
                "first_call_ms": first_ms, "samples_ms": times,
                "median_ms": round(statistics.median(times), 3),
                "max_ms": max(times), "response_rows": count,
            }
            if max(times) > budget_ms:
                result["failures"].append(f"{floor} {name} exceeds the {budget_ms:g} ms warmed service budget")
        result["floors"][floor] = measurements
    divisor = 1024 * 1024 if sys.platform == "darwin" else 1024
    result["process_peak_rss_mb"] = round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / divisor, 2)
    result["passed"] = not result["failures"]
    return result


async def main(args):
    try:
        result = await benchmark(samples=args.samples, budget_ms=args.budget_ms,
                                 allow_database_mode=args.allow_database_mode)
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result, indent=2))
        return 0 if result["passed"] else 1
    finally:
        client.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--samples", type=int, default=5)
    parser.add_argument("--budget-ms", type=float, default=200)
    parser.add_argument("--allow-database-mode", action="store_true",
                        help="Explicitly accept testing an intentionally oversized catalog; timing budgets still apply")
    args = parser.parse_args()
    if not 1 <= args.samples <= 20:
        parser.error("--samples must be between 1 and 20")
    if args.budget_ms <= 0:
        parser.error("--budget-ms must be positive")
    raise SystemExit(asyncio.run(main(args)))
