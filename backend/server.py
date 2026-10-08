"""Forge backend entrypoint. Wires routes and boots demo data on first run."""
import asyncio
import logging
import os
from contextlib import asynccontextmanager
from time import monotonic
from typing import Any

from fastapi import APIRouter, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.middleware.cors import CORSMiddleware
from starlette.middleware.gzip import GZipMiddleware

from middleware import SecurityHeadersMiddleware
from services.request_limits import RequestBodyLimitMiddleware

from bootstrap import LEGACY_DEMO_PASSWORD, _check_demo_accounts, run_bootstrap
from settings import settings
from services.monitoring import (
    init_monitoring,
    record_request_timing,
    request_timing_enabled,
)
from media_storage import get_media_storage

from db import client, db  # noqa: E402
from routes.auth_routes import router as auth_router  # noqa: E402
from routes.dashboard_routes import router as dashboard_router  # noqa: E402
from routes.catalog_routes import router as catalog_router  # noqa: E402
from routes.catalog_import_routes import router as catalog_import_router  # noqa: E402
from routes.customer_routes import router as customer_router  # noqa: E402
from routes.po_final_routes import router as po_final_router  # noqa: E402
from routes.quotation_routes import router as quotation_router  # noqa: E402
from routes.misc_routes import router as misc_router  # noqa: E402
from routes.media_routes import router as media_router  # noqa: E402
from routes.supplier_routes import router as supplier_router  # noqa: E402
from routes.purchase_routes import router as purchase_router  # noqa: E402
from routes.purchases_tracker import router as purchases_tracker_router  # noqa: E402
from routes.payment_routes import router as payment_router  # noqa: E402
from routes.activity_routes import router as activity_router  # noqa: E402
from routes.followup_routes import router as followup_router  # noqa: E402
from routes.settings_routes import router as settings_router  # noqa: E402
from routes.roles_routes import router as roles_router  # noqa: E402
from routes.permissions_routes import router as permissions_router  # noqa: E402
from routes.access_grants_routes import router as access_grants_router  # noqa: E402
from auth import decode_token, get_current_user, revoke_all_sessions, verify_password  # noqa: E402
from services.access_grants import ensure_access_grant_indexes  # noqa: E402
from routes.referrer_routes import router as referrer_router  # noqa: E402
from routes.sales_data_routes import router as sales_data_router  # noqa: E402
from routes.executive_analytics_routes import router as executive_analytics_router  # noqa: E402
from routes.analytics_settings_routes import router as analytics_settings_router  # noqa: E402
from routes.executive_overview_routes import router as executive_overview_router  # noqa: E402
from routes.sales_performance_routes import router as sales_performance_router  # noqa: E402
from routes.referral_analytics_routes import router as referral_analytics_router  # noqa: E402
from routes.sales_breakdown_routes import router as sales_breakdown_router  # noqa: E402
from routes.sales_workspace_routes import router as sales_workspace_router  # noqa: E402
from routes.tile_orders import router as tile_orders_router  # noqa: E402
from routes.walkin_routes import router as walkin_router  # noqa: E402
from routes.godown_stock_routes import ensure_godown_stock_indexes, router as godown_stock_router  # noqa: E402
from routes.page_export_routes import router as page_export_router  # noqa: E402
from seed import resync_catalog_if_needed, seed_if_empty  # noqa: E402
from services import catalog_service  # noqa: E402
from services.domain_outbox import dispatch_pending, ensure_outbox_indexes, outbox_worker  # noqa: E402
from services.transfer_workflow import ensure_transfer_indexes  # noqa: E402
from services.download_tokens import ensure_download_token_indexes  # noqa: E402
from services.tile_order_indexes import ensure_tile_order_indexes  # noqa: E402
from migrations.runner import pending_migrations, run_migrations  # noqa: E402
from services.followup_engine import reconcile_followups  # noqa: E402
from services.floor_scope import ensure_floor_scope  # noqa: E402


# A non-sensitive marker used by the public health probe to verify that the
# deployed service includes the current quotation-PDF renderer behaviour.
PDF_RENDERER_REVISION = "po-final-quotation-layout-v1"

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s :: %(message)s")
logger = logging.getLogger("forge")

# Monitoring (Sentry) — complete no-op until SENTRY_DSN
# are set (see services/monitoring.py + backend/.env.example). Called before app
# construction so an unhandled exception anywhere downstream is captured.
_monitoring_status = init_monitoring()


