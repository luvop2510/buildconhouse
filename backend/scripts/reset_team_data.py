"""Preview/reset accounts deliberately; never print or accept plaintext as an argv.

python -m scripts.reset_team_data
python -m scripts.reset_team_data --apply --confirm-database buildcon_house --expected-users 14

Apply requires the maintenance env flag and FORGE_OWNER_RESET_PASSWORD supplied
privately by the operator. Backup first; all deployed writers must be paused.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os

from db import client, db
from services.team_data_reset import REQUEST_ID, reset_team_data, team_reset_preview


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--apply", action="store_true")
    result.add_argument("--confirm-database")
    result.add_argument("--expected-users", type=int)
    result.add_argument("--request-id", default=REQUEST_ID)
    return result


async def run(args) -> dict:
    if not args.apply:
        return await team_reset_preview(db)
    if args.confirm_database != db.name or args.expected_users is None or args.expected_users < 0:
        raise ValueError("Apply requires --confirm-database matching DB_NAME and --expected-users from preview")
    password = os.environ.get("FORGE_OWNER_RESET_PASSWORD", "")
    if not password:
        raise ValueError("FORGE_OWNER_RESET_PASSWORD is required privately for apply")
    return await reset_team_data(db, client, request_id=args.request_id,
        owner_password=password, expected_user_count=args.expected_users)


def main() -> None:
    try:
        result = asyncio.run(run(parser().parse_args()))
        print(json.dumps(result, indent=2))
    finally:
        client.close()


if __name__ == "__main__":
    main()
