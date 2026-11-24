#!/usr/bin/env python3
"""Run catalogue jobs through Buildcon House's authorized import API."""
from __future__ import annotations

import argparse
import base64
from hashlib import sha256
import http.client
import json
import os
from pathlib import Path
import re
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import NAMESPACE_URL, UUID, uuid5

DEFAULT_URL = "https://buildconhouse.in"
FLOORS = {
    "tiles": "ground-floor", "sanitary": "first-floor", "kitchen": "second-floor",
    "furniture": "third-floor",
}
OPERATIONS = ("add", "prices", "update", "sync", "images")
WORKING = {"queued", "previewing", "applying", "rolling_back", "processing"}
TRANSIENT_HTTP = {429, 502, 503, 504}
MAX_REPLY_BYTES = 32 * 1024 * 1024


class CatalogueError(Exception):
    pass


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Api:
    def __init__(self, origin: str, floor: str, token: str):
        address = urlsplit(origin)
        loopback = address.hostname in {"127.0.0.1", "::1", "localhost"}
        if (address.scheme != "https" and not (address.scheme == "http" and loopback)
                or not address.hostname or address.username or address.password or address.query
                or address.fragment or address.path not in {"", "/"}):
            raise CatalogueError("Use a trusted HTTPS Buildcon House origin.")
        self.root = origin.rstrip("/") + "/api/catalog/management"
        self.floor = floor
        self.token = token
        self.opener = build_opener(NoRedirects())

    def request(self, method: str, path: str, payload=None, *, binary=False):
        query = urlencode({"floor_id": self.floor})
        headers = {"Authorization": f"Bearer {self.token}", "x-floor-id": self.floor}
        body = None
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = Request(f"{self.root}{path}?{query}", data=body, headers=headers, method=method)
        for attempt in range(3 if method in {"GET", "PUT"} else 1):
            try:
                with self.opener.open(request, timeout=30) as response:
                    content = response.read(MAX_REPLY_BYTES + 1)
                if len(content) > MAX_REPLY_BYTES:
                    raise CatalogueError("The catalogue response exceeded the supported size.")
                if binary:
                    if not content.startswith(b"PK\x03\x04"):
                        raise CatalogueError("The server did not return an Excel workbook.")
                    return content
                result = json.loads(content)
                if not isinstance(result, dict):
                    raise CatalogueError("The server returned an unexpected catalogue response.")
                return result
            except HTTPError as error:
                if method in {"GET", "PUT"} and error.code in TRANSIENT_HTTP and attempt < 2:
                    delay = error.headers.get("Retry-After", "")
                    time.sleep(min(int(delay), 5) if delay.isdecimal() and len(delay) <= 2 else attempt + 1)
                    continue
                message = None
                try:
                    detail = json.loads(error.read(65536)).get("detail")
                    if isinstance(detail, str):
                        message = detail
                except (ValueError, AttributeError, OSError):
                    pass
                raise CatalogueError(f"HTTP {error.code}" + (f": {clean_message(message)}" if message else "")) from None
            except (URLError, TimeoutError, ConnectionError, http.client.HTTPException):
                if method in {"GET", "PUT"} and attempt < 2:
                    time.sleep(attempt + 1)
                    continue
                raise CatalogueError("The catalogue API connection was interrupted. Check the saved job before retrying a write.") from None
            except (UnicodeError, json.JSONDecodeError):
                raise CatalogueError("The server did not return a catalogue API response.") from None

    def job(self, job_id: str, command: str | None = None):
        path = f"/jobs/{quote(job_id, safe='')}"
        if command:
            return self.request("POST", f"{path}/{command}", {})
        return self.request("GET", path)


def clean_message(value: str) -> str:
    return " ".join(value.split())[:350]


def resolve_brand(api: Api, name: str, options: dict, *, allow_create=False) -> dict:
    brands = options.get("brands")
    if not isinstance(brands, list):
        raise CatalogueError("The API did not return brand choices for this department.")
    matches = [brand for brand in brands if name.casefold() in {
        str(brand.get("name", "")).casefold(), str(brand.get("id", "")).casefold(),
    }]
    if len(matches) > 1:
        raise CatalogueError("More than one brand matched. Use its unique brand ID.")
    if allow_create and (not matches or name.casefold() != str(matches[0]["id"]).casefold()):
        # Keep a name-based retry stable if the first run has since created it.
        return {"brand_name": name, "create_brand": True}
    if matches:
        return {"brand_id": matches[0]["id"]}
    raise CatalogueError(f"No brand matched {name!r} in {api.floor}.")


