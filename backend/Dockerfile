# Forge/BuildCon House backend — reproducible production image.
# Build:  docker build -t buildcon-backend ./backend
# Run:    docker run -p 8000:8000 --env-file <secrets> buildcon-backend
# All configuration comes from the process environment (see settings.py);
# never bake .env into the image.
# The Google-managed Docker Hub cache avoids shared-builder Hub rate limits.
# This multi-platform digest was verified identical to library/python upstream.
FROM mirror.gcr.io/library/python:3.12-slim@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

COPY requirements-prod.txt .
RUN python -m pip install --upgrade pip==26.2.2 \
    && python -m pip install -r requirements-prod.txt

# Allowlist runtime code and assets.  Do not copy the build context wholesale:
# local environments, reports and credentials must never enter an image layer.
COPY access_profiles.py auth.py bootstrap.py catalog_policy.py db.py middleware.py models.py models_kitchen.py models_tile_orders.py models_walkins.py pdf_chalan.py pdf_generator.py pdf_tiles.py seed.py server.py settings.py ./
COPY buildcon_logo.png buildcon_cover_logo.png ./
COPY brand_logos ./brand_logos
COPY migrations ./migrations
COPY media_storage ./media_storage
COPY routes ./routes
COPY services ./services
COPY catalog_pipeline ./catalog_pipeline

# Build-time smoke check: use deliberately non-production configuration and
# import the ASGI entrypoint. This catches omissions in the runtime allowlist
# before a deployment reaches its boot command.
RUN MONGO_URL='mongodb://127.0.0.1:27017' \
    DB_NAME='forge_image_smoke' \
    JWT_SECRET='image-smoke-test-secret-that-is-not-for-runtime' \
    SUPABASE_URL='https://image-smoke.supabase.co' \
    SUPABASE_SERVICE_ROLE_KEY='image-smoke-service-role-key' \
    SUPABASE_ANON_KEY='image-smoke-anon-key' \
    SUPABASE_PUBLIC_BUCKET='forge-products' \
    SUPABASE_PRIVATE_BUCKET='forge-private' \
    ENVIRONMENT='development' \
    python -c 'import server; from services.quotation_ppt import ASSET_DIR, PARTNER_LOGOS; assert server.app; assert (ASSET_DIR / "buildcon_cover_logo.png").is_file(); assert all((ASSET_DIR / "brand_logos" / (name + ".png")).is_file() for name, *_ in PARTNER_LOGOS)'

RUN useradd --create-home forge && chown -R forge:forge /app
USER forge

EXPOSE 8000

# /api/health also surfaces security warnings (such as a default demo
# password) as degraded.  Probe the dedicated readiness endpoint instead so
# an operational warning cannot trigger a deployment restart loop.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT:-8000}/api/health/ready" || exit 1

# Railway supplies PORT for both routing and its deployment health check.  Keep
# 8000 as the local-container default while binding to the platform port when
# it is present.
CMD ["sh", "-c", "uvicorn server:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1"]
