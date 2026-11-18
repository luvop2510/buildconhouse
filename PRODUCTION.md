# Forge (BuildCon House) — Production Operations Guide

Single source of truth for deploying, operating, monitoring, and recovering Forge in
production. Written 2026-08 during the Phase 9 production-readiness audit.

---

## 1. Architecture at a glance

```
Expo Router app (staff + customer portal, one codebase, two auth domains)
        │  fetch, Bearer JWT
        ▼
FastAPI backend (0.0.0.0:8001, all routes under /api/*)
        │                              │
        ▼                              ▼
MongoDB Atlas (buildcon_house)   Supabase Storage
  - source of truth for all       - forge-products (public bucket — product images)
    business data                 - forge-private (private bucket — PDFs, DB backups)
```

Staff and customers are **never** authenticated through the same code path (separate
login endpoints, separate JWT `kind` claim, separate `get_current_user` /
`get_current_customer` dependencies). MongoDB is never reachable from the client —
every request goes User → Login → JWT → Backend → Role check → API → MongoDB.

---

## 2. Required environment variables

See `backend/.env.example` and the root `.env.example` for the variable reference.
**Production must inject these as real deployment secrets** — `backend/.env` /
the root `.env` are local/preview fallbacks only (`load_dotenv(override=False)`) and
are gitignored on purpose. Never commit a populated `.env` file.