def wait_for_job(api: Api, job: dict, timeout: int) -> dict:
    deadline = time.monotonic() + timeout
    while job.get("status") in WORKING and time.monotonic() < deadline:
        time.sleep(2)
        job = api.job(job["id"])
    return job


def stable_upload(api: Api, args, options: dict) -> dict:
    path = args.source
    size = path.stat().st_size
    max_size = options.get("max_bytes")
    part_size = options.get("part_bytes")
    if not isinstance(max_size, int) or not isinstance(part_size, int) or not 0 < part_size <= 700 * 1024:
        raise CatalogueError("The catalogue API did not return supported upload limits.")
    if not 0 < size <= max_size:
        raise CatalogueError(f"Source file must be nonempty and at most {max_size / 1024**2:g} MiB.")
    if path.suffix.lower() not in {".xlsx", ".csv", ".pdf"}:
        raise CatalogueError("Use a valid XLSX, UTF-8 CSV or supported text PDF source.")
    payload = {
        **resolve_brand(api, args.brand, options, allow_create=args.create_brand),
        "create_categories": args.create_categories, "operation": args.operation,
        "filename": path.name, "size_bytes": size,
    }
    for field in ("sheet", "physical_pages", "printed_pages"):
        if getattr(args, field) is not None:
            payload[field] = getattr(args, field)
    with path.open("rb") as source:
        digest = sha256()
        for part in iter(lambda: source.read(part_size), b""):
            digest.update(part)
        fingerprint = digest.hexdigest()
        identity = json.dumps([api.root, api.floor, payload, fingerprint], sort_keys=True, ensure_ascii=False)
        payload["key"] = args.key or str(uuid5(NAMESPACE_URL, identity))
        job = api.request("POST", "/jobs", payload)
        job_id = job.get("id")
        if not job_id:
            raise CatalogueError("The catalogue API did not confirm a job ID.")
        if job.get("status") != "upload":
            return job
        source.seek(0)
        uploaded_digest = sha256()
        for offset in range(0, size, part_size):
            part = source.read(min(part_size, size - offset))
            if len(part) != min(part_size, size - offset):
                raise CatalogueError(f"The source changed during upload. Job {job_id} has not been previewed.")
            uploaded_digest.update(part)
            encoded = base64.b64encode(part).decode("ascii")
            api.request("PUT", f"/jobs/{quote(job_id, safe='')}/parts/{offset // part_size}", {"data_base64": encoded})
        if source.read(1) or uploaded_digest.hexdigest() != fingerprint:
            raise CatalogueError(f"The source changed during upload. Job {job_id} has not been previewed.")
        return api.job(job_id, "preview")


def summarize(job: dict) -> dict:
    visible = ("id", "status", "summary", "result", "rollback_result", "missing_from_source_count")
    summary = {key: job[key] for key in visible if key in job}
    if "missing_from_source_total" in job:
        summary["missing_from_source_count"] = job["missing_from_source_total"]
    elif isinstance(job.get("missing_from_source"), list):
        summary.setdefault("missing_from_source_count", len(job["missing_from_source"]))
    if job.get("warnings"):
        summary["warnings"] = [clean_message(str(warning)) for warning in job["warnings"][:6]]
    if job.get("error"):
        summary["error"] = clean_message(str(job["error"]))
    return summary


def save_error_report(api: Api, job: dict, path: Path | None) -> None:
    if path is not None:
        contents = api.request("GET", f"/jobs/{quote(job['id'], safe='')}/errors.xlsx", binary=True)
        with path.open("xb") as output:
            output.write(contents)


