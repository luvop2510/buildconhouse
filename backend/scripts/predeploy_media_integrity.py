"""Read-only, paginated media integrity gate. Never writes or deletes app data."""
from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import re
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE))
load_dotenv(BASE / ".env")

from db import db  # noqa: E402
from media_storage.factory import get_media_storage  # noqa: E402
from services.catalog_media_integrity import find_media_integrity_issues  # noqa: E402
from services.media_integrity_gate import inspect_media_bytes  # noqa: E402


def safe_error(exc: Exception) -> dict:
    """Provider messages can contain URLs, tokens and bodies; expose only type/status."""
    while isinstance(exc, BaseExceptionGroup) and exc.exceptions:
        exc = exc.exceptions[0]
    detail = {"error_type": type(exc).__name__}
    response = getattr(exc, "response", None)
    status = getattr(response, "status_code", None) or getattr(exc, "status_code", None)
    # The storage abstraction embeds the HTTP status in brackets. Extract only
    # that number, never persist or print the remainder of the provider message.
    if status is None:
        match = re.search(r"\[([1-5]\d\d)\]", str(exc))
        status = int(match[1]) if match else None
    if isinstance(status, int) and 100 <= status <= 599:
        detail["status_code"] = status
    return detail


def write_report(path: Path, report: dict) -> None:
    """Replace the local evidence atomically; never write storage URLs or credentials."""
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w") as stream:
            json.dump(report, stream, indent=2, default=str)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


async def scan_media_rows(media_rows: list[dict], storage, *, concurrency: int,
                          delay: float, results: list, progress: dict) -> None:
    """Use a fixed worker pool, with deterministic results and bounded downloads."""
    pending = iter(enumerate(media_rows))

    async def worker() -> None:
        while (item := next(pending, None)) is not None:
            index, media = item
            issues = []
            key, bucket = media.get("storage_key"), media.get("bucket")
            if not key or not bucket:
                issues.append({"media_id": media.get("id"), "kind": "missing_storage_reference"})
            else:
                try:
                    data = await storage.download(bucket=bucket, key=key)
                except Exception as exc:
                    issues.append({"media_id": media.get("id"), "kind": "missing_object",
                                   "detail": safe_error(exc)})
                else:
                    for issue in inspect_media_bytes(media, data):
                        issues.append({"media_id": media.get("id"), **issue})
            results[index] = issues
            progress["scanned"] += 1
            if progress["scanned"] % 100 == 0 or progress["scanned"] == len(media_rows):
                print(f"Media bytes checked: {progress['scanned']}/{len(media_rows)}", file=sys.stderr, flush=True)
            if delay and progress["scanned"] < len(media_rows):
                await asyncio.sleep(delay)

    async with asyncio.TaskGroup() as group:
        for _ in range(min(concurrency, len(media_rows))):
            group.create_task(worker())


async def main(page_size: int, delay: float, max_items: int | None,
               concurrency: int = 4, report_path: Path | None = None) -> int:
    """Preserve integrity checks and fail closed, including incomplete scans."""
    if not 1 <= concurrency <= 8 or not 1 <= page_size <= 1000:
        raise ValueError("Concurrency must be 1..8 and page size 1..1000")
    if not math.isfinite(delay) or delay < 0 or (max_items is not None and max_items < 1):
        raise ValueError("Delay must be nonnegative and max-items positive")
    started = datetime.now(timezone.utc).isoformat()
    media_rows, metadata_issues, results = [], [], []
    progress = {"scanned": 0}
    error = None
    storage = None
    try:
        products = await db.products.find({}, {"_id": 0, "id": 1, "brand_id": 1, "floor_id": 1, "family_key": 1}).to_list(100_000)
        offset = 0
        while max_items is None or len(media_rows) < max_items:
            take = min(page_size, max_items - len(media_rows)) if max_items else page_size
            page = await db.product_media.find({}, {"_id": 0}).sort("_id", 1).skip(offset).limit(take).to_list(take)
            if not page:
                break
            media_rows.extend(page)
            offset += len(page)
        metadata_issues = find_media_integrity_issues(products, media_rows)
        results = [None] * len(media_rows)
        storage = get_media_storage()
        await scan_media_rows(media_rows, storage, concurrency=concurrency,
                              delay=delay, results=results, progress=progress)
    except Exception as exc:
        error = safe_error(exc)
    finally:
        if storage is not None:
            try:
                await storage.close()
            except Exception as exc:
                error = error or safe_error(exc)
    issues = metadata_issues + [issue for row in results if row is not None for issue in row]
    complete = error is None and progress["scanned"] == len(media_rows)
    report = {
        "read_only": True, "started_at": started,
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "scanned": progress["scanned"], "planned": len(media_rows),
        "complete": complete, "full_scan": max_items is None,
        "page_size": page_size, "concurrency": concurrency,
        "issues": issues,
        "counts": {kind: sum(row.get("kind") == kind for row in issues)
                   for kind in sorted({row.get("kind") for row in issues})},
    }
    if error:
        report["error"] = error
    if report_path is not None:
        write_report(report_path, report)
    print(json.dumps(report, indent=2, default=str))
    return 1 if issues or not complete else 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--page-size", type=int, default=100)
    parser.add_argument("--delay-seconds", type=float, default=0.05, help="pause between each worker's objects")
    parser.add_argument("--max-items", type=int, default=None, help="safe smoke-test cap; omit for full scan")
    parser.add_argument("--concurrency", type=int, default=4, help="bounded download workers (1..8)")
    parser.add_argument("--report", type=Path, help="atomic local JSON evidence, excluding provider secrets")
    args = parser.parse_args()
    try:
        code = asyncio.run(main(args.page_size, args.delay_seconds, args.max_items,
                                args.concurrency, args.report))
    except Exception as exc:
        print(json.dumps({"read_only": True, "complete": False, "error": safe_error(exc)}), file=sys.stderr)
        code = 1
    raise SystemExit(code)
