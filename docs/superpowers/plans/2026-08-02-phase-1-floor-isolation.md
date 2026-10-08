# Phase 1 — Floor Isolation, Re-Audited Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make business-unit isolation structurally enforced rather than repeatedly re-audited — a new unscoped endpoint must fail the test suite, not wait to be noticed.

**Architecture:** Phase 0 found six isolation defects, four of them by looking past the file a claim named. A seventh was a blind spot in Phase 0's own fix. Manual sweeps do not hold: they go stale the moment someone adds a route. So Phase 1's primary deliverable is not a fix list, it is a **coverage gate** — an AST test enumerating every id-addressed mutation handler and asserting each is floor-scoped or explicitly allowlisted with a written reason. The fixes that gate produces come second. Secondary deliverables close the three leads Phase 0 handed forward and remove the `"first-floor"` model defaults that make a missing floor silent instead of loud.

**Tech Stack:** Python 3.14 (`backend/.venv`), FastAPI, MongoDB Atlas (`buildcon_house`), pytest + pytest-asyncio 1.4.0, Expo/RN-Web, `npx tsc`.

## Global Constraints

- **Business unit ids:** Sanitary Bathroom = `first-floor` (`SANITARY_FLOOR_ID`), Ground Floor / Tiles = `ground-floor` (`TILES_FLOOR_ID`). Never hardcode these as literals in application code; test and script code may.
- **Sales Data / Executive OS is FROZEN.** Do not modify `backend/routes/sales_data_routes.py`, anything under `backend/services/analytics/`, or `frontend/app/(admin)/sales-data/`. Reading them is fine. Its 15 `require_roles(*_ANALYTICS_ROLES)` guards stay untouched.
- **Cross-unit record access returns 404, not 403.** Owner decision, 2026-08-02: a 403 confirms "this id exists, just not for you", which is an existence oracle across the business-unit boundary. This applies to **id-addressed record lookups**. It does NOT apply to `require_floor_access` used standalone on a request-body floor (e.g. `POST /walkins`), where no record is being addressed and 403 remains correct.
- **Branch:** work directly on `main`, per owner consent 2026-08-02. Commit locally; **never push**.
- **Live database is production.** Reads unrestricted. No manual business-data edits, no deletions. Triggering the app's own idempotent background behaviour is permitted. Temporary data only if unavoidable: prefix `ZZTEST`, minimal, cleaned up before the phase ends.
- **Backend on `:8010` does not auto-reload** and may be shared with the owner's Emergent agent. Confirm with `ps -o lstart` that its start time is later than the newest edited file's mtime. Ask before restarting.
- **Metro silently serves stale bundles.** Before trusting any UI result, fetch the served entry bundle and grep for a string unique to the edit. This bit twice during Phase 0.
- **`pytest-asyncio 1.4.0` IS installed** and `@pytest.mark.asyncio` genuinely runs. An older project note claiming it silently skips is false — verified empirically 2026-08-02.
- **Baseline at phase start:** backend suite **735 passed, 0 failed**; `tsc --noEmit` clean; `probe_floor_isolation` 10/10. Any regression blocks the phase.

---

## File Structure

| File | Responsibility |
|---|---|
| `backend/tests/unit/test_floor_scoping_coverage.py` | **Create.** The gate. Enumerates every id-addressed mutation handler in `backend/routes/` and asserts each is floor-scoped or allowlisted with a reason. |
| `backend/scripts/probe_floor_isolation.py` | **Modify.** Add write-path probing to the existing read-path probe. |
| `backend/auth.py` | **Modify.** `get_floor_scoped_or_404` → 404 on cross-unit; resolve the `floor_query`/`floor_for_write` asymmetry. |
| `backend/models.py`, `backend/models_tile_orders.py` | **Modify.** Remove the 16 `floor_id: str = "first-floor"` defaults. |
| `backend/services/domain_outbox.py`, `backend/migrations/0014_*.py` | **Modify.** Add `"tile_customer_order"` to `_ENTITY_COLLECTIONS`. |
| Route files flagged by the gate | **Modify.** Sized by Task 1's output, not guessed here. |
| `docs/superpowers/verification/2026-08-02-phase-1-release-report.md` | **Create.** Phase report. |

