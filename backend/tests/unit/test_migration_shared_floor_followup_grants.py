"""The department page merge preserves existing capabilities conservatively."""
import importlib
from copy import deepcopy
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

migration = importlib.import_module("migrations.0035_shared_floor_followup_grants")
NOW = datetime(2090, 1, 1, tzinfo=timezone.utc)


def grant(resource, actions=("view", "update"), floor="second-floor", **extra):
    return {"id": resource, "user_id": "staff", "resource": resource, "floor_id": floor,
            "actions": list(actions), "expires_at": None, **extra}


def staff(grants=None, **extra):
    return {"id": "staff", "custom_access": True, "role": "sales", "floor_ids": ["second-floor"],
            "delegation_grants": grants if grants is not None else full_grants(), **extra}


def full_grants():
    return [grant("notebook_walkins", ("view", "create", "update")), grant("notebook_quotations"),
            grant("customers", ("view",)), grant("walkins", ("view", "create", "update"))]


def derive(caller):
    return migration.derive_grants(caller, caller.get("delegation_grants", []), now=NOW)


def test_only_minimum_existing_actions_and_same_floor_are_migrated():
    caller = staff()
    before = deepcopy(caller)
    additions = derive(caller)
    assert caller == before
    assert len(additions) == 1
    assert additions[0]["floor_id"] == "second-floor"
    assert additions[0]["resource"] == "followups"
    assert set(additions[0]["actions"]) == {"view", "update", "create"}
    assert additions[0]["migration"] == migration.MIGRATION
    assert derive(caller) == additions


@pytest.mark.parametrize("resource", ["notebook_walkins", "notebook_quotations", "customers"])
def test_single_stage_and_missing_customer_scope_remain_unchanged(resource):
    assert derive(staff([g for g in full_grants() if g["resource"] != resource])) == []


@pytest.mark.parametrize("resource", ["notebook_walkins", "notebook_quotations"])
def test_no_update_when_one_stage_is_read_only(resource):
    grants = full_grants()
    next(g for g in grants if g["resource"] == resource)["actions"] = ["view"]
    actions = derive(staff(grants))[0]["actions"]
    assert "view" in actions and "update" not in actions
    assert ("create" in actions) == (resource != "notebook_walkins")


@pytest.mark.parametrize("resource", ["notebook_walkins", "walkins"])
def test_create_requires_both_legacy_and_regular_walkin_create(resource):
    grants = full_grants()
    next(g for g in grants if g["resource"] == resource)["actions"].remove("create")
    assert derive(staff(grants))[0]["actions"] == ["view", "update"]


@pytest.mark.parametrize("changes", [
    {"floor_id": "third-floor"}, {"floor_id": None}, {"actions": ["update"]},
    {"expires_at": "2089-12-31T00:00:00+00:00"}, {"expires_at": "malformed"},
    {"user_id": "someone-else"},
])
def test_invalid_global_other_floor_or_expired_stage_grants_never_widen_scope(changes):
    grants = full_grants()
    grants[0].update(changes)
    assert derive(staff(grants)) == []


@pytest.mark.parametrize("changes", [
    {"active": False}, {"custom_access": False}, {"role": "owner"}, {"is_deleted": True},
    {"deleted_at": "past"}, {"floor_ids": ["third-floor"]}, {"access_profile": "sanitary_quotations_followups"},
])
def test_inactive_noncustom_and_other_floor_accounts_are_untouched(changes):
    assert derive(staff(**changes)) == []


def test_expiry_never_outlives_the_earliest_contributing_access():
    grants = full_grants()
    grants[0]["expires_at"] = "2091-02-01T00:00:00+00:00"
    grants[1]["expires_at"] = "2091-01-01T00:00:00+00:00"
    grants[2]["expires_at"] = "2090-06-01T00:00:00+00:00"
    assert derive(staff(grants))[0]["expires_at"] == "2090-06-01T00:00:00+00:00"


@pytest.mark.parametrize("expiry", [None, "2089-01-01T00:00:00+00:00"])
def test_an_existing_shared_grant_is_never_replaced_or_extended(expiry):
    existing = grant("followups", ("view",), expires_at=expiry)
    assert derive(staff([*full_grants(), existing])) == []


class Cursor:
    def __init__(self, rows):
        self.rows = deepcopy(rows)

    def __aiter__(self):
        async def iterate():
            for row in self.rows:
                yield row
        return iterate()

    async def to_list(self, limit):
        return self.rows[:limit]


class Users:
    def __init__(self, rows, conflict=False):
        self.rows = deepcopy(rows)
        self.writes = 0
        self.conflict = conflict

    def find(self, *_args):
        return Cursor(self.rows)

    async def update_one(self, query, update):
        if self.conflict:
            return SimpleNamespace(matched_count=0)
        for row in self.rows:
            if row["id"] == query["id"] and row["delegation_grants"] == query["delegation_grants"]:
                row["delegation_grants"].extend(deepcopy(update["$push"]["delegation_grants"]["$each"]))
                self.writes += 1
                return SimpleNamespace(matched_count=1)
        return SimpleNamespace(matched_count=0)


class Floors:
    def find(self, *_args):
        return Cursor([{"id": "second-floor"}, {"id": "third-floor"}])


@pytest.mark.asyncio
async def test_embedded_grant_migration_is_additive_idempotent_and_has_aggregate_dry_run():
    original = full_grants()
    users = Users([staff(original), staff([grant("notebook_walkins", user_id="single")], id="single")])
    db = SimpleNamespace(users=users, floors=Floors())
    report = await migration.audit(db)
    assert report == {"planned_grants": [{"floor_id": "second-floor", "actions": ["view", "update", "create"], "count": 1}],
                      "single_stage_allocations_unchanged": {"second-floor": 1}, "legacy_collection_allocations_unchanged": {}}
    assert users.writes == 0
    await migration.up(db)
    assert users.writes == 1 and users.rows[0]["delegation_grants"][:4] == original
    assert len(users.rows[0]["delegation_grants"]) == 5
    await migration.up(db)
    assert users.writes == 1
    assert (await migration.audit(db))["planned_grants"] == []


@pytest.mark.asyncio
async def test_concurrent_team_edits_fail_instead_of_overwriting_owner_decisions():
    users = Users([staff()], conflict=True)
    db = SimpleNamespace(users=users, floors=Floors())
    with pytest.raises(RuntimeError, match="Team permissions changed"):
        await migration.up(db)
    assert users.writes == 0 and users.rows[0]["delegation_grants"] == full_grants()


@pytest.mark.asyncio
async def test_legacy_collection_grants_are_read_only_even_if_their_source_changes():
    caller = staff()
    del caller["delegation_grants"]
    users = Users([caller])

    class Grants:
        def find(self, *_args):
            return Cursor(full_grants())

        async def update_one(self, *_args, **_kwargs):
            raise AssertionError("Legacy grants cannot be atomically promoted; manual review is required")

    db = SimpleNamespace(users=users, floors=Floors(), access_grants=Grants())
    report = await migration.audit(db)
    assert report["planned_grants"] == []
    assert report["legacy_collection_allocations_unchanged"] == {"second-floor": 1}
    await migration.up(db)
    assert users.writes == 0 and "delegation_grants" not in users.rows[0]