async def _run_optional_startup_task(name: str, operation) -> None:
    """Run reconciliation after readiness without making boot availability depend on it."""
    await asyncio.sleep(0)
    try:
        await operation()
        logger.info("Optional startup task completed: %s", name)
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 — reconciliation must not take down the API
        logger.warning("Optional startup task failed (%s): %s", name, exc)


async def _seed_automation_rules() -> None:
    # Keep even an optional-module import out of the readiness critical path.
    from services.automation_rules import ensure_seeded
    await ensure_seeded()


_CREDENTIAL_SCAN_BATCH_SIZE = 100


async def _revoke_published_default_sessions() -> None:
    """Scan every account at runtime without retaining hash sets or blocking the loop.

    Keyset pagination bounds memory; one off-thread bcrypt comparison at a
    time bounds CPU concurrency. Account names and credential values never
    enter diagnostics. This deliberately does not mutate preflight helpers
    or passwords and also covers renamed staff and customer portal accounts.
    """
    revoked_accounts = 0
    for kind, collection_name in (("staff", "users"), ("customer", "customers")):
        last_id = None
        while True:
            query = {"password_hash": {"$exists": True}, "id": {"$type": "string"}}
            if last_id is not None:
                query["id"]["$gt"] = last_id
            accounts = await getattr(db, collection_name).find(
                query, {"_id": 0, "id": 1, "password_hash": 1},
            ).sort("id", 1).limit(_CREDENTIAL_SCAN_BATCH_SIZE).to_list(_CREDENTIAL_SCAN_BATCH_SIZE)
            if not accounts:
                break
            for account in accounts:
                if await asyncio.to_thread(verify_password, LEGACY_DEMO_PASSWORD, account.get("password_hash", "")):
                    await revoke_all_sessions(kind, account["id"])
                    revoked_accounts += 1
            last_id = accounts[-1]["id"]
    if revoked_accounts:
        logger.warning("Revoked sessions for %d account(s) using the published default credential", revoked_accounts)

async def _startup(app: FastAPI) -> None:
    """Run readiness work that must finish before accepting requests."""
    preflight = await run_bootstrap(enforce_indexes=False)
    preflight.require_healthy()

    # Automatic production migrations can turn one duplicate/index conflict
    # into a crash loop on every replica restart. Operators run the preflight
    # and migration job deliberately; an explicit one-replica opt-in remains.
    auto_migrate = settings.environment != "production" or os.environ.get("FORGE_RUN_STARTUP_MIGRATIONS", "").lower() == "true"
    pending = await pending_migrations(db)
    app.state.pending_migrations = pending
    if auto_migrate:
        applied = await run_migrations(db)
        app.state.pending_migrations = []
        if applied:
            logger.info("Applied %d migration(s) on startup: %s", len(applied), ", ".join(applied))
    elif pending:
        logger.critical(
            "Pending migrations (%s); production startup will not apply them automatically. "
            "Run the controlled migration preflight/job in OPERATOR_CHECKLIST.md.",
            ", ".join(pending),
        )

    preflight = await run_bootstrap()
    preflight.require_healthy()
    _cache_demo_check_from_bootstrap(preflight.checks)
    await _revoke_published_default_sessions()
    await ensure_floor_scope()
    await seed_if_empty()
    await resync_catalog_if_needed()
    await ensure_outbox_indexes()
    await ensure_tile_order_indexes()
    await ensure_godown_stock_indexes()
    await ensure_transfer_indexes()
    await ensure_download_token_indexes()
    await ensure_access_grant_indexes(db)
    await dispatch_pending()
    app.state.outbox_worker = asyncio.create_task(outbox_worker())
    snapshot = await catalog_service.refresh_catalog_snapshot()
    logger.info("Catalog read model ready: %d products.", len(snapshot.products))
    app.state.optional_startup_tasks = [
        asyncio.create_task(_run_optional_startup_task("automation-rule seed", _seed_automation_rules)),
        asyncio.create_task(_run_optional_startup_task("follow-up reconciliation", reconcile_followups)),
    ]
    logger.info("Forge API ready; infrastructure preflight passed.")
    logger.info("Monitoring status: sentry=%s", _monitoring_status["sentry"])


