import pytest
import asyncio
import copy
import json
import stat

from scripts.kitchen_reconciliation import isolated_source, mapping_entries, preview, write_private_preview


@pytest.mark.parametrize("url,database", [
    ("mongodb+srv://production.example", "test_copy"),
    ("mongodb://127.0.0.1:27017,remote.example:27017", "test_copy"),
    ("mongodb://127.0.0.1:27017/?replicaSet=production", "test_copy"),
    ("mongodb://user:password@127.0.0.1:27017", "test_copy"),
    ("mongodb://127.0.0.1:27017", "buildcon_house"),
    ("mongodb://127.0.0.1:27017", "admin"),
    ("mongodb://127.0.0.1:27017", "../test"),
])
def test_inventory_refuses_remote_or_ambiguous_sources(url, database):
    with pytest.raises(ValueError):
        isolated_source(url, database)


def test_inventory_accepts_explicit_local_copy_only():
    isolated_source("mongodb://127.0.0.1:27919", "kitchen_copy_synthetic")


class ReadOnlyCollection:
    def __init__(self, rows):
        self.rows = rows

    def find(self, selector, projection):
        async def rows():
            for row in self.rows:
                if all(row.get(key) == value for key, value in selector.items()):
                    yield {key: value for key, value in row.items() if projection.get(key)}
        return rows()

    async def find_one(self, selector, projection):
        async for row in self.find(selector, projection):
            return row
        return None


class ReadOnlyDatabase:
    name = "kitchen_preview_test_copy"

    def __init__(self, sources):
        self.sources = sources

    def __getitem__(self, name):
        return ReadOnlyCollection(self.sources.get(name, []))

    @property
    def customers(self):
        return self["customers"]


def test_preview_keeps_unknown_history_blank_and_does_not_infer_stage_or_order():
    source = {
        "customers": [{"_id": "c", "id": "customer1", "floor_id": "second-floor", "name": "Private name", "phone": "Private phone"}],
        "followups": [{"_id": "source1", "id": "followup1", "customer_id": "customer1", "floor_id": "second-floor",
                       "reference": "OLD-1", "stage": "installation", "status": "won", "created_at": "2020-01-01T00:00:00Z",
                       "notes": "Private notes", "file_url": "https://private.invalid/token", "order_amount": "1000.01",
                       "design_revision_count": 0, "completion_date": "not a date"}],
    }
    before = copy.deepcopy(source)
    result = asyncio.run(preview(ReadOnlyDatabase(source)))
    assert source == before
    assert result == asyncio.run(preview(ReadOnlyDatabase(source)))
    row = result["rows"][0]
    assert row["source_key"] == "followups:followup1"
    assert row["source_reference"] == "OLD-1"
    assert row["candidate"]["stage"] is None
    assert row["candidate"]["customer_id"] == "customer1"
    assert row["candidate"]["design_revision_count"] is None
    assert row["candidate"]["site_visit_count"] is None
    assert set(row["candidate"]["counter_labels"].values()) == {"Historical count unavailable"}
    assert set(row["candidate"]["dates"].values()) == {None}
    assert row["candidate"]["known_order_amount"] == "1000.01"
    assert row["candidate"]["order_confirmation"].startswith("unverified")
    assert not result["migration_applied"] and not result["import_authorized"]
    encoded = json.dumps(result)
    for private in ["Private name", "Private phone", "Private notes", "https://private.invalid/token", "2020-01-01"]:
        assert private not in encoded


def test_preview_stage_mapping_requires_evidence_and_counters_require_provenance():
    source = {"customers": [{"_id": "c", "id": "customer1", "floor_id": "second-floor"}],
              "project_followups": [{"id": "legacy1", "customer_id": "customer1", "floor_id": "second-floor",
                 "visit_date": "2020-02-29", "design_revision_count": 3, "site_visit_count": 0}]}
    mapping = {"entries": {"project_followups:legacy1": {"stage": "visit", "evidence": "Reviewed original showroom register",
                          "counter_evidence": {"design_revision_count": "Three dated customer revision records"}}}}
    result = asyncio.run(preview(ReadOnlyDatabase(source), mapping))
    row = result["rows"][0]
    assert row["candidate"]["stage"] == "visit"
    assert row["candidate"]["dates"]["visit_date"] == "2020-02-29"
    assert row["candidate"]["design_revision_count"] == 3
    assert row["candidate"]["site_visit_count"] is None
    assert row["review_required"] is True
    source["project_followups"][0]["design_revision_count"] = 4
    assert asyncio.run(preview(ReadOnlyDatabase(source), mapping))["source_fingerprint"] != result["source_fingerprint"]


@pytest.mark.parametrize("mapping", [
    {"entries": {"followups:id": {"stage": "installation"}}},
    {"entries": {"followups:id": {"stage": "manufacturing", "evidence": "unsupported"}}},
    {"entries": {"followups:id": {"stage": "visit", "evidence": "proof", "counter_evidence": {"site_visit_count": ""}}}},
    {"entries": {}, "apply": True},
])
def test_preview_refuses_unproved_or_executable_mappings(mapping):
    with pytest.raises(ValueError):
        mapping_entries(mapping)


def test_preview_refuses_mapping_from_a_different_source_copy():
    with pytest.raises(ValueError, match="absent"):
        asyncio.run(preview(ReadOnlyDatabase({}), {"entries": {"followups:missing": {"stage": "lead", "evidence": "another copy"}}}))


def test_preview_file_is_private_and_cannot_overwrite_or_follow_symlink(tmp_path):
    path = tmp_path / "preview.json"
    write_private_preview(path, {"migration_applied": False})
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    with pytest.raises(FileExistsError):
        write_private_preview(path, {"migration_applied": True})
    link = tmp_path / "link.json"
    link.symlink_to(path)
    with pytest.raises(FileExistsError):
        write_private_preview(link, {"migration_applied": True})
    assert json.loads(path.read_text())["migration_applied"] is False