def execute(args, api: Api) -> dict:
    if args.command == "category":
        options = api.request("GET", "/options")
        identity = resolve_brand(api, args.brand, options)
        result = api.request("POST", "/categories", {**identity, "name": args.name})
        return {key: result[key] for key in ("id", "name", "brand_id", "floor_id") if key in result}

    if args.command == "import":
        options = api.request("GET", "/options")
        job = wait_for_job(api, stable_upload(api, args, options), args.wait_seconds)
        if job.get("status") == "preview" and args.apply:
            job = wait_for_job(api, api.job(job["id"], "apply"), args.wait_seconds)
    else:
        if args.action:
            job = wait_for_job(api, api.job(args.job_id, args.action), args.wait_seconds)
        else:
            job = api.job(args.job_id)
    save_error_report(api, job, args.errors)
    return summarize(job)


def page_range(value: str) -> list[int]:
    match = re.fullmatch(r"([0-9]{1,5})(?:[-–]([0-9]{1,5}))?", value)
    if not match:
        raise argparse.ArgumentTypeError("Use an inclusive range like 405-427.")
    start, end = int(match[1]), int(match[2] or match[1])
    if end < start:
        raise argparse.ArgumentTypeError("The end page must be at least the start page.")
    return [start, end]


def uuid_key(value: str) -> str:
    try:
        return str(UUID(value))
    except ValueError as exc:
        raise argparse.ArgumentTypeError("Use a UUID.") from exc


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=DEFAULT_URL, help="Trusted Buildcon House application origin.")
    parser.add_argument("--wait-seconds", type=int, default=600, help="Maximum time to poll a submitted phase.")
    subparsers = parser.add_subparsers(dest="command", required=True)
    for name in ("import", "job", "category"):
        command = subparsers.add_parser(name)
        command.add_argument("--floor", required=True, choices=(*FLOORS, *FLOORS.values()))
        if name != "category":
            command.add_argument("--errors", type=Path, help="Save row-level Excel report to a new file.")
        if name in {"import", "category"}:
            command.add_argument("--brand", required=True, help="Exact brand name or ID on this floor.")
        if name == "import":
            command.add_argument("--operation", required=True, choices=OPERATIONS)
            command.add_argument("--create-brand", action="store_true", help="Create the selected brand if missing.")
            command.add_argument("--create-categories", action="store_true", help="Create source categories if missing.")
            command.add_argument("--key", type=uuid_key, help="Use a different UUID for an intentionally new import of identical bytes.")
            command.add_argument("--apply", action="store_true", help="Apply the clean rows from the preview.")
            command.add_argument("--sheet", help="Exact Excel worksheet name.")
            page_modes = command.add_mutually_exclusive_group()
            page_modes.add_argument("--physical-pages", type=page_range, help="One-based PDF file page indexes.")
            page_modes.add_argument("--printed-pages", type=page_range, help="Page numbers printed or explicitly labelled in the PDF.")
            command.add_argument("source", type=Path)
        elif name == "job":
            command.add_argument("job_id")
            actions = command.add_mutually_exclusive_group()
            for action in ("apply", "resume", "rollback"):
                actions.add_argument(f"--{action}", action="store_const", const=action, dest="action")
        else:
            command.add_argument("--name", required=True, help="Exact category label.")
    args = parser.parse_args(argv)
    if args.wait_seconds < 0:
        parser.error("--wait-seconds must be non-negative.")
    if getattr(args, "physical_pages", None) and args.physical_pages[0] < 1:
        parser.error("Physical PDF page indexes start at 1.")
    return args


def main(argv=None) -> int:
    args = parse_args(argv)
    token = os.environ.get("BUILDCON_API_TOKEN", "").strip()
    if not token:
        print("Set BUILDCON_API_TOKEN to an existing authorized Buildcon House staff token.", file=sys.stderr)
        return 2
    floor = FLOORS.get(args.floor, args.floor)
    try:
        result = execute(args, Api(args.url, floor, token))
    except (CatalogueError, OSError) as error:
        # A provider error must never disclose the credential even if an
        # unexpected upstream handler reflects the Authorization header.
        print(str(error).replace(token, "[redacted]"), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")).replace(token, "[redacted]"))
    return 1 if result.get("status") == "failed" else 0


if __name__ == "__main__":
    raise SystemExit(main())