---

## Task 1: The floor-scoping coverage gate

This task's deliverable is the test plus its **initial allowlist**, where every entry carries a written justification. Handlers that are genuinely unscoped are findings for Task 2 — do NOT fix them here, and do NOT allowlist them to make the test pass. An allowlist entry that says "not scoped yet" is a lie the gate will then protect forever.

**Files:**
- Create: `backend/tests/unit/test_floor_scoping_coverage.py`

**Interfaces:**
- Produces: `iter_id_addressed_mutations() -> list[Handler]` where `Handler` is a `NamedTuple(file: str, name: str, method: str, path: str, lineno: int)`. Task 2 consumes the failure list; later phases extend `SCOPING_HELPERS` and `ALLOWLIST`.

- [ ] **Step 1: Write the test**

```python
"""Structural gate: every id-addressed mutation must be floor-scoped.

BuildCon House runs two businesses that must behave as independent companies.
The recurring defect -- six instances found in Phase 0 alone -- is a handler
that takes a record id from the caller and acts on it without checking the
record belongs to the caller's business unit. Reviews keep finding these one
at a time, which does not scale and does not hold: the next new route starts
the cycle again.

So this test enumerates them instead. Any POST/PATCH/PUT/DELETE handler whose
route carries a path parameter must either reference a scoping helper in its
own body, or appear in ALLOWLIST with a written reason.

Adding a new id-addressed mutation without scoping it fails this test.
"""

from __future__ import annotations

import ast
import pathlib
from typing import NamedTuple

import pytest

ROUTES_DIR = pathlib.Path(__file__).resolve().parents[2] / "routes"

MUTATING_METHODS = {"post", "patch", "put", "delete"}

# Any of these appearing in a handler's body is evidence it resolved the
# record's business unit. This is deliberately name-based: it cannot prove the
# helper was used correctly, only that the author engaged with scoping at all.
# Correctness is the reviewer's job; this test catches the total absence.
SCOPING_HELPERS = {
    "floor_query",
    "tiles_floor_query",
    "get_floor_scoped_or_404",
    "require_floor_access",
    "floor_scope_ids",
    "floor_for_write",
    "floor_inherit",
    "accessible_floor_ids",
}


class Handler(NamedTuple):
    file: str
    name: str
    method: str
    path: str
    lineno: int

    def __str__(self) -> str:
        return f"{self.file}:{self.lineno} {self.method.upper()} {self.path} ({self.name})"


# Handlers that legitimately need no floor scoping. EVERY entry needs a reason
# that would survive a reviewer asking "why is this safe?". "Not done yet" is
# not a reason -- that is a Task 2 finding, not an allowlist entry.
ALLOWLIST: dict[str, str] = {
    # filled in during Step 3, one line per handler, each with its reason
}


def _route_decorators(node: ast.FunctionDef | ast.AsyncFunctionDef) -> list[tuple[str, str]]:
    out = []
    for dec in node.decorator_list:
        if not isinstance(dec, ast.Call) or not isinstance(dec.func, ast.Attribute):
            continue
        method = dec.func.attr.lower()
        if method not in MUTATING_METHODS:
            continue
        if dec.args and isinstance(dec.args[0], ast.Constant) and isinstance(dec.args[0].value, str):
            out.append((method, dec.args[0].value))
    return out


def iter_id_addressed_mutations() -> list[Handler]:
    found: list[Handler] = []
    for path in sorted(ROUTES_DIR.glob("*.py")):
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for method, route in _route_decorators(node):
                if "{" not in route:
                    continue  # not id-addressed
                found.append(Handler(path.name, node.name, method, route, node.lineno))
    return found


def _names_in(node: ast.AST) -> set[str]:
    return {
        n.id if isinstance(n, ast.Name) else n.attr
        for n in ast.walk(node)
        if isinstance(n, (ast.Name, ast.Attribute))
    }


def _handler_node(path: pathlib.Path, name: str, lineno: int) -> ast.AST:
    tree = ast.parse(path.read_text(), filename=str(path))
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name and node.lineno == lineno:
            return node
    raise AssertionError(f"handler {name} at line {lineno} not found in {path}")


def test_every_id_addressed_mutation_is_floor_scoped():
    unscoped: list[Handler] = []
    for h in iter_id_addressed_mutations():
        if h.name in ALLOWLIST:
            continue
        node = _handler_node(ROUTES_DIR / h.file, h.name, h.lineno)
        if not (_names_in(node) & SCOPING_HELPERS):
            unscoped.append(h)

    assert not unscoped, (
        "These id-addressed mutations reference no floor-scoping helper.\n"
        "Each one can act on the other business unit's record.\n"
        "Fix them -- do NOT add them to ALLOWLIST to silence this.\n\n"
        + "\n".join(f"  {h}" for h in unscoped)
    )


def test_allowlist_has_no_stale_entries():
    """An allowlist entry for a handler that no longer exists hides the next
    handler that happens to reuse the name."""
    live = {h.name for h in iter_id_addressed_mutations()}
    stale = sorted(set(ALLOWLIST) - live)
    assert not stale, f"ALLOWLIST references handlers that no longer exist: {stale}"


def test_gate_actually_detects_an_unscoped_handler():
    """A gate nobody proved can fire is not a gate.

    Parses a synthetic unscoped handler and asserts the same detection logic
    used above flags it.
    """
    src = (
        "@router.patch('/things/{thing_id}')\n"
        "async def edit_thing(thing_id: str, user=Depends(get_current_user)):\n"
        "    return await db.things.find_one({'id': thing_id})\n"
    )
    node = ast.parse(src).body[0]
    assert not (_names_in(node) & SCOPING_HELPERS)
```

