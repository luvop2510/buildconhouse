"""Read-only kitchen inventory on an explicitly selected local database copy.

This deliberately proposes no stage mapping and writes no business records.
Run with --mongo-url mongodb://127.0.0.1:<port> --database <isolated-copy>.
Default output contains aggregate counts only, never customer/contact rows or
secrets. --preview-output writes a private identifier/evidence review file;
stdout still contains only aggregate counts and fingerprints. No import path.
"""
from __future__ import annotations

import argparse
import asyncio
from collections import Counter
from datetime import date
from decimal import Decimal, InvalidOperation
import hashlib
import json
import os
from pathlib import Path
import re
from urllib.parse import urlsplit

from motor.motor_asyncio import AsyncIOMotorClient

KITCHEN_FLOOR = "second-floor"
STAGES = {"lead", "visit", "cad", "design", "quotation", "order", "production", "installation", "completed"}
LEGACY_SOURCES = ("project_followups", "followups", "walkins")
DATE_FIELDS = ("lead_date", "visit_date", "presentation_date", "received_date", "order_date",
               "production_start_date", "production_completion_date", "installation_start_date",
               "installation_completion_date", "completion_date")
COUNT_FIELDS = ("design_revision_count", "site_visit_count")


def isolated_source(url: str, database: str) -> None:
    parsed = urlsplit(url)
    # One literal loopback endpoint only; disallow replica host lists and URI
    # options that could redirect discovery to a remote production member.
    if (parsed.scheme != "mongodb" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
            or parsed.username or parsed.password or "," in parsed.netloc
            or parsed.path not in {"", "/"} or parsed.query or parsed.fragment):
        raise ValueError("Select a single loopback Mongo endpoint without credentials or options")
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_\-]{0,62}", database) or database in {"admin", "config", "local", "buildcon_house", "buildcon"}:
        raise ValueError("Select an isolated copied/test database, never a production/system name")


async def inventory(database) -> dict:
    """Inspect known sources without creating collections or assigning policy."""
    sources = {}
    for name, selector in (
        ("project_followups", {"floor_id": KITCHEN_FLOOR}),
        ("followups", {"floor_id": KITCHEN_FLOOR}),
        ("walkins", {"floor_id": KITCHEN_FLOOR}),
        ("kitchen_projects", {"floor_id": KITCHEN_FLOOR}),
    ):
        statuses, stages, issues = Counter(), Counter(), Counter()
        customer_ids, references = set(), set()
        rows = 0
        # Explicit projection prevents sensitive legacy fields from reaching
        # diagnostics; raw labels are grouped into a finite vocabulary below.
        cursor = database[name].find(selector, {
            "_id": 0, "id": 1, "customer_id": 1, "reference": 1,
            "stage": 1, "status": 1, "is_converted": 1,
        })
        async for row in cursor:
            rows += 1
            status = row.get("status")
            statuses[status if status in {"new", "pending", "won", "lost", "open", "done", "dismissed"} else "other_or_missing"] += 1
            stage = row.get("stage")
            stages[stage if stage in STAGES else "unknown"] += 1
            customer_id = row.get("customer_id")
            if not isinstance(customer_id, str) or not customer_id:
                issues["missing_customer_link"] += 1
            else:
                customer_ids.add(customer_id)
                customer = await database.customers.find_one({"id": customer_id, "floor_id": KITCHEN_FLOOR}, {"_id": 1})
                if not customer:
                    issues["missing_or_cross_floor_customer"] += 1
            reference = row.get("reference")
            if name == "kitchen_projects":
                if not reference:
                    issues["missing_reference"] += 1
                elif reference in references:
                    issues["duplicate_reference"] += 1
                else:
                    references.add(reference)
                if stage not in STAGES:
                    issues["unknown_project_stage"] += 1
            else:
                # A notebook outcome/converted flag does not prove a design,
                # quote, confirmed order, installation or event counter.
                issues["requires_owner_stage_history_mapping"] += 1
        sources[name] = {"rows": rows, "linked_customers": len(customer_ids),
                         "statuses": dict(sorted(statuses.items())),
                         "stages": dict(sorted(stages.items())),
                         "review_counts": dict(sorted(issues.items()))}
    return {"format": 1, "mode": "read_only_inventory", "floor_id": KITCHEN_FLOOR,
            "sources": sources, "migration_applied": False,
            "legacy_mapping": "unresolved; no inferred projects, approvals, amounts or event counts",
            "release_gate": "Owner must reconcile an authorized source copy before production migration"}


