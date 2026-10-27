"""Explicit operator cleanup for the 26 October 2026 customer/stock request.

Preview is read-only. Apply requires the preview fingerprint, exact live database
name, an exclusive writer admission and a new private full-database backup.
Historical stock lots remain archived, preserving physical movement evidence.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path

from bson import json_util

FLOORS = ("ground-floor", "first-floor")
REQUEST = "floor-customers-stock-cleanup-20261026"
ACTOR = "operator:user-authorized-20261026"


def check_boundaries(plan):
    for collection in ("customers", "quotations", "customer_orders", "furniture_quotations", "kitchen_projects"):
        for row in plan["delete"].get(collection, []):
            if collection in {"furniture_quotations", "kitchen_projects"} or row.get("floor_id") not in FLOORS:
                raise RuntimeError("Cleanup would affect another floor; review linked customer identities first")


def fingerprint(value):
    return hashlib.sha256(json_util.dumps(value, sort_keys=True).encode()).hexdigest()


async def preview(database):
    from services.customer_deletion import plan_deletion, _snapshot_token

    customers = await database.customers.find({"floor_id": {"$in": list(FLOORS)}}).sort("id", 1).to_list(1001)
    if len(customers) > 1000:
        raise RuntimeError("Unexpected customer volume")
    stocks = await database.godown_stock.find({"archived": {"$ne": True}}).sort("id", 1).to_list(10001)
    if len(stocks) > 10000:
        raise RuntimeError("Unexpected stock volume")
    semaphore = asyncio.Semaphore(6)

    async def inspect(customer):
        async with semaphore:
            plan = await plan_deletion(database, customer_id=customer["id"])
            check_boundaries(plan)
            return {"customer_id": customer["id"], "token": _snapshot_token(plan, ACTOR),
                    "counts": {name: len(rows) for name, rows in plan["delete"].items() if rows}}

    graphs = await asyncio.gather(*(inspect(customer) for customer in customers))
    bound = {"database": database.name, "customers": customers, "stocks": stocks, "graphs": graphs}
    return {"request_id": REQUEST, "database": database.name, "floors": list(FLOORS),
            "customers": {floor: sum(row.get("floor_id") == floor for row in customers) for floor in FLOORS},
            "active_stock_lots": len(stocks), "confirmation": fingerprint(bound)}, graphs


async def protected_floor_snapshot(database):
    snapshot = {}
    for name in sorted(await database.list_collection_names()):
        if name.startswith("system."):
            continue
        rows = await database[name].find({"floor_id": {"$in": ["second-floor", "third-floor"]}}).sort("_id", 1).to_list(50001)
        if len(rows) > 50000:
            raise RuntimeError("Protected floor snapshot exceeded its verification bound")
        if rows:
            snapshot[name] = {"rows": len(rows), "sha256": fingerprint(rows)}
    return snapshot


def verify_backup(directory, manifest):
    for name, expected in manifest["collections"].items():
        payload = (Path(directory) / (name + ".jsonl")).read_bytes()
        if hashlib.sha256(payload).hexdigest() != expected["sha256"] or len(payload.splitlines()) != expected["rows"]:
            raise RuntimeError("Private backup verification failed")


async def backup_database(database, directory):
    directory = Path(directory)
    directory.mkdir(mode=0o700, parents=False, exist_ok=False)
    os.chmod(directory, 0o700)
    manifest = {"database": database.name, "request_id": REQUEST, "collections": {}}
    for name in sorted(await database.list_collection_names()):
        if name.startswith("system."):
            continue
        target = directory / (name + ".jsonl")
        count = 0
        digest = hashlib.sha256()
        with target.open("xb") as output:
            os.chmod(target, 0o600)
            async for row in database[name].find({}):
                line = (json_util.dumps(row) + "\n").encode()
                output.write(line)
                digest.update(line)
                count += 1
            output.flush()
            os.fsync(output.fileno())
        manifest["collections"][name] = {"rows": count, "sha256": digest.hexdigest()}
    target = directory / "manifest.json"
    target.write_text(json.dumps(manifest, indent=2) + "\n")
    os.chmod(target, 0o600)
    return manifest


async def execute(database, client, *, confirmation, backup_dir):
    from models import now_iso
    from services.customer_deletion import delete_customer_graph, plan_deletion, _snapshot_token
    from services.mutation_admission import admission

    async with admission(database, exclusive=True):
        current, graphs = await preview(database)
        if current["confirmation"] != confirmation:
            raise RuntimeError("Customer or stock data changed; inspect a fresh preview")
        preserved = await protected_floor_snapshot(database)
        manifest = await backup_database(database, backup_dir)
        verify_backup(backup_dir, manifest)
        progress = {"request_id": REQUEST, "before": current, "backup_collections": len(manifest["collections"]),
                    "deleted_customer_graphs": 0, "completed": False, "protected_floors_before": preserved}
        journal = Path(backup_dir) / "cleanup-result.json"

        def save():
            journal.write_text(json.dumps(progress, indent=2) + "\n")
            os.chmod(journal, 0o600)

        save()
        for graph in graphs:
            # A previous graph may have removed a linked profile in this list.
            if not await database.customers.find_one({"id": graph["customer_id"]}):
                continue
            plan = await plan_deletion(database, customer_id=graph["customer_id"])
            check_boundaries(plan)
            await delete_customer_graph(database, client, graph["customer_id"], ACTOR, _snapshot_token(plan, ACTOR))
            progress["deleted_customer_graphs"] += 1
            save()
            print(json.dumps({"deleted_customer_graphs": progress["deleted_customer_graphs"]}), flush=True)
        # Clearing inventory means excluding every active lot from reads and
        # allocations, while retaining immutable receipt/movement evidence.
        archived = await database.godown_stock.update_many({"archived": {"$ne": True}},
            {"$set": {"archived": True, "archived_at": now_iso(), "archive_reason": REQUEST}})
        progress["archived_stock_lots"] = archived.modified_count
        progress["after"] = {"customers": await database.customers.count_documents({"floor_id": {"$in": list(FLOORS)}}),
                             "active_stock_lots": await database.godown_stock.count_documents({"archived": {"$ne": True}})}
        if any(progress["after"].values()):
            raise RuntimeError("Cleanup readback is not empty; inspect the private journal")
        progress["protected_floors_after"] = await protected_floor_snapshot(database)
        if progress["protected_floors_after"] != preserved:
            save()
            raise RuntimeError("Protected Kitchen/Furniture data changed; inspect the private backup")
        progress["completed"] = True
        await database.settings.insert_one({"id": REQUEST, "kind": "operator_cleanup_receipt", "completed_at": now_iso(),
            "actor_id": ACTOR, "customers_before": current["customers"], "archived_stock_lots": archived.modified_count})
        save()
        return progress


async def main(args):
    from dotenv import load_dotenv
    load_dotenv(args.env_file, override=False)
    from db import client, db
    if db.name != "buildcon_house":
        raise RuntimeError("This request is bound to buildcon_house")
    try:
        if args.apply:
            if not args.confirmation or not args.backup_dir:
                raise RuntimeError("Apply requires --confirmation and --backup-dir")
            result = await execute(db, client, confirmation=args.confirmation, backup_dir=args.backup_dir)
        else:
            result, _ = await preview(db)
        print(json.dumps(result, indent=2))
    finally:
        client.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--confirmation")
    parser.add_argument("--backup-dir")
    asyncio.run(main(parser.parse_args()))