- [ ] **Step 2: Run it and capture the real failure list**

Run:
```bash
cd "/Users/yashvardhansinhjhala/buildcon house/forge2.0/backend" && ./.venv/bin/python -m pytest tests/unit/test_floor_scoping_coverage.py -q 2>&1 | tail -60
```
Expected: `test_gate_actually_detects_an_unscoped_handler` PASSES, and `test_every_id_addressed_mutation_is_floor_scoped` FAILS with a list of handlers. That failure list is the real output of this task. There are 54 id-addressed mutation handlers across 13 route files, so expect a substantial list.

- [ ] **Step 3: Triage every entry — this is the judgement, not the code**

For each flagged handler, read it and decide:
- **Genuinely unscoped** → leave failing. It is a Task 2 finding. Record it.
- **Scoped indirectly** (delegates to a service that scopes, e.g. `execute_transfer` in `services/transfer_workflow.py`) → ALLOWLIST with the reason naming the function that does the scoping, so a reviewer can check the claim.
- **No floor concept** (auth, session, settings that are genuinely global) → ALLOWLIST with the reason why the resource is unit-independent.

Write the reason as a full sentence. `"auth"` is not a reason; `"session revocation is per-user, not per-business-unit; no record with a floor_id is touched"` is.

- [ ] **Step 4: Re-run — the gate must now pass or fail only on genuine findings**

Run the same command. Every remaining failure must be a real unscoped handler you intend Task 2 to fix. Record the final list.

- [ ] **Step 5: Commit**

```bash
cd "/Users/yashvardhansinhjhala/buildcon house/forge2.0" && git add backend/tests/unit/test_floor_scoping_coverage.py && git commit -m "Add structural gate: id-addressed mutations must be floor-scoped

Six isolation defects were found one at a time in Phase 0, four of them
outside the file the claim named. This enumerates the surface instead so a
new unscoped route fails the suite rather than waiting to be noticed."
```

If the gate still fails on genuine findings, commit it anyway with the failures documented in the commit message — Task 2 makes it green. A gate that is committed red and then fixed is honest; a gate allowlisted green is not.

---

## Task 2: Fix the handlers the gate flags

**Sized by Task 1's output.** Do not guess the list here.

