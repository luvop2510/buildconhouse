# Backend latency observability

`/api/*` responses now include a `Server-Timing: app;dur=<milliseconds>` header.
The duration covers the application middleware and endpoint execution in that
process; it is neither a network round-trip nor a claim of end-to-end latency.

The Vercel proxy appends `upstream;dur=<milliseconds>` covering its complete
upstream fetch, including response-body consumption. Compare it with `app`
and browser total duration to distinguish backend computation, upstream transit,
and browser-to-edge latency. Its existing 28-second deadline now also covers a
body that stalls after headers; these requests return 504 instead of hanging.
Cookie/CSRF, floor, download-token and no-store response boundaries remain.

Catalog snapshot mode, source bytes/rows, finite byte budget and refresh/backoff
state are available in the authenticated administrator-only `/api/health/system`
response. Startup/refresh logs record these operational counters; database
fallback or at least 80% byte-budget consumption emits a warning. The read-only
`backend/scripts/benchmark_catalog_performance.py` measures every floor's warmed
family/hierarchy/reference reads and rejects unexpected database fallback.
This catches source-data growth that hermetic CI fixtures alone cannot observe.

The backend also keeps a bounded 512-request in-process latency window and
emits a structured `slow_request` warning when a request reaches the configured
threshold. Logs contain only HTTP method, matched route template, status, and
duration. They intentionally omit raw paths, query strings, headers, bodies,
and user identifiers.

Configuration (optional):

- `FORGE_REQUEST_TIMING=false` disables request timing in an emergency.
- `FORGE_SLOW_REQUEST_MS=1000` sets the warning threshold in milliseconds.

For deployment verification, sample the public, read-only `/api/health` route
from the intended region and record a distribution (at least min/median/max or
p50/p95). Treat a high first sample separately: it may include MongoDB and
connection warm-up. Use `Server-Timing` plus the slow-request logs to decide
whether a delay is application processing or network/edge transit.

This process-local window is diagnostic only. Configure Sentry/APM for durable,
cross-replica aggregation and alerting before horizontally scaling the API.