| Variable | Required | Notes |
|---|---|---|
| `MONGO_URL` | Yes | MongoDB Atlas connection string (`mongodb+srv://...`) |
| `DB_NAME` | Yes | Database name inside that cluster |
| `JWT_SECRET` | Yes | ≥32 random chars — `openssl rand -hex 32` |
| `SUPABASE_URL` | Yes | `https://<project-ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Server-side only — never ship to the frontend |
| `SUPABASE_ANON_KEY` | Yes | Currently unused client-side; kept for future direct-client-upload flows |
| `SUPABASE_PUBLIC_BUCKET` | Yes | e.g. `forge-products` |
| `SUPABASE_PRIVATE_BUCKET` | Yes | e.g. `forge-private` |
| `JWT_ALGORITHM` | No | Default `HS256` |
| `JWT_EXP_MINUTES` | No | Default 43200 (30 days) |
| `SENTRY_DSN` | No | Blank = crash reporting disabled (safe no-op) |
| `POSTHOG_API_KEY` | No | Blank = analytics disabled (safe no-op) |
| `EXPO_PUBLIC_BACKEND_URL` | Yes (frontend) | Backend base URL, `/api` appended by the client |

Backend fails fast at startup with a clear error naming the missing variable if any
required value is absent, blank, or looks like a placeholder (`settings.py`) — this is
intentional; do not remove it.

---

## 3. MongoDB Atlas setup

1. Create a cluster (M10+ recommended for production; free-tier M0 is fine for beta).
2. Database Access → create a user scoped to the target database only.
3. Network Access → add the deployment's outbound IP (or `0.0.0.0/0` only if Atlas's
   own auth is your sole perimeter — prefer an IP allowlist in production).
4. Copy the SRV connection string into `MONGO_URL`.
5. On first boot, `backend/bootstrap.py` verifies (and **does not silently create**)
   14 required collections and ~15 required indexes, then raises and refuses to serve
   traffic if anything is missing — see `STARTUP_CHECK.md`. Run
   `python -m scripts.ensure_indexes` once against a fresh database before first
   deploy (idempotent, safe to re-run any time).
6. **If migrating an existing database into Emergent-managed MongoDB**: confirm the
   migration preserves indexes. If it does not, run
   `python -m scripts.ensure_indexes` immediately after migration and before routing
   traffic, or the strict startup preflight above will block boot.

## 4. Supabase setup

1. Create a project, note the URL + `service_role` + `anon` keys.
2. Storage → create two buckets:
   - `forge-products` — **public** (product images served directly by URL).
   - `forge-private` — **private** (quotation/PO PDFs via signed URLs, DB backups).
3. No public bucket should ever hold PDFs, backups, or anything customer/business
   sensitive — `backend/media_storage/supabase_driver.py` already routes by bucket
   correctly; do not add a third bucket without updating that driver's assumptions.

---

## 5. Deployment steps (Railway)

1. Confirm Git ignores the local `backend/.env` and root `.env`.
2. In Railway, connect the `main` branch of `yashvardhansinh2510-max/forge2.0` to the
   backend service and set its root directory to `backend`. Set the Config-as-Code path
   to `/backend/railway.json`; it selects the Dockerfile builder, deployment readiness
   probe, and restart policy.
3. Set every backend variable in §2 as a Railway service variable. Set
   `ENVIRONMENT=production`, `FORGE_ALLOW_DEMO_SEED=false`, and leave `PORT` managed by
   Railway. Never copy the local `.env` file into Railway.
4. Deploy and wait for Railway to receive HTTP 200 from `/api/health/ready`; this is the
   deployment health probe. Do not use `/api/health` as the Railway probe because it
   deliberately reports unsafe demo credentials as degraded.
5. After deploy, authenticate as an owner and as a portal-enabled customer, then use an
   authenticated admin session to confirm `GET /api/health/system` reports `healthy: true`.
6. The Expo web client is deployed separately from the API. Its production build must use
   `EXPO_PUBLIC_BACKEND_URL` set to the Railway HTTPS domain. Native store submission
   requires the separate App Store / Play Console, privacy, and listing setup; Railway
   does not publish native binaries.

---

## 6. Backup & restore procedure

**Backup** (run periodically — cron/manual):
```bash
cd backend && python scripts/backup_db.py
```
Writes a timestamped JSON snapshot of every business collection to
`backend/backups/<timestamp>/` **and** pushes it to the Supabase private bucket
(`backups/<timestamp>/`) so it survives a container/session reset even if local disk
does not.

Collections covered: `products, product_media, brands, categories, customers,
quotations, purchase_orders, payments, followups, users, suppliers, activity_events,
settings, notifications, catalog_imports, purchase_shortages, purchase_transfers`.
(Deliberately excluded: `user_sessions`, `event_outbox`, `product_usage` — ephemeral/
derived, safe to lose.)

**Restore** (always dry-run first):
```bash
cd backend
python scripts/pull_backup_from_supabase.py --list          # see available snapshots
python scripts/pull_backup_from_supabase.py <timestamp>      # pull one down locally
python scripts/restore_db.py --dry-run                       # verify counts before writing
python scripts/restore_db.py                                 # apply (idempotent upsert-by-id)
```

A full drill (backup → push → list → pull → dry-run restore) was performed during the
2026-08 audit and confirmed working end-to-end.

---

## 7. Monitoring

Sentry (crash/error reporting) and PostHog (product analytics) are wired but **fully
disabled until you supply credentials** — see `backend/services/monitoring.py` and
`frontend/src/lib/monitoring.ts`. To activate:

1. Sentry: create a project at sentry.io, copy the DSN into `SENTRY_DSN` (backend) and
   `EXPO_PUBLIC_SENTRY_DSN` (frontend).
2. PostHog: create a project at posthog.com, copy the API key into `POSTHOG_API_KEY`
   (backend) and `EXPO_PUBLIC_POSTHOG_API_KEY` (frontend).
3. Redeploy. `GET /api/health/system` reports `monitoring.sentry_configured` /
   `monitoring.posthog_configured` so you can confirm activation without checking logs.
4. For a real native app build (EAS), Sentry source-map upload additionally needs
   `SENTRY_ORG` / `SENTRY_PROJECT` / `SENTRY_AUTH_TOKEN` at build time — not needed for
   the current web/Expo Go preview, only for a real store build.

Existing structured logging (`logging.basicConfig`, all backend modules) and
`GET /api/health/system` (Mongo/Supabase connectivity + business counts) remain the
first line of diagnostics even without Sentry/PostHog configured.

---

## 8. Health check endpoints

- `GET /api/health` — trivial Mongo ping, use for a load-balancer liveness probe.
- `GET /api/health/system` — full readiness: Mongo connection target, Supabase
  connectivity, secret-presence flags (booleans only, never values), business record
  counts, monitoring activation status, and a `healthy` boolean. Use this one for
  post-deploy verification and ongoing synthetic monitoring.

---

## 9. Common troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| App won't boot, log says "Missing or placeholder configuration: X" | Required env var absent in this environment | Set it via deployment secrets, redeploy |
| App won't boot, log says preflight/index error | Mongo migration didn't preserve indexes/collections | Run `python -m scripts.ensure_indexes` against the target DB |
| Staff can log in, customer portal login always 403 | Customer's `portal_enabled` is false | Customers > Edit Customer > enable Portal access |
| Login returns 429 | Rate limiter tripped (8 attempts/15min per email+IP, 40/15min per IP, 15/15min per email regardless of IP) | Wait 15 minutes, or confirm it isn't a real brute-force attempt |
| "Temporary password has expired" | >72h since Team/Customer reset-password or send-invite | Issue a new one from Team or Customers > Edit Customer |
| Backend up but `/api/health/system` shows `mongo.connected: false` | Atlas network allowlist / credentials | Check Atlas Network Access + `MONGO_URL` |
| Images broken but PDFs fine (or vice versa) | Wrong bucket public/private mix-up | Confirm `SUPABASE_PUBLIC_BUCKET`/`SUPABASE_PRIVATE_BUCKET` match actual bucket visibility in Supabase dashboard |
| Preview `.env` empty after a session reset | Known platform behavior (ephemeral preview containers) — see §10 | Follow the restore steps in §10 |

---

## 10. Recurring preview `.env` wipe — permanent mitigation

The Emergent **preview** environment periodically resets and wipes
`backend/.env` and the root `.env`.
This does **not** affect a real production deployment (secrets there are managed by
Emergent's deployment secrets store, not this ephemeral container) — but to make
preview recovery fast and mistake-proof going forward:

1. `scripts/setup-env` (repo root) reconstructs both `.env` files from environment
   variables or CLI flags in one idempotent command — see `RECOVERY.md` for exact
   usage. This already existed; it is the correct tool, not a workaround.
2. **New this audit**: `backend/settings.py`'s fail-fast startup check means a wiped
   `.env` produces an immediate, unambiguous "Missing or placeholder configuration: X"
   error instead of a confusing downstream failure — always check backend logs first.
3. Keep the current working Mongo Atlas + Supabase credentials recorded in
   `/app/memory/test_credentials.md` (already done) so restoring preview after a reset
   is a copy-paste into `scripts/setup-env`, not a hunt through chat history.
4. Do **not** "fix" this by hardcoding secrets into source or committing a populated
   `.env` — that would trade a recoverable inconvenience for a real security incident.
5. For actual production, this entire class of problem is avoided by using Emergent's
   deployment secrets (persisted outside the ephemeral preview container) rather than
   a `.env` file at all — §5 above.

---

## 11. Release checklist

- [ ] All required env vars set as real deployment secrets (§2)
- [ ] `GET /api/health/system` → `healthy: true` post-deploy
- [ ] One staff login + one customer portal login verified against production data
- [ ] `python scripts/backup_db.py` run and confirmed pushed to Supabase before any
      risky migration/release
- [ ] Sentry/PostHog DSNs set if this release should be monitored (optional but
      recommended before real users arrive)
- [ ] Store readiness checklist reviewed (see the Phase 9 audit report / test_result.md)

## 12. Rollback procedure

1. Re-deploy the previous known-good build/commit via Emergent.
2. If the release also wrote bad data (not just bad code): stop traffic, then
   `python scripts/pull_backup_from_supabase.py <pre-release timestamp>` followed by
   `python scripts/restore_db.py --dry-run` then `restore_db.py` to roll data back.
   Restores are upsert-by-id (non-destructive to unrelated documents) — they will not
   delete documents created after the snapshot, only overwrite ones that existed in it.
3. Re-run `GET /api/health/system` before restoring traffic.