**Files:** the route files Task 1 flagged.

- [ ] **Step 1: For each flagged handler, write a failing test first**

Each test must assert a caller from one unit cannot act on the other unit's record, **in both directions** — a test covering only `first-floor → ground-floor` passes against code that hardcoded a single floor and proves nothing. Follow the pattern in `backend/tests/unit/test_purchases_transfer_customer_floor_scope.py`.

Documented trap: `floor_query()` returns `{"$and": [...]}` when a base filter is present, so a fake `find_one` reading `query.get("id")` silently 404s. `backend/tests/unit/test_tile_orders_delivered.py` has a `_wanted_id()` helper that walks the `$and`.

- [ ] **Step 2: Run the tests, confirm they fail for the right reason**

A test that fails because the fake DB is wired wrong proves nothing. Confirm the failure is the cross-unit access succeeding.

- [ ] **Step 3: Scope each handler**

Use `get_floor_scoped_or_404` for record-by-id reads — it authorises against the record's own floor rather than ambient state, which is what makes bookmarked and deep-linked URLs work correctly for multi-floor staff. Use `floor_query` where the query is already composed. Match the surrounding file.

- [ ] **Step 4: Re-run the gate and the new tests**

```bash
cd "/Users/yashvardhansinhjhala/buildcon house/forge2.0/backend" && ./.venv/bin/python -m pytest tests/unit/test_floor_scoping_coverage.py tests/unit -q 2>&1 | tail -15
```
Expected: gate green, full suite green, count = 735 + your new tests.

- [ ] **Step 5: Commit**, one commit per handler or one grouped commit with a message separating them. Make the history readable.

---

## Task 3: Cross-unit record access returns 404

**Files:**
- Modify: `backend/auth.py` (`get_floor_scoped_or_404`, ~line 379)
- Modify: any test asserting 403 from that path

- [ ] **Step 1: Write the failing test**

Assert that fetching another unit's record by id through `get_floor_scoped_or_404` raises `HTTPException` with `status_code == 404`, and that the detail is identical to the genuinely-missing case — a different message reintroduces the oracle in the response body.

- [ ] **Step 2: Run it, confirm it fails with 403**

- [ ] **Step 3: Change the helper**

`get_floor_scoped_or_404` currently calls `require_floor_access(doc.get("floor_id", "first-floor"), user)`, which raises 403. Change this call site to raise 404 with the same `not_found` detail instead.

Do **not** change `require_floor_access` itself. It has 6 call sites; the standalone ones (notably the `POST /walkins` body-floor check added in Phase 0) are not addressing a record by id, and 403 is correct there. Changing the shared helper would silently convert those too.

Also drop the `"first-floor"` fallback in `doc.get("floor_id", "first-floor")` — a record with no floor should not be treated as Sanitary's. Treat a missing floor as inaccessible.

- [ ] **Step 4: Run the full suite**

```bash
cd "/Users/yashvardhansinhjhala/buildcon house/forge2.0/backend" && ./.venv/bin/python -m pytest tests/unit -q 2>&1 | tail -15
```
Existing tests asserting 403 from this path must be updated to 404 — but read each one first. A test asserting 403 from a *standalone* `require_floor_access` is still correct and must NOT be changed.

- [ ] **Step 5: Commit.**

---

## Task 4: Remove the `"first-floor"` model defaults

16 models declare `floor_id: str = "first-floor"`: `CustomerBase`, `Brand`, `Category`, `Product`, `Quotation`, `Supplier`, `PurchaseOrder`, `Payment`, `Followup`, `CatalogImportJob`, `ProductMedia` (`models.py`), and `TileCustomerOrder`, `TileReadyBatch`, `TileDispatch`, `TileChalan`, `TileMaterialMovement` (`models_tile_orders.py`).

A default makes a forgotten floor **silent** and files the record under Sanitary. Phase 0's whole-branch review verified the five tile models are latent-only — every construction site passes an explicit floor. The eleven in `models.py` have not been verified.

**Files:**
- Modify: `backend/models.py`, `backend/models_tile_orders.py`

