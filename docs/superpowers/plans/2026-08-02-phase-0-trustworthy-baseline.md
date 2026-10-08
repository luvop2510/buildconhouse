# Phase 0 — Trustworthy Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-verify every claim in `RELEASE_REPORT_2026-08-02.md` from first principles against the live system, fix what fails, and commit the 26 uncommitted files as a clean, trusted baseline.

**Architecture:** This is a verification phase, not a construction phase. Its one durable artifact is a committed floor-isolation probe harness — the previous session's version lived in a session-scoped scratchpad and is gone, which is precisely why its results cannot be trusted today. Everything else is: run a check, compare to the claim, record PASS or FAIL. Any FAIL becomes a fix task appended at that point, then re-verified.

**Tech Stack:** Python 3.14 (`backend/.venv`), FastAPI on `:8010`, MongoDB Atlas (`buildcon_house`), pytest, Expo/RN-Web on `:8081`, `npx tsc`.

## Global Constraints

- **Sales Data / Executive OS is FROZEN.** Do not modify `backend/routes/sales_data_routes.py`, anything under `backend/services/analytics/`, or `frontend/app/(admin)/sales-data/`. Reading them is fine.
- **Business unit ids:** Sanitary Bathroom = `first-floor`; Ground Floor (Tiles) = `ground-floor`. Never hardcode these as string literals in application code — use `SANITARY_FLOOR_ID` / `TILES_FLOOR_ID`. Test and script code may use literals.
- **Live database is production.** Reads unrestricted. **No manual business-data edits** — no hand-written customers, quotations, orders, or payments, and no deletions. Triggering the application's own idempotent background behaviour (notably `reconcile_followups()`, which already fires from 15 mutation routes in normal operation) is permitted and is the only real proof C-1 is fixed. Owner-confirmed 2026-08-02.
- **Branch:** work directly on `main`, per this repo's established convention and owner consent 2026-08-02. Commit locally; **never push** — that is a separate owner decision.
- **The untracked `docs/superpowers/plans/2026-08-01-executive-os-phase-2.md`** belongs to the frozen Executive OS workstream. It gets its own clearly-labelled commit and must **not** ride along in the Phase 0 baseline commit.
- **Backend on `:8010` does not auto-reload.** Any `backend/*.py` edit requires a restart to take effect. Confirm with `ps -o lstart` that process start time is later than the newest edited file's mtime.
- **No `pytest-asyncio` in this repo.** `@pytest.mark.asyncio` silently skips. Async tests use `asyncio.run(...)` inside a sync test function.
- **Probe credential:** `owner@forge.app` / `[legacy password removed; use injected test credentials]`. This works today and is itself the Phase 6 release blocker — do not "fix" it in this phase; QA depends on it.
- **Commit only at Task 7**, and only if every prior task is PASS or has a recorded, re-verified fix.

---

## File Structure

| File | Responsibility |
|---|---|
| `backend/scripts/probe_floor_isolation.py` | **Create.** Committed read-path floor-isolation probe. Mints a real session, hits every scoped endpoint three ways, asserts single-floor responses. Replaces the lost scratchpad version. |
| `docs/superpowers/verification/2026-08-02-phase-0-results.md` | **Create.** Recorded PASS/FAIL per claim, with actual observed values. The evidence trail for the phase report. |
| 26 existing uncommitted files | **Verify, then commit.** No edits unless a check fails. |

---

## Task 1: Committed floor-isolation probe harness

**Files:**
- Create: `backend/scripts/probe_floor_isolation.py`

**Interfaces:**
- Consumes: nothing. Imports `db` from `backend/db.py` lazily, only on the DB-verify path, so the script still imports without a database.
- Produces: `async probe(base_url: str, email: str, password: str) -> tuple[list[dict], int]` returning `(rows, failure_count)`. Each row is `{"endpoint": str, "unscoped": set[str], "unscoped_count": int, "first_floor": set[str], "first_floor_count": int, "ground_floor": set[str], "ground_floor_count": int, "verdict": str}`. It is a coroutine and must be driven by a single `asyncio.run()` — see the loop note in `_floors_from_db()`. Task 2 runs this script; Phase 1 extends `ENDPOINTS` and adds write-path coverage.

