import pytest

from scripts.cleanup_floor_customers_stock import check_boundaries, fingerprint


def test_cleanup_allows_only_requested_customer_floors():
    check_boundaries({"delete": {"customers": [{"floor_id": "ground-floor"}, {"floor_id": "first-floor"}]}})
    with pytest.raises(RuntimeError, match="another floor"):
        check_boundaries({"delete": {"customers": [{"floor_id": "second-floor"}]}})
    with pytest.raises(RuntimeError, match="another floor"):
        check_boundaries({"delete": {"kitchen_projects": [{"floor_id": "first-floor"}]}})


def test_confirmation_binds_values_but_not_dictionary_order():
    assert fingerprint({"a": 1, "b": 2}) == fingerprint({"b": 2, "a": 1})
    assert fingerprint({"a": 1}) != fingerprint({"a": 2})


def test_private_backup_is_verified_before_destructive_cleanup(tmp_path):
    import hashlib
    from scripts.cleanup_floor_customers_stock import verify_backup
    payload = b'{"id": "customer-one"}\n'
    (tmp_path / "customers.jsonl").write_bytes(payload)
    manifest = {"collections": {"customers": {"rows": 1, "sha256": hashlib.sha256(payload).hexdigest()}}}
    verify_backup(tmp_path, manifest)
    (tmp_path / "customers.jsonl").write_bytes(b'corrupted')
    with pytest.raises(RuntimeError, match="verification failed"):
        verify_backup(tmp_path, manifest)


def test_protected_floor_snapshot_binds_all_row_fields_and_skips_system_collections():
    import asyncio
    from copy import deepcopy
    from scripts.cleanup_floor_customers_stock import protected_floor_snapshot

    rows = [{"_id": "kitchen", "floor_id": "second-floor", "name": "Kitchen buyer"},
            {"_id": "furniture", "floor_id": "third-floor", "name": "Furniture buyer"}]

    class Collection:
        def find(self, query):
            assert query == {"floor_id": {"$in": ["second-floor", "third-floor"]}}
            return self

        def sort(self, field, direction):
            assert (field, direction) == ("_id", 1)
            return self

        async def to_list(self, limit):
            assert limit == 50001
            return deepcopy(sorted(rows, key=lambda row: row["_id"]))

    class Database:
        async def list_collection_names(self):
            return ["system.views", "customers"]

        def __getitem__(self, name):
            assert name == "customers"
            return Collection()

    before = asyncio.run(protected_floor_snapshot(Database()))
    assert before["customers"]["rows"] == 2
    rows[0]["name"] = "Unexpected change"
    after = asyncio.run(protected_floor_snapshot(Database()))
    assert before != after