- [ ] **Step 1: Audit reliance before changing anything**

For each of the 16 classes, find every construction site and determine whether any relies on the default. Report the list. This determines whether Step 3 is safe.

- [ ] **Step 2: Write the failing test**

Assert that constructing each model without `floor_id` raises `pydantic.ValidationError`. Parametrise over the 16 classes so a future model added with a default fails here.

- [ ] **Step 3: Make the field required**

Change `floor_id: str = "first-floor"` to `floor_id: str` where Step 1 found no reliance.

**If Step 1 found a construction site that relies on the default, STOP and report it** rather than making the field required and papering over the call site with a hardcoded `"first-floor"` — that reproduces the exact bug in a new location. A site that genuinely cannot know its floor is a design finding.

- [ ] **Step 4: Run the full suite and the isolation probe**

```bash
cd "/Users/yashvardhansinhjhala/buildcon house/forge2.0/backend" && ./.venv/bin/python -m pytest tests/unit -q 2>&1 | tail -15 && FORGE_PROBE_PASSWORD='[legacy password removed; use injected test credentials]' ./.venv/bin/python -m scripts.probe_floor_isolation
```
Expected: suite green, probe 10/10. A required field can break deserialization of existing documents — if any probe endpoint 500s, a stored record is missing the field and that is a real finding.

- [ ] **Step 5: Commit.**

---

## Task 5: Resolve the `floor_query` / `floor_for_write` asymmetry

`floor_query()` returns **unrestricted** for an all-floors caller with no active floor, while `floor_for_write()` defaults to a **single** floor. Unreachable from the product today because the shell always pins a concrete floor — but reachable by direct API call, and it is the kind of latent asymmetry that becomes live the moment a client changes.

**Files:**
- Modify: `backend/auth.py`

- [ ] **Step 1: Write the failing test**

Construct an all-floors user (`owner`) with `active_floor_id = None` and assert `floor_query` and `floor_for_write` agree about scope — currently they do not.

- [ ] **Step 2: Run it, confirm the asymmetry is real**

- [ ] **Step 3: Decide and implement**

The safe direction is to make reads as narrow as writes, not writes as broad as reads. Read both functions and the 129 `floor_query` call sites' expectations before choosing. **This has the widest blast radius in the phase** — every module reads through `floor_query`. If making it strict breaks legitimate all-floors reporting reads, report that rather than forcing it; a narrower fix (requiring an explicit floor at the auth layer) may be correct instead.

- [ ] **Step 4: Full suite + probe + browser smoke on both units.** This change can blank a screen that legitimately read across floors. Verify in the browser, not only in tests.

- [ ] **Step 5: Commit.**

---

## Task 6: Close Phase 0's carried-forward minor leads

**Files:**
- Modify: `backend/services/domain_outbox.py`, `backend/migrations/0014_backfill_activity_notification_floor_id.py`, `backend/services/activity_log.py`

- [ ] **Step 1: Add `"tile_customer_order": "customer_orders"` to `_ENTITY_COLLECTIONS`** in both `domain_outbox.py` and migration `0014`. It is a valid `ActivityEntity` (`models.py:893`) used by `customer_order.created`, and is harmless today only because that call also passes `quotation_id`, which resolves first. A future caller stamping only `entity_type`/`entity_id` gets `floor_id: None`.

Editing an applied migration is normally wrong. Here it is correct: `0014` is idempotent and re-derives from source documents, and leaving the two maps divergent means a future re-run produces different results from the live path. Note this in the commit message.

- [ ] **Step 2: Fix the `timeline_for` docstring** in `services/activity_log.py` (~line 113). It asserts "Every HTTP surface passes `floor_scope_ids(user)`"; four of five do not (`activity_routes.py:63, 73, 83, 104` pass `floor_ids=None`). Those are individually correct — each proves access via a floor-scoped parent read first — but the docstring misdescribes the contract it exists to enforce. State the real contract.