**Already validated:** this script was run against the live backend while the plan was being written. It returns `10/10 endpoints isolated correctly`, and its counts match the release report's table exactly. The implementer should expect a pass on first run, not a debugging session.

- [ ] **Step 1: Write the probe script**

```python
"""Read-path floor-isolation probe.

Mints a real staff session against a running backend and hits every
floor-scoped read three ways -- no X-Floor-Id, first-floor, ground-floor --
asserting the set of floor_id values actually present in each response.

This catches ambient-state leaks that clicking through the UI hides: a query
that silently runs unfiltered still *renders* fine in a browser.

Usage:
    ./.venv/bin/python -m scripts.probe_floor_isolation
    ./.venv/bin/python -m scripts.probe_floor_isolation --base-url http://127.0.0.1:8010

Exit code is the number of endpoints that failed isolation, so it is usable
as a CI gate.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import urllib.error
import urllib.request

SANITARY = "first-floor"
GROUND = "ground-floor"

# (label, path, key holding the row list, collection to resolve ids against)
#
# The 4th field exists because some endpoints project floor_id OUT of their
# response -- /api/tile-orders/customer-orders is one, confirmed 2026-08-02.
# For those, the response body carries no evidence either way, and a probe
# that inspected only the payload would report a cheerful "ok" while proving
# nothing. When a collection is given, ids from the response are resolved
# against Mongo and their stored floor_id is what gets asserted.
ENDPOINTS: list[tuple[str, str, str | None, str | None]] = [
    ("Quotations", "/api/quotations", None, None),
    ("Customers", "/api/customers", None, None),
    ("Purchase orders", "/api/purchase-orders", None, None),
    ("Payments", "/api/payments", None, None),
    ("Follow-ups", "/api/followups", None, None),
    ("Walk-ins", "/api/walkins", None, None),
    ("Activity feed", "/api/activity", None, None),
    ("Notifications", "/api/notifications", None, None),
    ("Suppliers", "/api/suppliers", None, None),
    ("Tile orders", "/api/tile-orders/customer-orders", "orders", "customer_orders"),
]

# Tile Orders is pinned to Ground Floor unconditionally by tiles_floor_query(),
# regardless of the header sent. It is expected to ignore the header, so a
# first-floor request legitimately returns ground-floor rows.
HEADER_INDEPENDENT = {"Tile orders"}


def _request(url: str, token: str | None, floor: str | None) -> object:
    req = urllib.request.Request(url)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    if floor:
        req.add_header("X-Floor-Id", floor)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def login(base_url: str, email: str, password: str) -> str:
    req = urllib.request.Request(
        f"{base_url}/api/auth/login",
        data=json.dumps({"email": email, "password": password}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())["access_token"]


def _rows(body: object, list_key: str | None) -> list[dict]:
    rows = body.get(list_key, []) if list_key and isinstance(body, dict) else body
    return [r for r in rows if isinstance(r, dict)] if isinstance(rows, list) else []


async def floor_set(body: object, list_key: str | None, collection: str | None) -> tuple[set[str], int]:
    """Return (distinct floor_id values, row count).

    The count matters: an endpoint returning [] has an empty floor set and so
    trivially "does not leak". Empty is not proof of isolation -- it is
    equally consistent with a broken query. The count is what distinguishes
    the two, and is what gets compared against the release report's figures.

    When `collection` is set, the endpoint does not serialize floor_id, so
    the returned ids are resolved against Mongo instead. A response body that
    simply omits the field must never be read as evidence of isolation.
    """
    rows = _rows(body, list_key)
    if collection:
        return await _floors_from_db(collection, [r["id"] for r in rows if r.get("id")]), len(rows)
    return {str(r.get("floor_id")) for r in rows}, len(rows)


async def _floors_from_db(collection: str, ids: list[str]) -> set[str]:
    """Resolve stored floor_id for the given ids.

    Must run inside the caller's single event loop. motor binds its client to
    the running loop, so one asyncio.run() per lookup closes the loop out from
    under the next one ("RuntimeError: Event loop is closed") -- the whole
    probe therefore runs in one loop, entered once in main().
    """
    if not ids:
        return set()

    from db import db  # backend/db.py -- only imported on the DB-verify path

    found = await db[collection].find(
        {"id": {"$in": ids}}, {"_id": 0, "floor_id": 1},
    ).to_list(len(ids))
    return {str(d.get("floor_id")) for d in found}


async def probe(base_url: str, email: str, password: str) -> tuple[list[dict], int]:
    token = login(base_url, email, password)
    rows: list[dict] = []
    failures = 0

    for label, path, list_key, collection in ENDPOINTS:
        result: dict[str, object] = {"endpoint": label}
        for name, floor in (("unscoped", None), ("first_floor", SANITARY), ("ground_floor", GROUND)):
            try:
                seen, count = await floor_set(
                    _request(f"{base_url}{path}", token, floor), list_key, collection,
                )
            except urllib.error.HTTPError as exc:
                seen, count = {f"<HTTP {exc.code}>"}, -1
            result[name] = seen
            result[f"{name}_count"] = count

        problems: list[str] = []
        if label not in HEADER_INDEPENDENT:
            for name, expected in (("first_floor", SANITARY), ("ground_floor", GROUND)):
                leaked = result[name] - {expected}  # type: ignore[operator]
                if leaked:
                    problems.append(f"{name} leaked {sorted(leaked)}")
        elif result["ground_floor"] - {GROUND}:  # type: ignore[operator]
            problems.append(f"pinned domain returned {sorted(result['ground_floor'])}")  # type: ignore[arg-type]

        result["verdict"] = ("LEAK: " + "; ".join(problems)) if problems else "ok"
        if problems:
            failures += 1
        rows.append(result)

    return rows, failures


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8010")
    parser.add_argument("--email", default="owner@forge.app")
    parser.add_argument("--password", default="[legacy password removed; use injected test credentials]")
    args = parser.parse_args()

    # One loop for the entire run -- see _floors_from_db().
    rows, failures = asyncio.run(probe(args.base_url, args.email, args.password))

    def cell(r: dict, name: str) -> str:
        floors = ",".join(sorted(v for v in r[name] if v != "None")) or "-"
        return f"{floors} ({r[f'{name}_count']})"

    print(f"{'endpoint':<18} {'unscoped':<30} {'first-floor':<18} {'ground-floor':<18} verdict")
    print("-" * 104)
    for r in rows:
        print(f"{r['endpoint']:<18} {cell(r, 'unscoped'):<30} {cell(r, 'first_floor'):<18} "
              f"{cell(r, 'ground_floor'):<18} {r['verdict']}")

    print(f"\n{len(rows) - failures}/{len(rows)} endpoints isolated correctly.")
    print("Counts in parentheses. A zero count is NOT evidence of isolation -- "
          "compare it against the release report's figures before calling it a pass.")
    return failures


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Confirm the backend is running current code**

Run:
```bash
cd "/Users/yashvardhansinhjhala/buildcon house/forge2.0" && ps -o lstart= -p $(lsof -nP -iTCP:8010 -sTCP:LISTEN -t | head -1) && ls -lT backend/auth.py | awk '{print $6,$7,$8,$9}'
```
Expected: the process start time is **later** than `auth.py`'s mtime. If it is earlier, restart the backend before continuing:
```bash
kill $(lsof -nP -iTCP:8010 -sTCP:LISTEN -t) && cd "/Users/yashvardhansinhjhala/buildcon house/forge2.0/backend" && ./.venv/bin/uvicorn server:app --host 0.0.0.0 --port 8010
```
Wait for the `Forge API ready` log line (~30s). **Ask the owner before restarting** — the process is sometimes shared with their Emergent agent.

- [ ] **Step 3: Run the probe**

Run:
```bash
cd "/Users/yashvardhansinhjhala/buildcon house/forge2.0/backend" && ./.venv/bin/python -m scripts.probe_floor_isolation
```
Expected: `10/10 endpoints isolated correctly.` and every `verdict` column reads `ok`.

Then compare the per-endpoint counts against the release report's table (§2). Known-good figures, already spot-checked live on 2026-08-02:

| endpoint | first-floor | ground-floor |
|---|---|---|
| Quotations | 56 | 22 |
| Customers | 6 | 116 |
| Purchase orders | 22 | 14 |
| Payments | 21 | 10 |
| Follow-ups | 161 | 178 |
| Walk-ins | 0 | 110 |
| Activity feed | 50 | 50 |
| Notifications | 21 | 15 |
| Suppliers | 6 | 1 |
| Tile orders | (pinned) 6 | 6 |

Counts drift legitimately as data changes; a **collapse to zero** where the report shows rows does not. Walk-ins first-floor is genuinely 0 — Sanitary has no walk-ins recorded.

If any row reads `LEAK:`, **stop**. That is a genuine Phase 1 finding arriving early. Record it in Task 6's results file, do not commit, and report it before proceeding.

- [ ] **Step 4: Commit the harness**

```bash
cd "/Users/yashvardhansinhjhala/buildcon house/forge2.0" && git add backend/scripts/probe_floor_isolation.py && git commit -m "Add committed floor-isolation probe harness

