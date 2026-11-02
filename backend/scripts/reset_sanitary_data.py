"""Preview or run the one-time sanitary reset on the explicitly named database."""
import argparse
import asyncio
import json

from db import client, db
from media_storage.factory import get_media_storage
from media_storage.supabase_driver import SupabaseStorageDriver, supabase_ready
from services.sanitary_data_reset import apply_reset, cleanup_files, make_plan


async def run(args):
    if args.database != db.name:
        raise ValueError("--database must match the configured database")
    if args.apply:
        receipt = await apply_reset(db, client)
        return {"deleted": receipt["deleted"], "pending_files": len(receipt.get("pending_files", []))}
    if args.cleanup:
        try:
            await supabase_ready()
            legacy = SupabaseStorageDriver()
        except Exception:
            class Unavailable:
                async def delete(self, **kwargs):
                    raise RuntimeError("Legacy storage unavailable")
            legacy = Unavailable()
        failed = await cleanup_files(db, {"current": get_media_storage(), "legacy": legacy})
        return {"failed_files": failed}
    plan = await make_plan(db)
    return {"counts": plan["counts"], "files": len(plan["files"])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", required=True)
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--apply", action="store_true")
    action.add_argument("--cleanup", action="store_true")
    try:
        print(json.dumps(asyncio.run(run(parser.parse_args())), sort_keys=True))
    finally:
        client.close()


if __name__ == "__main__":
    main()