def mapping_entries(mapping: dict | None) -> dict:
    """A preview mapping is evidence for review, never import authorization."""
    if mapping is None:
        return {}
    if not isinstance(mapping, dict) or set(mapping) - {"entries"} or not isinstance(mapping.get("entries"), dict):
        raise ValueError("Mapping must contain an entries object")
    for key, item in mapping["entries"].items():
        if not isinstance(key, str) or not isinstance(item, dict) or set(item) - {"stage", "evidence", "counter_evidence"}:
            raise ValueError("Invalid mapping entry")
        if item.get("stage") not in STAGES or not isinstance(item.get("evidence"), str) or not item["evidence"].strip():
            raise ValueError("A mapped stage requires an explicit stage and supporting evidence")
        counters = item.get("counter_evidence", {})
        if not isinstance(counters, dict) or set(counters) - set(COUNT_FIELDS):
            raise ValueError("Invalid historical counter evidence")
        if any(not isinstance(value, str) or not value.strip() for value in counters.values()):
            raise ValueError("Historical counter evidence must explain its source")
    return mapping["entries"]


def known_date(value):
    # A record's creation timestamp is not evidence of any business-stage date.
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return None
    try:
        date.fromisoformat(value)
    except ValueError:
        return None
    return value


def known_money(value):
    if not isinstance(value, (str, int)) or isinstance(value, bool):
        return None
    try:
        amount = Decimal(str(value))
        if not amount.is_finite() or amount < 0 or amount > Decimal("999999999999.99"):
            return None
        rounded = amount.quantize(Decimal("0.01"))
        return format(rounded, ".2f") if amount == rounded else None
    except (InvalidOperation, ValueError):
        return None