The previous session's probe lived in a session-scoped scratchpad and was
lost, which is why its results could not be trusted. This version lives in
the repo and exits non-zero on leak, so it is usable as a gate."
```

---

## Task 2: Verify C-1 — follow-up automation is alive

The report claims the reconciler was dead app-wide because `followups.source_key` is uniquely indexed across all statuses, so any trigger whose condition still held after a human closed its card raised `E11000` and killed the entire pass. Claimed fix: also read closed keys, plus a `DuplicateKeyError` guard.

**Files:**
- Verify only: `backend/services/followup_engine.py`, `backend/tests/unit/test_followup_reconcile_closed_keys.py`

- [ ] **Step 1: Confirm the failure condition still exists in live data**

Run:
```bash
cd "/Users/yashvardhansinhjhala/buildcon house/forge2.0/backend" && ./.venv/bin/python -c "
import asyncio
from db import db
async def main():
    closed = await db.followups.count_documents({'status': {'\$nin': ['open','snoozed']}, 'source_key': {'\$ne': None}})
    total  = await db.followups.count_documents({})
    print(f'closed rows holding a source_key: {closed}')
    print(f'total followups: {total}')
asyncio.run(main())
"
```
Expected: a non-zero closed count (the report observed 83). This proves the collision condition is real and still present — so the fix is being exercised, not merely dormant.

- [ ] **Step 2: Run the reconciler live and confirm it completes**

Run:
```bash
cd "/Users/yashvardhansinhjhala/buildcon house/forge2.0/backend" && T=$(curl -s -X POST 127.0.0.1:8010/api/auth/login -H 'Content-Type: application/json' -d '{"email":"owner@forge.app","password":"[legacy password removed; use injected test credentials]"}' | ./.venv/bin/python -c 'import sys,json;print(json.load(sys.stdin)["access_token"])') && curl -s -X POST 127.0.0.1:8010/api/followups/reconcile -H "Authorization: Bearer $T" -H "X-Floor-Id: ground-floor"
```
Expected: a JSON summary object (created/resolved/unchanged counts), **not** a 500 and not an `E11000` error. A completed pass against a database that contains closed source_keys is the actual proof.

- [ ] **Step 3: Run the targeted regression test**

Run:
```bash
cd "/Users/yashvardhansinhjhala/buildcon house/forge2.0/backend" && ./.venv/bin/python -m pytest tests/unit/test_followup_reconcile_closed_keys.py -v
```
Expected: all tests PASS.

- [ ] **Step 4: Record the result** — append PASS/FAIL with observed counts to the results file created in Task 6.

---

## Task 3: Verify C-2 — activity and notification floor isolation

The report claims `activity_events` and `notifications` had no `floor_id` at all, that the field was added and stamped in `log_event`/`notify`, and that migration `0014` backfilled 1856/2510 events and 38/39 notifications. It also claims `GET /activity/product/{id}` previously had **no access check of any kind**.

**Files:**
- Verify only: `backend/services/activity_log.py`, `backend/services/notifications.py`, `backend/routes/activity_routes.py`, `backend/migrations/0014_backfill_activity_notification_floor_id.py`

- [ ] **Step 1: Confirm the migration ran and the backfill numbers are real**

Run:
```bash
cd "/Users/yashvardhansinhjhala/buildcon house/forge2.0/backend" && ./.venv/bin/python -c "
import asyncio
from db import db
async def main():
    applied = await db.schema_migrations.find_one({'version': '0014'})
    print('migration 0014 recorded:', bool(applied))
    for coll in ('activity_events', 'notifications'):
        total = await db[coll].count_documents({})
        stamped = await db[coll].count_documents({'floor_id': {'\$ne': None}})
        null = await db[coll].count_documents({'floor_id': None})
        missing = await db[coll].count_documents({'floor_id': {'\$exists': False}})
        print(f'{coll}: total={total} stamped={stamped} null={null} field-missing={missing}')
