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
    "require_notebook_floor",
    "floor_scope_ids",
    "floor_for_write",
    "floor_inherit",
    "accessible_floor_ids",
    "_payment_scope_query",
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
    # --- No floor concept: the resource is not owned by either business unit ---
    "revoke_one_session": (
        "auth_routes.py:243 filters the update by {id: session_id, user_type: kind, "
        "user_id: sub} taken from the caller's own decoded token, so this can only ever "
        "revoke a session belonging to the calling principal; sessions carry no floor_id "
        "and are not a business-unit-owned record."
    ),
    "delete_saved_view": (
        "followup_routes.py:358 deletes with {id: view_id, user_id: user.id} -- a saved "
        "view is a personal UI preference owned by the user who created it, not a "
        "floor_id-carrying business record, so it cannot leak across business units."
    ),
    "put_automation_rule": (
        "followup_routes.py:101 writes to services/automation_rules.py::update_rule, and "
        "the AutomationRule model (models.py:1073) has no floor_id field -- it is a single "
        "global config row per category. The categories it governs (selection, "
        "quotation_tiles, walk_in) are only ever read by "
        "services/followup_engine.py::_tiles_pipeline_producer / _walkin_producer, which "
        "gate on doc_type == 'tiles_selection'/'tiles_quotation' and the Walk-ins feature "
        "-- both Tiles-only concepts with no Sanitary Bathroom equivalent, so there is no "
        "second floor's config for this endpoint to collide with."
    ),
    "put_workflow_transition": (
        "followup_routes.py:132 writes to services/workflow_transitions.py::update_transition "
        "against a single global row keyed by `key` with no floor_id field -- it configures "
        "the message template for the one 'order_confirmed' operational handoff transition, "
        "an application-wide behavior setting rather than a business-unit-owned record."
    ),
    "update_team_member": (
        "misc_routes.py:220 patches db.users by user_id with no floor filter, but staff "
        "accounts are cross-floor by design: models.UserPublic carries a floor_ids LIST "
        "(a person can be assigned to more than one business unit) and the endpoint is "
        "already gated to require_owner, so this is person/staff "
        "administration, not a per-floor business record."
    ),
    "view_team_member_password": (
        "Explicit owner-only credential read of a cross-floor staff identity. "
        "The POST avoids caches and automatic prefetch; it performs no business "
        "record mutation, and require_owner plus an audited no-store response "
        "protects password disclosure. Staff accounts have assigned floor_ids, "
        "rather than a single floor owner."
    ),
    "reset_team_member_password": (
        "misc_routes.py:253 looks up db.users by user_id with no floor filter for the same "
        "reason as update_team_member above -- staff accounts belong to a person who may "
        "hold floor_ids on either or both business units, not to a single floor, and the "
        "route is already require_owner-gated."
    ),
    "delete_team_member": (
        "Staff identity spans assigned floors rather than belonging to one business "
        "unit. Strict require_owner protects deletion, which preserves the account "
        "as an inactive tombstone and revokes its sessions and delegation snapshot."
    ),
    "create_access_grant": (
        "access_grants_routes.py creates a staff-account authorization row, not a business "
        "record: the target is resolved from db.users by id and may deliberately be assigned "
        "to multiple floors. Its optional floor_id is independently validated against the "
        "active floor registry before persistence, and the route is require_min_role('admin') "
        "gated, so no cross-business record is read or mutated."
    ),
    "delete_access_grant": (
        "access_grants_routes.py removes a staff-account authorization row by both grant id "
        "and target user id. Access grants define a person's permitted floor set rather than "
        "belonging to a single business record; the target is admin-authorized and session "
        "revocation follows the deletion."
    ),
    "replace_access_grants": (
        "access_grants_routes.py atomically replaces a staff person's enabled floors and "
        "page/action snapshot in db.users, not a floor-owned business record. The target "
        "is admin-authorized, every enabled floor is validated against active db.floors, "
        "every page belongs to an enabled supported floor, and sessions are revoked."
    ),

    # --- Scoped indirectly: the handler delegates to a helper that floor-scopes the lookup ---
    "send_customer_invite": (
        "customer_routes.py:171 delegates to _issue_temp_password (customer_routes.py:125), "
        "which looks up and updates the customer with "
        "floor_query(user, {'id': customer_id}) at lines 129 and 138 -- a customer outside "
        "the caller's accessible floor(s) 404s before any mail is sent or password reset."
    ),
    "reset_customer_password": (
        "customer_routes.py:178 delegates to the same _issue_temp_password "
        "(customer_routes.py:125) as send_customer_invite, which floor-scopes both the "
        "lookup and the update via floor_query(user, {'id': customer_id})."
    ),
    "upload_product_media": (
        "media_routes.py:111 calls _brand_slug_for_product (media_routes.py:80), which "
        "resolves the parent product with floor_query(user, {'id': product_id}) and raises "
        "404 if it is not visible to the caller's floor(s) before any file is stored."
    ),
    "replace_product_media": (
        "media_routes.py:139 calls both _brand_slug_for_product (floor_query on the parent "
        "product) and _assert_media_access (media_routes.py:88, which floor_query()s the "
        "product identified by the media's product_id or family_key) before touching "
        "storage, so a media row cannot be replaced from the wrong floor."
    ),
    "delete_media": (
        "media_routes.py:200 calls _assert_media_access (media_routes.py:88), which "
        "resolves the media row's parent product via "
        "floor_query(user, {'id': doc['product_id']}) (or family_key) and 404s if it is "
        "outside the caller's floor(s) before deleting."
    ),
    "patch_media": (
        "media_routes.py:210 calls the same _assert_media_access (media_routes.py:88) as "
        "delete_media, which floor-scopes the parent product lookup before the $set."
    ),
    "move_item": (
        "purchases_tracker.py:880 delegates to _apply_stage_change -> _attempt_stage_change "
        "(purchases_tracker.py:701), which loads the parent purchase order with "
        "floor_query(user, {'items.id': item_id}) and 404s if it is not visible to the "
        "caller's floor(s) before mutating the item's stage."
    ),
    "transfer_item_command": (
        "purchases_tracker.py:1027 delegates to services/transfer_workflow.py::execute_transfer, "
        "which floor_query()s all four lookups it performs inside the transaction: the "
        "source purchase order (line 72, by items.id), the source customer (line 83), and "
        "the destination customer both by id (line 92) and by email (line 98). This is the "
        "modern replacement for the legacy transfer_item handler whose unscoped destination "
        "lookup was fixed in Phase 0 (2d817b9); the replacement was built floor-scoped from "
        "the start."
    ),
    "dispatch_from_released": (
        "tile_orders.py:655 delegates to _commit_simple_dispatch (tile_orders.py:510), which "
        "loads the purchase order with tiles_floor_query(user, {'id': po_id}) at line 523 "
        "and 404s before any dispatch/chalan is created."
    ),
    "dispatch_from_godown": (
        "tile_orders.py:662 delegates to the same _commit_simple_dispatch (tile_orders.py:510) "
        "as dispatch_from_released, which tiles_floor_query()s the purchase order before "
        "mutating it."
    ),
    "update_dispatch_transport": (
        "tile_orders.py:799 delegates to _dispatch_with_chalan (tile_orders.py:730), which "
        "tiles_floor_query()s both the dispatch (by id) and its chalan (by chalan_id) and "
        "404s if either is outside Ground Floor's scope before the transport fields are "
        "updated."
    ),
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