async def preview(database, mapping: dict | None = None) -> dict:
    """Build a private, non-executable migration preview. Never infer history.

    Contact fields, free-text notes, credentials and file capabilities are not
    selected or included. A stage/outcome label alone does not establish a
    kitchen lifecycle stage, approval, monetary order or historical counter.
    """
    entries = mapping_entries(mapping)
    rows, unresolved, fingerprint_rows, seen_keys = [], [], [], set()
    fields = {"_id": 1, "id": 1, "reference": 1, "customer_id": 1, "stage": 1,
              "status": 1, "order_amount": 1, "historical_count_evidence": 1,
              **{field: 1 for field in (*DATE_FIELDS, *COUNT_FIELDS)}}
    for name in LEGACY_SOURCES:
        async for source in database[name].find({"floor_id": KITCHEN_FLOOR}, fields):
            identifier = source.get("id") or source.get("_id")
            identifier = str(identifier) if identifier is not None else None
            key = f"{name}:{identifier}" if identifier else f"{name}:missing-identity"
            issues = []
            if not identifier:
                issues.append("missing_source_identity")
            if key in seen_keys:
                issues.append("duplicate_source_identity")
            seen_keys.add(key)
            decision = entries.get(key, {})
            customer_id = source.get("customer_id")
            customer = (await database.customers.find_one({"id": customer_id, "floor_id": KITCHEN_FLOOR}, {"_id": 1})
                        if isinstance(customer_id, str) and customer_id else None)
            if not customer:
                issues.append("missing_or_cross_floor_customer")
            stage = decision.get("stage")
            if stage is None:
                issues.append("stage_requires_owner_evidence")
            dates = {field: known_date(source.get(field)) for field in DATE_FIELDS}
            for field in DATE_FIELDS:
                if source.get(field) is not None and dates[field] is None:
                    issues.append(f"invalid_or_unsupported_{field}")
            counts = {}
            provenance = source.get("historical_count_evidence")
            provenance = provenance if isinstance(provenance, dict) else {}
            for field in COUNT_FIELDS:
                value = source.get(field)
                evidence = decision.get("counter_evidence", {}).get(field) or provenance.get(field)
                proved = (type(value) is int and value >= 0 and isinstance(evidence, str) and bool(evidence.strip()))
                counts[field] = value if proved else None
                if not proved:
                    issues.append(f"historical_{field}_unavailable")
            candidate = {"is_legacy": True, "source_reference": key,
                         "customer_id": customer_id if customer else None, "stage": stage,
                         "dates": dates, **counts,
                         "counter_labels": {field: "Historical count unavailable" if value is None else str(value)
                                            for field, value in counts.items()},
                         "known_order_amount": known_money(source.get("order_amount")),
                         "order_confirmation": "unverified; never inferred from Won or a monetary field"}
            row = {"source_key": key, "source_id": identifier, "source_reference": source.get("reference"),
                   "customer_id": customer_id, "candidate": candidate,
                   "mapping_evidence": decision.get("evidence"), "review_required": True,
                   "unresolved_codes": sorted(set(issues))}
            rows.append(row)
            # Fingerprint only the same explicitly selected source fields.
            fingerprint_rows.append({"collection": name, "source": source})
            unresolved.extend({"source_key": key, "code": code} for code in row["unresolved_codes"])
    unknown_keys = set(entries) - seen_keys
    if unknown_keys:
        raise ValueError("Mapping contains source keys absent from this selected source copy")
    rows.sort(key=lambda row: row["source_key"])
    canonical = lambda value: json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)
    fingerprint_rows.sort(key=canonical)
    return {"format": 2, "mode": "read_only_migration_preview", "decision_contract": "2026-10-20",
            "floor_id": KITCHEN_FLOOR, "source_database": database.name,
            "source_fingerprint": hashlib.sha256(canonical(fingerprint_rows).encode()).hexdigest(),
            "source_fingerprint_scope": "Selected identifier/date/counter/order fields only; not a full source backup fingerprint",
            "source_fingerprint_fields": sorted(fields),
            "mapping_fingerprint": hashlib.sha256(canonical(entries).encode()).hexdigest(),
            "rows": rows, "unresolved_items": sorted(unresolved, key=lambda item: (item["source_key"], item["code"])),
            "summary": {"source_rows": len(rows), "stage_mapped": sum(row["candidate"]["stage"] is not None for row in rows),
                        "rows_requiring_review": len(rows), "unresolved_items": len(unresolved)},
            "migration_applied": False, "import_authorized": False,
            "notice": "Non-executable preview only. Preserve the original private source snapshot as authoritative for all fields and documents. Owner review, full snapshot binding and separately authorized import required; no business records written."}


def write_private_preview(path: Path, result: dict) -> None:
    data = (json.dumps(result, indent=2, sort_keys=True, default=str) + "\n").encode()
    # Never overwrite an existing file or follow an output symlink.
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(data)


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mongo-url", required=True)
    parser.add_argument("--database", required=True)
    parser.add_argument("--preview-output", type=Path, help="Create a new private JSON preview; never imports records")
    parser.add_argument("--mapping-json", type=Path, help="Explicit source-key/stage/evidence mapping for preview only")
    args = parser.parse_args()
    isolated_source(args.mongo_url, args.database)
    if args.mapping_json and not args.preview_output:
        parser.error("--mapping-json requires --preview-output")
    mapping = json.loads(args.mapping_json.read_text()) if args.mapping_json else None
    mapping_entries(mapping)
    client = AsyncIOMotorClient(args.mongo_url, serverSelectionTimeoutMS=5000)
    try:
        if args.preview_output:
            result = await preview(client[args.database], mapping)
            write_private_preview(args.preview_output, result)
            print(json.dumps({"mode": result["mode"], "source_fingerprint": result["source_fingerprint"],
                              "summary": result["summary"], "migration_applied": False, "import_authorized": False}))
        else:
            print(json.dumps(await inventory(client[args.database]), indent=2, sort_keys=True))
    finally:
        client.close()


if __name__ == "__main__":
    asyncio.run(main())