asyncio.run(main())
"
```
Expected: migration recorded `True`; both collections show `field-missing=0`. Deliberately-null rows are **correct by design** — the 0014 design decision is that unresolvable rows keep a null floor and are invisible to every unit, because guessing `first-floor` would file Ground Floor history under Sanitary.

- [ ] **Step 2: Confirm new writes are stamped, not just backfilled**

A backfill proves history was fixed. It does not prove `log_event` stamps going forward. Check the newest rows:

```bash
cd "/Users/yashvardhansinhjhala/buildcon house/forge2.0/backend" && ./.venv/bin/python -c "
import asyncio
from db import db
async def main():
    rows = await db.activity_events.find({}, {'_id':0,'event_type':1,'floor_id':1,'created_at':1}).sort('created_at',-1).limit(10).to_list(10)
    for r in rows: print(r)
asyncio.run(main())
"
```
Expected: recent events carry a concrete `floor_id`. If the newest rows are null while old ones are stamped, the backfill worked and the **stamping did not** — that is a FAIL and a real bug.

- [ ] **Step 3: Confirm the product-activity access check exists**

Run:
```bash
cd "/Users/yashvardhansinhjhala/buildcon house/forge2.0/backend" && grep -n "product" routes/activity_routes.py | head -20
```
Expected: the `/activity/product/{id}` handler has an auth dependency and a floor predicate. Read the handler body — a `Depends(get_current_user)` alone is not a floor check.

- [ ] **Step 4: Run the regression tests**

Run:
```bash
cd "/Users/yashvardhansinhjhala/buildcon house/forge2.0/backend" && ./.venv/bin/python -m pytest tests/unit/test_activity_floor_isolation.py tests/unit/test_migration_0014_activity_floor_backfill.py -v
```
Expected: all PASS.

- [ ] **Step 5: Record the result.**

---

## Task 4: Verify C-3 and H-1 — walk-in PII isolation and shortage cross-floor mutation

C-3 claims walk-in duplicate detection leaked customer PII across units and could auto-attach a walk-in to the other unit's customer via a HIGH-confidence phone match, and that `POST /walkins` accepted any `use_existing_customer_id` that merely existed. H-1 claims shortage create-PO/dismiss were unscoped, allowing a cross-floor **write** by id.

**Files:**
- Verify only: `backend/services/duplicate_detection.py`, `backend/services/walkin_service.py`, `backend/routes/walkin_routes.py`, `backend/routes/purchases_tracker.py`

- [ ] **Step 1: Find a real cross-unit phone collision in live data**

Run:
```bash
cd "/Users/yashvardhansinhjhala/buildcon house/forge2.0/backend" && ./.venv/bin/python -c "
import asyncio
from collections import defaultdict
from db import db
async def main():
    by_phone = defaultdict(set)
    async for c in db.customers.find({'phone': {'\$ne': None}}, {'_id':0,'phone':1,'floor_id':1,'id':1}):
        by_phone[c['phone']].add(c.get('floor_id'))
    cross = {p: f for p, f in by_phone.items() if len(f) > 1}
    print(f'phones present in more than one unit: {len(cross)}')
    for p, f in list(cross.items())[:5]: print(' ', p, sorted(map(str, f)))