- [ ] **Step 3: Decide on the download-token mint floor.** `create_download_token(..., user.active_floor_id)` stores `None` for an all-floors owner whose client sent no `X-Floor-Id`; the consume path then leaves `active_floor_id = None`, making `floor_query()` unrestricted. Unreachable in-product because the shell pins a floor, but the guard is conditional on client behaviour. `floor_for_write(user)` at mint time closes it. Implement unless Task 5 already made it moot — if Task 5 changed `floor_query`'s unrestricted branch, say so and skip.

- [ ] **Step 4: Run the full suite.**

- [ ] **Step 5: Commit.**

---

## Task 7: Extend the probe to write paths

The probe currently proves reads are isolated. Phase 0's most serious findings were **writes** — `POST /walkins` trusting a caller-supplied floor, `transfer_item`'s unscoped destination. Reads were clean the whole time.

**Files:**
- Modify: `backend/scripts/probe_floor_isolation.py`

- [ ] **Step 1: Add write probing**

For each id-addressed mutation the coverage gate knows about, attempt it against a record belonging to the **other** business unit and assert the response is 404 (per Task 3). Use `ZZTEST`-prefixed records where a write must actually land, and clean them up in the same run.

Preserve the existing contract: exit code = failure count, 64 = usage error. Keep `_floors_from_db` async under the single `asyncio.run()` — motor binds to the running loop and a second `asyncio.run()` raises `RuntimeError: Event loop is closed`.

- [ ] **Step 2: Prove the write gate fires**, the same way the read gate was proven: deliberately point one probe at a same-unit record so it should pass, and at a cross-unit record so it should fail, and observe both. Report both runs.

- [ ] **Step 3: Run the full probe.** Expected: all read endpoints still 10/10, write probes all pass, exit 0.

- [ ] **Step 4: Confirm no `ZZTEST` records remain.**

```bash
cd "/Users/yashvardhansinhjhala/buildcon house/forge2.0/backend" && ./.venv/bin/python -c "
import asyncio
from db import db
async def main():
    for c in ('customers','quotations','walkins','purchase_orders','customer_orders'):
        n = await db[c].count_documents({'\$or':[{'name':{'\$regex':'^ZZTEST'}},{'customer_name':{'\$regex':'^ZZTEST'}}]})
        print(c, n)
asyncio.run(main())
"
```
Expected: 0 everywhere. Any leftover must be deleted before the phase closes.

- [ ] **Step 5: Commit.**

---

## Task 8: Full regression and phase report

**Files:**
- Create: `docs/superpowers/verification/2026-08-02-phase-1-release-report.md`

- [ ] **Step 1: Backend suite.** `cd backend && ./.venv/bin/python -m pytest tests/unit -q 2>&1 | tail -15`. Must exceed 735 (the phase-start baseline) with 0 failures and 0 skips.
- [ ] **Step 2: `cd frontend && npx tsc --noEmit`.** Must be clean; any error is new.
- [ ] **Step 3: Full probe**, reads and writes, exit 0.
- [ ] **Step 4: Browser smoke** on both units at 375/768/1280px — dashboard, walk-ins, quotations, catalog, customers, purchases, payments, follow-ups, tiles, tile orders, notifications, settings. Zero console errors, zero React warnings, zero unhandled rejections. Verify bundle freshness first.
- [ ] **Step 5: Write the report** — what changed, how it was verified, remaining risks, known limitations, production-readiness verdict. State explicitly which claims rest on live data versus code inspection. Record the final allowlist and why each entry is safe.
- [ ] **Step 6: Commit.** Do not push.

---

## Phase 1 exit criteria

- The coverage gate is green, and every allowlist entry carries a reason a reviewer could check.
- Every handler the gate flagged is either scoped or justified.
- Cross-unit record access returns 404 consistently.
- No model silently defaults `floor_id` to a business unit.
- The `floor_query`/`floor_for_write` asymmetry is resolved or explicitly deferred with a written rationale.
- The probe covers writes as well as reads, and its write gate has been observed firing.
- Suite green and above baseline; `tsc` clean; browser smoke clean on both units.
- No `ZZTEST` records remain in the live database.
