"""Remove weak gallery media only after an official manufacturer hero exists.

Use without ``--apply`` to produce a reviewable queue.  The apply mode is
idempotent and deletes only poor/missing sibling rows; the canonical official
hero remains untouched.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

from dotenv import load_dotenv

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE))
load_dotenv(BASE / ".env")

from scripts.catalog_image_enrichment import prune_replaced_weak_media  # noqa: E402


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--floor-id", default="first-floor")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    print(json.dumps(await prune_replaced_weak_media(
        floor_id=args.floor_id, apply_changes=args.apply,
    ), indent=2))


if __name__ == "__main__":
    asyncio.run(main())