asyncio.run(main())
"
```
Record the result. If cross-unit phones exist, they are the exact input the leak needed — Step 2 becomes a live reproduction attempt. If zero exist, note that the code fix cannot be disproven by live data and the unit test is the binding evidence.

- [ ] **Step 2: Confirm the duplicate check is floor-scoped in code**

Run:
```bash
cd "/Users/yashvardhansinhjhala/buildcon house/forge2.0/backend" && grep -n "floor" services/duplicate_detection.py
```
Expected: every customer lookup in this module carries a floor predicate. A module with zero `floor` matches is a FAIL.

- [ ] **Step 3: Confirm shortage routes are floor-scoped**

Run:
```bash
cd "/Users/yashvardhansinhjhala/buildcon house/forge2.0/backend" && grep -n "shortage" routes/purchases_tracker.py | grep -in "floor_query\|floor_for_write\|def \|@router"
```
Expected: each shortage handler's `find_one`/`update_one` goes through `floor_query(user, ...)`, not a bare `{"id": shortage_id}`.

- [ ] **Step 4: Run the regression test**

Run:
```bash
cd "/Users/yashvardhansinhjhala/buildcon house/forge2.0/backend" && ./.venv/bin/python -m pytest tests/unit/test_walkin_duplicate_floor_isolation.py -v
```
Expected: all PASS.

- [ ] **Step 5: Record the result.**

---

## Task 5: Verify H-2 and H-3 — download-token floor binding and Ground Floor nav

H-2 claims `?dl=` browser downloads ran with no active floor, and that the token now records and replays the minting floor. H-3 claims the Quotations nav item showed on Ground Floor where it listed nothing, and that its "New Quotation" button silently switched the user's business unit.

**Files:**
- Verify only: `backend/services/download_tokens.py`, `frontend/app/(admin)/_layout.tsx`

- [ ] **Step 1: Confirm the token records a floor**

Run:
```bash
cd "/Users/yashvardhansinhjhala/buildcon house/forge2.0/backend" && grep -n "floor\|session_id" services/download_tokens.py
```
Expected: the minted token record carries both the minting `floor_id` and `session_id`. Missing `session_id` re-introduces the 2026-07-31 bug where every browser download 401'd.

- [ ] **Step 2: Exercise a real download end to end**

Generate a quotation PDF through the `?dl=` path in the browser as owner on Ground Floor, and confirm the file downloads (HTTP 200, `%PDF-` magic bytes, non-trivial size). Then confirm single-use replay of the same token returns 401.

- [ ] **Step 3: Run the regression test**

Run:
```bash
cd "/Users/yashvardhansinhjhala/buildcon house/forge2.0/backend" && ./.venv/bin/python -m pytest tests/unit/test_download_token_floor_binding.py -v
```
Expected: all PASS.

- [ ] **Step 4: Confirm the nav restriction exists**

Run:
```bash
cd "/Users/yashvardhansinhjhala/buildcon house/forge2.0" && grep -n "floors:" "frontend/app/(admin)/_layout.tsx"
```
Expected: the Quotations entries in `PRIMARY`, `PHONE_TABS`, and `MORE_ITEMS` carry `floors: [SANITARY_FLOOR_ID]`.

**Note for Phase 3:** the Purchases entries in the same lists have **no** `floors` restriction and are therefore visible on Ground Floor today. That is expected at Phase 0 and is Phase 3's work. Confirm it is still true and record it — do not fix it here.

- [ ] **Step 5: Verify in the browser at three viewports**

Log in as owner. On **Ground Floor**, confirm Quotations is absent from the sidebar, the phone tab bar, and the More sheet. Switch to **Sanitary Bathroom** and confirm it returns. Check at 375 px, 768 px, and 1280 px.

Use `getBoundingClientRect()` / DOM assertions rather than screenshots — the Browser pane's screenshot scaling is unreliable above ~506 px, while DOM metrics stay correct. RN-Web `Pressable` ignores synthetic clicks; dispatch `pointerdown/mousedown/pointerup/mouseup/click` via JS on the element, walking 3–4 ancestors.

- [ ] **Step 6: Record the result.**

---

## Task 6: Full regression and results record

**Files:**
- Create: `docs/superpowers/verification/2026-08-02-phase-0-results.md`

- [ ] **Step 1: Run the backend suite**

Run:
```bash
cd "/Users/yashvardhansinhjhala/buildcon house/forge2.0/backend" && ./.venv/bin/python -m pytest tests/unit -q 2>&1 | tail -15
```
Expected: **713 passed, 0 failed.** The report claims 713 (up from 676). A lower total means tests were lost; any failure blocks the commit.

- [ ] **Step 2: Typecheck the frontend**

Run:
```bash
cd "/Users/yashvardhansinhjhala/buildcon house/forge2.0/frontend" && npx tsc --noEmit
```
Expected: clean, zero errors. Per the 2026-08-01 note, the long-standing `TileOrderCard.tsx:107` error is gone — treat **any** error as new.

- [ ] **Step 3: Browser smoke pass**

With Metro on `:8081`, load dashboard, walk-ins, quotations, catalog, customers, purchases, payments, follow-ups, tiles, tile orders, notifications, settings on both units. Confirm every route renders content with zero console errors, zero React warnings, zero unhandled rejections. At 375 px confirm `document.scrollWidth === window.innerWidth` on each.

If Metro serves stale content, verify by fetching the entry bundle and grepping for a string unique to a recent edit; restart if absent.

- [ ] **Step 4: Write the results file**

Record, for each of C-1, C-2, C-3, H-1, H-2, H-3: the claim, the check run, the observed value, and PASS or FAIL. Include the probe table from Task 1, suite totals, and the Phase 3 pre-condition noted in Task 5 Step 4. State explicitly which claims were verified against live data versus code inspection alone — they are not equally strong evidence.

- [ ] **Step 5: Commit the results file**

```bash
cd "/Users/yashvardhansinhjhala/buildcon house/forge2.0" && git add docs/superpowers/verification/2026-08-02-phase-0-results.md && git commit -m "Record Phase 0 re-verification results"
```

---

## Task 7: Commit the baseline

**Gate:** every task above is PASS, or has a recorded fix that was re-verified. If anything is FAIL, stop and report — do not commit.

- [ ] **Step 1: Review the full diff**

```bash
cd "/Users/yashvardhansinhjhala/buildcon house/forge2.0" && git status --short && git diff --stat
```
Expected: 17 modified backend/frontend files plus the untracked migration, 5 test files, `RELEASE_REPORT_2026-08-02.md`, and the spec/plan docs.

- [ ] **Step 2: Read every modified file's diff**

```bash
cd "/Users/yashvardhansinhjhala/buildcon house/forge2.0" && git diff
```
Confirm each change corresponds to a claim verified above. **Anything in the diff that no claim explains is a finding** — an unrelated edit riding along in an unreviewed working tree is exactly what a trusted baseline must exclude. Report it rather than committing it silently.

- [ ] **Step 3: Confirm `.superpowers/` stays untracked**

```bash
cd "/Users/yashvardhansinhjhala/buildcon house/forge2.0" && git check-ignore -v .superpowers/ || echo "NOT IGNORED — do not add"
```

- [ ] **Step 4: Commit**

```bash
cd "/Users/yashvardhansinhjhala/buildcon house/forge2.0" && git add backend/ frontend/ docs/ RELEASE_REPORT_2026-08-02.md && git status --short && git commit -m "Commit re-verified floor-isolation baseline

Re-verifies every claim in RELEASE_REPORT_2026-08-02.md against the live
database and running application rather than trusting the report:

- C-1 follow-up reconciler survives closed source_key collisions
- C-2 activity_events/notifications floor_id stamped on write, 0014 backfilled
- C-3 walk-in duplicate detection scoped per business unit
- H-1 shortage mutations floor-scoped
- H-2 download tokens bind minting floor and session
- H-3 Quotations nav restricted to Sanitary Bathroom

Backend suite 713 passed; tsc clean; 10/10 endpoints isolated under probe."
```

- [ ] **Step 5: Confirm a clean tree**

```bash
cd "/Users/yashvardhansinhjhala/buildcon house/forge2.0" && git status --short
```
Expected: empty except ignored paths. **Do not push** — pushing is a separate decision for the owner.

---

## Phase 0 exit criteria

- Probe harness committed; 10/10 endpoints isolated.
- All six report claims re-verified against live data or explicitly marked code-inspection-only.
- Backend suite 713 passed; `tsc --noEmit` clean.
- Browser smoke pass with zero console errors on both units.
- Working tree clean; baseline committed, not pushed.
- Results file records what was checked, how, and what was observed.
