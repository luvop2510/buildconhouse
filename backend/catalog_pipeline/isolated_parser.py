"""Bounded admission and a killable deadline for supplier extraction."""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import signal
import sys
import tempfile

from fastapi import HTTPException

from .resource_limits import MAX_RESULT_BYTES, MAX_SOURCE_BYTES

MAX_PARSE_PROCESSES = 2
PARSE_DEADLINE_SECONDS = 240
_parse_slots = asyncio.Semaphore(MAX_PARSE_PROCESSES)


async def _stop_parser(process) -> None:
    if process.returncode is None:
        try:
            if os.name == "posix":
                os.killpg(process.pid, signal.SIGKILL)
            else:
                process.kill()
        except ProcessLookupError:
            pass
        await process.wait()


def _read_result(path: Path) -> dict:
    if not path.is_file() or path.stat().st_size > MAX_RESULT_BYTES:
        raise ValueError("Invalid supplier extraction result")
    return json.loads(path.read_bytes())


async def extract_isolated(brand: str, filename: str, data: bytes) -> dict:
    """Run all supplier adapters outside the API loop with bounded resources."""
    if not data or len(data) > MAX_SOURCE_BYTES:
        raise HTTPException(status_code=413, detail="Supplier file is empty or exceeds the 80MB limit")
    try:
        await asyncio.wait_for(_parse_slots.acquire(), timeout=0.25)
    except TimeoutError:
        raise HTTPException(status_code=429, detail="Catalog extraction is busy; retry shortly") from None
    process = None
    temporary = None
    try:
        temporary = tempfile.TemporaryDirectory(prefix="forge-catalog-parse-")
        directory = temporary.name
        source = Path(directory) / "source"
        result_path = Path(directory) / "result.json"
        await asyncio.to_thread(source.write_bytes, data)
        # Parsing requires no application credentials or provider keys. Native
        # converters retain only the OS environment needed to locate libraries.
        environment = {key: os.environ[key] for key in (
            "PATH", "LANG", "LC_ALL", "SYSTEMROOT", "WINDIR", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH",
        ) if key in os.environ}
        environment.update({"TMPDIR": directory, "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1",
                            "MAGICK_MEMORY_LIMIT": "128MiB", "MAGICK_MAP_LIMIT": "256MiB",
                            "MAGICK_DISK_LIMIT": "256MiB", "MAGICK_THREAD_LIMIT": "1", "MAGICK_TIME_LIMIT": "20"})
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "catalog_pipeline.parse_worker", str(source), str(result_path), brand, filename,
            cwd=str(Path(__file__).resolve().parents[1]), env=environment,
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
            start_new_session=os.name == "posix",
        )
        try:
            await asyncio.wait_for(process.wait(), timeout=PARSE_DEADLINE_SECONDS)
        except TimeoutError:
            raise HTTPException(status_code=422, detail="Supplier document exceeded the parsing time limit") from None
        try:
            result = await asyncio.to_thread(_read_result, result_path)
        except (OSError, ValueError):
            raise HTTPException(status_code=422, detail="Supplier document exceeded parsing resources or could not be parsed") from None
        if process.returncode or "error" in result:
            raise HTTPException(status_code=422, detail=result.get("error", "Supplier document could not be parsed"))
        return result
    finally:
        try:
            if process is not None:
                await _stop_parser(process)
        finally:
            try:
                if temporary is not None:
                    temporary.cleanup()
            finally:
                _parse_slots.release()
