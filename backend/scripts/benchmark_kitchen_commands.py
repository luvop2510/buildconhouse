"""Synthetic command timing: in-memory persistence with 20 ms per database call.

Run from backend with the hermetic unit-test environment. This does not measure
HTTP, authentication, MongoDB or hosted performance and never opens a database.
"""
import asyncio
import json
from pathlib import Path
import statistics
import subprocess
import sys
from types import ModuleType
from time import perf_counter

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tests.unit.test_kitchen_projects import cmd, create_request, setup


class DelayedCollection:
    def __init__(self, collection, name, calls):
        self.collection, self.name, self.calls = collection, name, calls

    def __getattr__(self, name):
        method = getattr(self.collection, name)
        async def delayed(*args, **kwargs):
            self.calls.append(f"{self.name}.{name}")
            await asyncio.sleep(0.02)
            return await method(*args, **kwargs)
        return delayed


async def main():
    database, service, owner = setup.__wrapped__()
    if "--baseline" in sys.argv:
        source = subprocess.check_output(["git", "show", "a689feda06a28366f0da8a60c89a48c4a693ed61:backend/services/kitchen_projects.py"], text=True)
        baseline = ModuleType("kitchen_command_baseline")
        exec(compile(source, "HEAD:backend/services/kitchen_projects.py", "exec"), baseline.__dict__)
        service = baseline.KitchenProjectService(database)
    project = await service.create(owner, create_request(customer_id="customer-a", idempotency_key="benchmark-create"))
    calls = []
    for name in ("kitchen_configuration", "kitchen_projects"):
        setattr(database, name, DelayedCollection(getattr(database, name), name, calls))
    samples = []
    counts = []
    for index in range(10):
        calls.clear()
        start = perf_counter()
        project = await service.command(owner, project["id"], cmd(project["version"], "move_stage", {"target_stage": "visit" if index % 2 == 0 else "lead"}))
        samples.append(round((perf_counter() - start) * 1000, 2))
        counts.append(len(calls))
    print(json.dumps({"scope": "Synthetic in-memory command with 20 ms latency per persistence operation; owner; ten adjacent stage moves; excludes HTTP/auth/live Mongo/browser", "samples_ms": samples, "median_ms": statistics.median(samples), "database_calls_per_move": counts, "last_move_calls": calls}, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
