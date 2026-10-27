"""Forge infrastructure preflight.

Usage:
    python bootstrap.py
    python bootstrap.py --health-url http://127.0.0.1:8001/api/health

The first form validates configuration, MongoDB, Supabase buckets, required
collections, and required indexes. The optional health URL is a post-start check
used by deployment/recovery workflows because an HTTP endpoint cannot be checked
before Uvicorn binds its socket.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
from dataclasses import dataclass, field
from typing import Any

import bcrypt
import httpx
from motor.motor_asyncio import AsyncIOMotorClient

from settings import ConfigurationError, Settings, settings

logger = logging.getLogger("forge.bootstrap")

# Historical, publicly-known demo password (was previously hardcoded in
# seed.py as DEMO_PASSWORD — see BACKEND_AUDIT_2026-07-17.md Critical #1).
# Kept here ONLY to detect accounts still on this value; never used to
# authenticate or to seed anything.
LEGACY_DEMO_PASSWORD = "Forge@2026"


REQUIRED_COLLECTIONS = {
    "brands",
    "categories",
    "customers",
    "followups",
    "notifications",
    "payments",
    "product_media",
    "product_usage",
    "products",
    "purchase_orders",
    "quotations",
    "suppliers",
    "user_sessions",
    "users",
}

# These are existing application indexes, not new optimization proposals.
# Signatures are checked by key pattern so Atlas-generated index names are valid.
REQUIRED_INDEXES: dict[str, list[tuple[tuple[str, Any], ...]]] = {
    "products": [
        (("id", 1),),
        (("sku", 1),),
        (("family_key", 1),),
        (("active", 1), ("brand_id", 1)),
        (("active", 1), ("category_id", 1)),
        (("active", 1), ("name", 1), ("id", 1)),
        (("active", 1), ("price", 1), ("id", 1)),
        (("active", 1), ("price", -1), ("id", 1)),
        (("_fts", "text"), ("_ftsx", 1)),
    ],
    "product_media": [(("product_id", 1),), (("family_key", 1),)],
    "product_usage": [
        (("user_id", 1),),
        (("product_id", 1),),
        (("user_id", 1), ("last_used_at", -1)),
        (("user_id", 1), ("count", -1)),
    ],
    "user_sessions": [(("id", 1),), (("user_type", 1), ("user_id", 1))],
    # Task 17 code-review finding: brands.slug/categories.slug uniqueness is
    # load-bearing for POST /brands and POST /categories (routes/catalog_routes.py)
    # but was never in this startup gate — only ensure_indexes.py (brands) and
    # migrations/0005_add_categories_slug_unique_index.py (categories) created
    # them, with nothing confirming they actually exist on every boot.
    "brands": [(("id", 1),), (("floor_id", 1), ("slug", 1))],
    "categories": [(("id", 1),), (("floor_id", 1), ("slug", 1))],
    # Data Integrity Audit (Phase 2, 2026-08) — duplicate-prevention indexes.
    "users": [(("email", 1),)],
    "quotations": [(("number", 1),)],
    "furniture_quotations": [(("id", 1),), (("floor_id", 1), ("updated_at", -1), ("id", -1))],
    "kitchen_projects": [
        (("id", 1),), (("reference", 1),),
        (("floor_id", 1), ("updated_at", -1), ("id", 1)),
        (("floor_id", 1), ("stage", 1), ("updated_at", -1), ("id", 1)),
        (("floor_id", 1), ("customer_id", 1), ("updated_at", -1), ("id", 1)),
        (("floor_id", 1), ("assigned_to", 1), ("updated_at", -1), ("id", 1)),
        (("floor_id", 1), ("status", 1), ("deadline", 1), ("id", 1)),
        (("floor_id", 1), ("completion_date", 1), ("id", 1)),
    ],
    "whatsapp_deliveries": [(("floor_id", 1), ("source_id", 1), ("idempotency_key", 1)), (("message_id", 1),)],
    "whatsapp_status_events": [(("message_id", 1),)],
    "purchase_orders": [(("number", 1),)],
    # BACKEND_AUDIT_2026-07-17.md High #14/#15, Medium #31 — added alongside
    # ensure_indexes.py so the startup gate actually enforces these instead
    # of only user_sessions/quotations/purchase_orders/users being checked.
    "customers": [(("email", 1),)],
    "payments": [(("quotation_id", 1),)],
    "suppliers": [(("id", 1),)],
    "activity_events": [(("entity_type", 1), ("entity_id", 1), ("created_at", -1))],
}

# A key signature alone cannot prove a uniqueness constraint: Mongo exposes
# both unique and non-unique indexes with the same key pattern.  These are the
# constraints the application relies on for business identity and idempotency.
REQUIRED_UNIQUE_INDEXES: dict[str, list[tuple[tuple[str, Any], ...]]] = {
    "products": [(("floor_id", 1), ("brand_id", 1), ("sku", 1))],
    "brands": [(("floor_id", 1), ("slug", 1))],
    "categories": [(("floor_id", 1), ("slug", 1))],
    "users": [(("email", 1),)],
    "quotations": [(("number", 1),)],
    "furniture_quotations": [(("id", 1),)],
    "kitchen_projects": [(("id", 1),), (("reference", 1),)],
    "whatsapp_deliveries": [(("floor_id", 1), ("source_id", 1), ("idempotency_key", 1)), (("message_id", 1),)],
    "whatsapp_status_events": [(("message_id", 1),)],
    "purchase_orders": [(("number", 1),)],
}

# An ordinary unique email index permits only one account with null/missing
# email. Username-only staff need the exact string-only constraint.
REQUIRED_PARTIAL_UNIQUE_INDEXES = {
    "users": {(("email", 1),): {"email": {"$type": "string"}}},
}


@dataclass
class BootstrapReport:
    checks: dict[str, Any] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)

    @property
    def healthy(self) -> bool:
        return not self.errors

    def require_healthy(self) -> None:
        if self.errors:
            lines = "\n  - ".join(self.errors)
            raise RuntimeError(
                "Forge startup preflight failed:\n  - " + lines +
                "\nSee STARTUP_CHECK.md and RECOVERY.md."
            )

    def to_public_dict(self) -> dict[str, Any]:
        return {"healthy": self.healthy, "checks": self.checks, "errors": self.errors}


def _index_signature(spec: dict[str, Any]) -> tuple[tuple[str, Any], ...]:
    return tuple(
        (str(key), int(value) if isinstance(value, (int, float)) else str(value))
        for key, value in spec.get("key", [])
    )


async def _check_demo_accounts(database: Any) -> list[str]:
    """Detect staff accounts still on the historical, publicly-known demo
    password. Uses bcrypt.checkpw (never a string compare) so only accounts
    that genuinely still match are flagged. Returns the list of matching
    emails — never raises, never added to report.errors: a pre-existing
    credential problem must not crash startup and turn into an outage."""
    from seed import DEMO_STAFF  # local import: avoids a module-level seed<->bootstrap coupling
    from starlette.concurrency import run_in_threadpool

    detected: list[str] = []
    emails = [email for email, _name, _role in DEMO_STAFF]
    docs = await database.users.find(
        {"email": {"$in": emails}}, {"_id": 0, "email": 1, "password_hash": 1},
    ).to_list(len(emails) + 1)
    legacy_bytes = LEGACY_DEMO_PASSWORD.encode("utf-8")
    for doc in docs:
        pw_hash = doc.get("password_hash")
        if not pw_hash:
            continue
        try:
            if await run_in_threadpool(bcrypt.checkpw, legacy_bytes, pw_hash.encode("utf-8")):
                detected.append(doc["email"])
        except (ValueError, TypeError):
            continue
    return detected


async def _check_mongo(cfg: Settings, report: BootstrapReport) -> None:
    client = AsyncIOMotorClient(
        cfg.mongo_url,
        serverSelectionTimeoutMS=8000,
        connectTimeoutMS=8000,
    )
    try:
        await client.admin.command("ping")
        database = client[cfg.db_name]
        existing_collections = set(await database.list_collection_names())
        missing_collections = sorted(REQUIRED_COLLECTIONS - existing_collections)
        report.checks["mongo"] = {
            "connected": True,
            "database": cfg.db_name,
            "required_collections": len(REQUIRED_COLLECTIONS),
            "missing_collections": missing_collections,
        }
        if missing_collections:
            report.errors.append(
                "MongoDB is missing required collections: " + ", ".join(missing_collections)
            )

        missing_indexes: dict[str, list[list[list[Any]]]] = {}
        index_specs: dict[str, dict] = {}
        for collection, expected in REQUIRED_INDEXES.items():
            current = await database[collection].index_information()
            index_specs[collection] = current
            signatures = {_index_signature(spec) for spec in current.values()}
            absent = [sig for sig in expected if sig not in signatures]
            if absent:
                missing_indexes[collection] = [[list(part) for part in sig] for sig in absent]
        report.checks["mongo"]["missing_indexes"] = missing_indexes
        if missing_indexes and report.checks.get("enforce_indexes", True):
            report.errors.append(
                "MongoDB required indexes are missing; review bootstrap output before adding them: "
                + ", ".join(sorted(missing_indexes))
            )

        missing_unique: dict[str, list[list[list[Any]]]] = {}
        for collection, expected in REQUIRED_UNIQUE_INDEXES.items():
            current = index_specs[collection]
            signatures = {
                _index_signature(spec)
                for spec in current.values()
                if spec.get("unique") is True
            }
            absent = [sig for sig in expected if sig not in signatures]
            for signature, partial in REQUIRED_PARTIAL_UNIQUE_INDEXES.get(collection, {}).items():
                valid_partial = any(
                    _index_signature(spec) == signature and spec.get("unique") is True
                    and spec.get("partialFilterExpression") == partial for spec in current.values()
                )
                restrictive_legacy = any(
                    _index_signature(spec) == signature and spec.get("unique") is True
                    and spec.get("partialFilterExpression") != partial for spec in current.values()
                )
                if signature not in absent and (not valid_partial or restrictive_legacy):
                    absent.append(signature)
            if absent:
                missing_unique[collection] = [[list(part) for part in sig] for sig in absent]
        report.checks["mongo"]["missing_unique_indexes"] = missing_unique
        if missing_unique and report.checks.get("enforce_indexes", True):
            report.errors.append(
                "MongoDB required unique indexes are missing or have incompatible options: "
                + ", ".join(sorted(missing_unique))
            )

        # Security (BACKEND_AUDIT_2026-07-17.md Critical #1): report, never crash.
        demo_accounts = await _check_demo_accounts(database)
        report.checks["demo_accounts_detected"] = demo_accounts
        if demo_accounts:
            logger.critical(
                "SECURITY: demo account(s) still have the known default password: %s. "
                "Run `python -m scripts.rotate_demo_credentials --apply` to rotate.",
                ", ".join(demo_accounts),
            )
    except Exception as exc:  # noqa: BLE001
        report.checks["mongo"] = {"connected": False, "database": cfg.db_name}
        report.errors.append(f"MongoDB connection failed: {type(exc).__name__}: {exc}")
    finally:
        client.close()


async def _check_supabase(cfg: Settings, report: BootstrapReport) -> None:
    if cfg.media_storage_driver == "r2":
        from media_storage.r2_driver import R2StorageDriver
        storage = R2StorageDriver(cfg=cfg)
        try:
            await storage.ready()
            report.checks["r2"] = {"connected": True}
        except Exception as exc:
            report.checks["r2"] = {"connected": False}
            report.errors.append(f"R2 readiness failed ({type(exc).__name__})")
        finally:
            await storage.close()
        return
    headers = {
        "apikey": cfg.supabase_service_role_key,
        "Authorization": f"Bearer {cfg.supabase_service_role_key}",
    }
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(f"{cfg.supabase_url}/storage/v1/bucket", headers=headers)
        if response.status_code >= 300:
            raise RuntimeError(f"bucket listing returned HTTP {response.status_code}")
        payload = response.json()
        rows = payload if isinstance(payload, list) else payload.get("data", [])
        bucket_ids = {str(row.get("id") or row.get("name")) for row in rows if isinstance(row, dict)}
        required = {cfg.supabase_public_bucket, cfg.supabase_private_bucket}
        missing = sorted(required - bucket_ids)
        report.checks["supabase"] = {
            "connected": True,
            "required_buckets": sorted(required),
            "missing_buckets": missing,
        }
        if missing:
            report.errors.append("Supabase is missing required buckets: " + ", ".join(missing))
    except Exception as exc:  # noqa: BLE001
        report.checks["supabase"] = {"connected": False}
        report.errors.append(f"Supabase connection failed: {type(exc).__name__}: {exc}")


async def _check_health(health_url: str, report: BootstrapReport) -> None:
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(health_url)
        ok = response.status_code == 200 and response.json().get("status") == "ok"
        report.checks["health_endpoint"] = {"reachable": ok, "status_code": response.status_code}
        if not ok:
            report.errors.append(f"Health endpoint is not ready: {health_url} returned HTTP {response.status_code}")
    except Exception as exc:  # noqa: BLE001
        report.checks["health_endpoint"] = {"reachable": False}
        report.errors.append(f"Health endpoint failed: {type(exc).__name__}: {exc}")


async def run_bootstrap(
    cfg: Settings = settings,
    *,
    health_url: str | None = None,
    enforce_indexes: bool = True,
) -> BootstrapReport:
    report = BootstrapReport(checks={"configuration": cfg.readiness_flags(), "enforce_indexes": enforce_indexes})
    await asyncio.gather(_check_mongo(cfg, report), _check_supabase(cfg, report))
    if health_url:
        await _check_health(health_url, report)
    return report


async def _main() -> int:
    parser = argparse.ArgumentParser(description="Validate Forge production infrastructure")
    parser.add_argument("--health-url", help="Optional post-start /api/health URL")
    args = parser.parse_args()
    report = await run_bootstrap(health_url=args.health_url)
    print(json.dumps(report.to_public_dict(), indent=2))
    return 0 if report.healthy else 1


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(_main()))
    except ConfigurationError as exc:
        print(json.dumps({"healthy": False, "checks": {"configuration": False}, "errors": [str(exc)]}, indent=2))
        raise SystemExit(2) from exc