async def _shutdown_resources(app: FastAPI) -> None:
    """Release resources created during startup, including partial startup."""
    worker = getattr(app.state, "outbox_worker", None)
    if worker:
        worker.cancel()
        try:
            await worker
        except asyncio.CancelledError:
            pass
    for task in getattr(app.state, "optional_startup_tasks", []):
        task.cancel()
    for task in getattr(app.state, "optional_startup_tasks", []):
        try:
            await task
        except asyncio.CancelledError:
            pass
    storage = get_media_storage()
    close_storage = getattr(storage, "close", None)
    if close_storage:
        await close_storage()
    client.close()
    logger.info("Forge API shutting down.")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Own startup/shutdown work in one lifecycle boundary.

    Cleanup also runs if readiness fails before reaching ``yield``.
    """
    try:
        await _startup(app)
        yield
    finally:
        await _shutdown_resources(app)


app = FastAPI(title="Forge API", version="0.1.0", lifespan=lifespan)
api = APIRouter(prefix="/api")


@app.middleware("http")
async def record_api_request_timing(request: Request, call_next):
    """Emit bounded, PII-safe latency telemetry without affecting responses.

    The timer covers middleware plus endpoint execution.  It intentionally
    uses the matched route template after dispatch, never a raw path/query,
    and only adds the response header for API calls so static/media responses
    retain their existing cache behaviour.
    """
    if not request_timing_enabled() or not request.url.path.startswith("/api/"):
        return await call_next(request)

    started_at = monotonic()
    response = None
    try:
        response = await call_next(request)
        return response
    finally:
        route = request.scope.get("route")
        route_path = getattr(route, "path", None) or "<unmatched>"
        status_code = response.status_code if response is not None else 500
        duration_ms = record_request_timing(
            method=request.method,
            path=route_path,
            status_code=status_code,
            started_at=started_at,
        )
        if response is not None:
            response.headers["Server-Timing"] = f'app;dur={duration_ms:.1f}'


@app.middleware("http")
async def enforce_access_profile(request: Request, call_next):
    """Apply a fail-closed API allow-list before any restricted route runs."""
    if request.method == "OPTIONS" or not request.url.path.startswith("/api/"):
        return await call_next(request)
    authorization = request.headers.get("authorization", "")
    if not authorization.lower().startswith("bearer "):
        return await call_next(request)
    try:
        token = decode_token(authorization.split(" ", 1)[1].strip())
    except Exception:
        # Route dependencies supply the canonical authentication response.
        return await call_next(request)
    if token.get("kind") == "staff":
        # Current principal state is authoritative; token claims may predate
        # a changed profile/custom allocation. The dependency also applies
        # this policy when a browser redeems a download token without Bearer.
        try:
            await get_current_user(request=request, authorization=authorization,
                                   x_floor_id=request.headers.get("x-floor-id"), dl=None)
        except HTTPException as exc:
            return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
    return await call_next(request)

# TTL-cached demo-account detection for /api/health — reuses the same
# lazy-refresh idiom as auth.py's principal cache. bcrypt is deliberately
# slow, so this must not run on every health poll; re-checking at most every
# 10 minutes still lets the "degraded" status self-clear soon after a real
# credential rotation, without needing a restart.
_DEMO_CHECK_TTL_SECONDS = 600.0
_demo_check_cache: dict[str, Any] = {"checked_at": None, "emails": []}


async def _demo_accounts_detected() -> list[str]:
    checked_at = _demo_check_cache["checked_at"]
    if checked_at is None or monotonic() - checked_at > _DEMO_CHECK_TTL_SECONDS:
        try:
            _demo_check_cache["emails"] = await _check_demo_accounts(db)
        except Exception as e:  # noqa: BLE001 — health checks must never crash on this
            logger.warning("Demo-account health re-check failed: %s", e)
        _demo_check_cache["checked_at"] = monotonic()
    return _demo_check_cache["emails"]


def _cache_demo_check_from_bootstrap(checks: dict[str, Any]) -> None:
    """Reuse startup's bcrypt-based demo-account result for health probes.

    ``run_bootstrap`` already performs this same security check before the
    process can become ready. Repeating several deliberately slow bcrypt calls
    on the first `/health` request adds avoidable cold-path latency, while
    retaining the ten-minute refresh preserves detection after startup.
    """
    detected = checks.get("demo_accounts_detected")
    if isinstance(detected, list) and all(isinstance(email, str) for email in detected):
        _demo_check_cache["emails"] = detected
        _demo_check_cache["checked_at"] = monotonic()


@api.get("/")
async def root():
    return {"name": "Forge API", "version": "0.1.0", "status": "ok"}


@api.get("/health")
async def health():
    try:
        await db.command("ping")
    except Exception:  # noqa: BLE001
        return JSONResponse(status_code=503, content={"status": "error", "detail": "database unavailable"})

    demo_accounts = await _demo_accounts_detected()
    if demo_accounts:
        logger.critical("Production demo credentials detected for %d account(s)", len(demo_accounts))
        return JSONResponse(status_code=503, content={"status": "degraded", "reasons": ["unsafe demo credentials detected"]})
    return {"status": "ok", "pdf_renderer_revision": PDF_RENDERER_REVISION}


@api.get("/health/ready", include_in_schema=False)
async def readiness():
    """Infrastructure readiness for the deployment orchestrator.

    ``/health`` intentionally reports a non-2xx status for a detected default
    demo password so that monitoring alerts on that security condition.  It is
    not a process-readiness failure, however: using it for Docker's health
    check caused Railway to continuously mark an otherwise working API
    unhealthy.  Keep the warning on ``/health`` and make the container probe
    depend only on the datastore it needs to serve traffic.
    """
    pending = getattr(app.state, "pending_migrations", [])
    if pending:
        return JSONResponse(status_code=503, content={"status": "error", "detail": "pending migrations", "migrations": pending})
    try:
        await db.command("ping")
        from media_storage.supabase_driver import supabase_ready
        await supabase_ready()
    except Exception:  # noqa: BLE001
        return JSONResponse(status_code=503, content={"status": "error", "detail": "database unavailable"})
    return {"status": "ok", "pdf_renderer_revision": PDF_RENDERER_REVISION}


# Feature routers
api.include_router(auth_router)
api.include_router(dashboard_router)
api.include_router(catalog_router)
api.include_router(catalog_import_router)
api.include_router(customer_router)
api.include_router(po_final_router)
api.include_router(quotation_router)
api.include_router(misc_router)
api.include_router(media_router)
api.include_router(supplier_router)
api.include_router(purchase_router)
api.include_router(purchases_tracker_router)
api.include_router(payment_router)
api.include_router(activity_router)
api.include_router(followup_router)
api.include_router(settings_router)
api.include_router(roles_router)
api.include_router(permissions_router)
api.include_router(access_grants_router)
api.include_router(referrer_router)
api.include_router(sales_data_router)
api.include_router(executive_analytics_router)
api.include_router(analytics_settings_router)
api.include_router(executive_overview_router)
api.include_router(sales_performance_router)
api.include_router(referral_analytics_router)
api.include_router(sales_breakdown_router)
api.include_router(sales_workspace_router)
api.include_router(tile_orders_router)
api.include_router(walkin_router)
api.include_router(godown_stock_router)
api.include_router(page_export_router)

app.include_router(api)


@app.get("/", include_in_schema=False)
async def service_root():
    """Provide a useful response when the service URL is opened directly."""
    return {"name": "Forge API", "version": "0.1.0", "status": "ok"}


@app.get("/sentry-debug", include_in_schema=False)
async def trigger_error():
    """Trigger a controlled exception to verify Sentry reporting."""
    if settings.environment == "production":
        return JSONResponse(status_code=404, content={"detail": "Not found"})
    division_by_zero = 1 / 0
    return division_by_zero

# Security headers (defense-in-depth, no behavior change for existing
# clients) — registered before CORSMiddleware so CORS stays the outermost
# middleware, unchanged from its current behavior.
app.add_middleware(RequestBodyLimitMiddleware)
app.add_middleware(SecurityHeadersMiddleware)
# Mobile clients and the hosted web app receive several JSON-heavy responses.
# Compress them at the API boundary; images already use their native formats.
app.add_middleware(GZipMiddleware, minimum_size=500, compresslevel=6)

# The API receives bearer credentials. Production browser cookies terminate
# at the same-origin proxies, which enforce Origin/CSRF and translate them to
# bearer credentials. Native clients use SecureStore. Cross-origin API access
# therefore never enables ambient browser cookies.
app.add_middleware(
    CORSMiddleware,
    allow_credentials=False,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
