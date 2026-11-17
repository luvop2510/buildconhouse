"""Read-only gate ownership diagnostics; never releases or expires tokens.

Run with the intended backend environment:
    python scripts/inspect_mutation_admission.py
Legacy tokens have no recoverable owner or start time. Stop and verify all
possible writers before following the workspace repair recovery procedure.
"""
import asyncio
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from db import client, db  # noqa: E402
from services.mutation_admission import admission_status  # noqa: E402


async def main():
    try:
        print(json.dumps(await admission_status(db), indent=2))
    finally:
        client.close()


if __name__ == "__main__":
    asyncio.run(main())
