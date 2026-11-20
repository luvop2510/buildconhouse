"""Home discovery never joins people by phone or crosses source grants."""
import re
from copy import deepcopy
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from models import UserPublic
from services import customer_search as module


def value(row, key):
    for part in key.split("."):
        row = row.get(part) if isinstance(row, dict) else None
    return row


def matches(row, query):
    for key, rule in query.items():
        if key == "$and":
            if not all(matches(row, clause) for clause in rule): return False
        elif key == "$or":
            if not any(matches(row, clause) for clause in rule): return False
        elif isinstance(rule, dict):
            actual = value(row, key)
            for operation, expected in rule.items():
                if operation == "$ne" and actual == expected: return False
                if operation == "$in" and actual not in expected: return False
                if operation == "$nin" and actual in expected: return False
                if operation == "$exists" and (actual is not None) != expected: return False
                if operation == "$regex" and (actual is None or not re.search(expected, str(actual), re.I if rule.get("$options") == "i" else 0)): return False
        elif value(row, key) != rule:
            return False
    return True


class Cursor:
    def __init__(self, rows): self.rows = deepcopy(rows)
    def max_time_ms(self, *args): return self
    def sort(self, *args): return self
    def limit(self, n): self.rows = self.rows[:n]; return self
    async def to_list(self, n): return self.rows[:n]


class Collection:
    def __init__(self, rows=()): self.rows = list(rows); self.queries = []
    def find(self, query, projection=None):
        self.queries.append(query)
        return Cursor([row for row in self.rows if matches(row, query)])

    async def find_one(self, query, projection=None):
        return next((row for row in self.rows if matches(row, query)), None)


class Database:
    def __init__(self, **rows):
        for name in ("floors", "settings", "customers", "kitchen_projects", "walkins", "followups", "quotations", "furniture_quotations", "customer_orders", "kitchen_stage_followups", "purchase_orders", "dispatches"):
            setattr(self, name, Collection(rows.get(name, ())))


def principal(**fields):
    return UserPublic(id="staff", full_name="Staff", role="sales", active=True,
        floor_ids=["ground-floor", "first-floor", "second-floor"], **fields)


@pytest.fixture
def allow_all(monkeypatch):
    monkeypatch.setattr(module, "authorize_staff_resource", AsyncMock())
    monkeypatch.setattr(module.kitchen_access, "require_capability", AsyncMock())


@pytest.mark.asyncio
@pytest.mark.parametrize("term", ["Meena", "meen", "987654", "98765 43210", "+91 (98765) 43210"])
async def test_partial_name_and_format_independent_phone_search(term, allow_all):
    database = Database(customers=[{"id": "c1", "floor_id": "first-floor", "name": "Meena Patel", "phone": "+91 (98765) 43210"}])
    result = await module.CustomerSearchService(database).search(principal(active_floor_id="second-floor"), term)
    assert [row["id"] for row in result["rows"]] == ["c1"]


@pytest.mark.asyncio
async def test_literal_regex_and_duplicate_phone_disambiguation(allow_all):
    database = Database(customers=[
        {"id": "c1", "floor_id": "first-floor", "name": "A.* Patel", "phone": "01234"},
        {"id": "c2", "floor_id": "ground-floor", "name": "A Kumar", "phone": "01234"},
    ])
    service = module.CustomerSearchService(database)
    assert [row["id"] for row in (await service.search(principal(), ".*"))["rows"]] == ["c1"]
    result = await service.search(principal(), "01234", limit=1)
    assert result["total"] == 2 and len(result["rows"]) == 1
    assert (await service.search(principal(), "01234", page=2, limit=1))["rows"][0]["id"] != result["rows"][0]["id"]


@pytest.mark.asyncio
async def test_each_source_permission_revalidated_and_foreign_floor_profile_denied(monkeypatch):
    async def permit(actor, *, path, floor_id, **kwargs):
        if path != "/api/customers" or floor_id != "first-floor":
            raise HTTPException(403, "denied")
    monkeypatch.setattr(module, "authorize_staff_resource", permit)
    database = Database(customers=[
        {"id": "c1", "floor_id": "first-floor", "name": "Meena"},
        {"id": "c2", "floor_id": "ground-floor", "name": "Meena"}],
        quotations=[{"id": "secret-quote", "floor_id": "first-floor", "customer_name": "Meena"}])
    service = module.CustomerSearchService(database)
    result = await service.search(principal(custom_access=True), "Meena")
    assert [row["id"] for row in result["rows"]] == ["c1"]
    assert database.quotations.queries == []
    with pytest.raises(HTTPException) as failure:
        await service.profile(principal(custom_access=True), "customer", "c2", "ground-floor")
    assert failure.value.status_code == 404


@pytest.mark.asyncio
async def test_soft_deleted_customer_and_linked_kitchen_sources_excluded(allow_all):
    database = Database(customers=[{"id": "gone", "floor_id": "second-floor", "name": "Meena", "deleted_at": "2026-11-16"}],
        walkins=[{"id": "old-walkin", "floor_id": "second-floor", "customer_id": "gone", "customer_name": "Meena"},
                 {"id": "other-floor", "floor_id": "first-floor", "customer_id": "gone", "customer_name": "Meena"}],
        followups=[{"id": "old-followup", "floor_id": "second-floor", "customer_id": "gone", "customer_name": "Meena"}])
    result = await module.CustomerSearchService(database).search(principal(), "Meena")
    assert [row["id"] for row in result["rows"]] == ["other-floor"]


@pytest.mark.asyncio
async def test_profile_only_exact_linked_records_and_internal_fields_hidden(allow_all):
    database = Database(customers=[{"id": "c1", "floor_id": "first-floor", "name": "Meena", "phone": "9876543210"},
                                   {"id": "relative", "floor_id": "first-floor", "name": "Other person", "phone": "9876543210"}],
        quotations=[{"id": "quote", "floor_id": "first-floor", "customer_id": "c1", "status": "ordered", "items": [{"name": "Tap", "password": "hidden"}], "command_receipts": ["secret"]},
                    {"id": "not-linked", "floor_id": "first-floor", "customer_id": "relative", "customer_phone": "9876543210"}])
    profile = await module.CustomerSearchService(database).profile(principal(), "customer", "c1", "first-floor")
    assert {row["summary"]["id"] for row in profile["records"]} == {"quote"}
    quote = next(row["data"] for row in profile["records"] if row["kind"] == "quotation")
    assert quote["products"] == [{"name": "Tap"}]
    assert "command_receipts" not in quote


@pytest.mark.asyncio
async def test_kitchen_stage_history_and_restricted_followup_notes(monkeypatch, allow_all):
    user = principal(custom_access=True)
    async def kitchen_grants(database, actor, action):
        object.__setattr__(actor, "_kitchen_stage_actions", {"view": ["design"]})
        object.__setattr__(actor, "_kitchen_semantic_actions", {"view": ["design"]})
        object.__setattr__(actor, "_kitchen_restricted", True)
    monkeypatch.setattr(module.kitchen_access, "require_capability", kitchen_grants)
    public = AsyncMock(return_value={"id": "p1", "stage": "design", "design_versions": [{"number": 1}], "activity": [], "duplicate_candidates": ["hidden"]})
    monkeypatch.setattr(module.KitchenProjectService, "get", public)
    database = Database(kitchen_projects=[{"id": "p1", "floor_id": "second-floor", "customer_id": "c1", "stage": "design", "customer": {"name": "Meena"}},
                                          {"id": "unpermitted", "floor_id": "second-floor", "customer_id": "c1", "stage": "quotation"}],
        kitchen_stage_followups=[{"id": "f1", "project_id": "p1", "stage": "design", "number": 1, "date": "2026-11-15", "notes": "hidden", "request_fingerprint": "secret"},
                                 {"id": "f2", "project_id": "p1", "stage": "quotation", "number": 1, "notes": "unpermitted"}])
    profile = await module.CustomerSearchService(database).profile(user, "kitchen", "p1", "second-floor")
    assert len(profile["records"]) == 1
    data = profile["records"][0]["data"]
    assert "duplicate_candidates" not in data
    assert "follow_ups" not in data and "design_versions" not in data
    assert database.kitchen_stage_followups.queries == []
    with pytest.raises(HTTPException) as failure:
        await module.CustomerSearchService(database).profile(user, "kitchen", "unpermitted", "second-floor")
    assert failure.value.status_code == 404


@pytest.mark.asyncio
async def test_oversized_search_fails_instead_of_silent_omission(allow_all, monkeypatch):
    monkeypatch.setattr(module, "MAX_ROWS", 2)
    database = Database(customers=[{"id": str(index), "floor_id": "first-floor", "name": "Meena"} for index in range(1001)])
    with pytest.raises(HTTPException) as failure:
        await module.CustomerSearchService(database).search(principal(), "Meena")
    assert failure.value.status_code == 422


@pytest.mark.asyncio
async def test_kitchen_search_uses_canonical_contact_after_customer_edit(allow_all):
    database = Database(customers=[{"id": "c1", "floor_id": "second-floor", "name": "Corrected contact", "phone": "+91 98765 43210"}],
        kitchen_projects=[{"id": "p1", "floor_id": "second-floor", "customer_id": "c1", "stage": "lead", "customer": {"name": "Old snapshot", "phone": "9000000000"}}])
    result = await module.CustomerSearchService(database).search(principal(), "987654")
    project = next(row for row in result["rows"] if row["kind"] == "kitchen")
    assert project["name"] == "Corrected contact" and project["phone"] == "+91 98765 43210"


@pytest.mark.asyncio
async def test_home_followups_preserve_the_existing_preorder_scope(allow_all):
    database = Database(followups=[
        {"id": "sales", "floor_id": "first-floor", "customer_name": "Meena", "category": "general", "rule_type": "manual"},
        {"id": "payment", "floor_id": "first-floor", "customer_name": "Meena", "category": "payment"},
        {"id": "ops", "floor_id": "first-floor", "customer_name": "Meena", "rule_type": "order_confirmed_ops"},
        {"id": "purchase", "floor_id": "first-floor", "customer_name": "Meena", "purchase_id": "supplier-order"},
    ])
    service = module.CustomerSearchService(database)
    assert [row["id"] for row in (await service.search(principal(), "Meena"))["rows"]] == ["sales"]
    for identity in ("payment", "ops", "purchase"):
        with pytest.raises(HTTPException) as denied:
            await service.profile(principal(), "followup", identity, "first-floor")
        assert denied.value.status_code == 404


def test_source_projection_keeps_typed_business_fields_and_discards_unknown_nested_data():
    result = module.public_source("quotation", {"id": "q", "password_hash": "hidden", "ui_state": {"internal": "hidden"},
        "items": [{"name": "Tap", "sku": "01", "unit_price": 200, "private_provider_response": {"data": "hidden"}}],
        "payment_extra_history": [{"amount": 15, "note": "Delivery charge", "unrelated_private_data": "hidden"}],
        "revisions": [{"snapshot": {"items": [{"sku": "01", "password": "hidden", "unknown": "hidden"}], "grand_total": 215, "private_key": "hidden"}}]})
    assert result["items"] == [{"name": "Tap", "sku": "01", "unit_price": 200}]
    assert result["payment_extra_history"] == [{"amount": 15, "note": "Delivery charge"}]
    assert "hidden" not in repr(result)
    assert "ui_state" not in result and "password_hash" not in result
    assert module.public_source("furniture", {"id": "f", "total_payable_rmb": "100.00", "total_received_rmb": "20.00",
        "balance_rmb": "80.00", "finalized_at": "2026-11-16", "provider_credentials": "hidden"}) == {
        "id": "f", "total_payable_rmb": "100.00", "total_received_rmb": "20.00", "balance_rmb": "80.00", "finalized_at": "2026-11-16"}


@pytest.mark.asyncio
async def test_explicit_customer_import_links_permitted_floors_without_phone_merging(allow_all):
    database = Database(customers=[
        {"id": "original", "floor_id": "ground-floor", "name": "Same person", "phone": "9000000000"},
        {"id": "imported", "floor_id": "first-floor", "name": "Same person", "phone": "9000000000", "imported_from_customer_id": "original"},
        {"id": "relative", "floor_id": "first-floor", "name": "Different person", "phone": "9000000000"},
        {"id": "restricted", "floor_id": "third-floor", "name": "Same person", "imported_from_customer_id": "original"},
    ], quotations=[{"id": "quote", "floor_id": "first-floor", "customer_id": "imported", "name": "Saved quotation"}])
    result = await module.CustomerSearchService(database).profile(principal(), "customer", "original", "ground-floor")
    assert {row["summary"]["id"] for row in result["records"]} == {"quote"}
    matches = await module.CustomerSearchService(database).search(principal(), "9000000000")
    assert matches["total"] == 2
    assert {tuple(row["floor_ids"]) for row in matches["rows"]} == {("first-floor",), ("first-floor", "ground-floor")}


@pytest.mark.asyncio
async def test_search_returns_one_customer_instead_of_every_linked_record(allow_all):
    database = Database(customers=[{"id": "c", "floor_id": "ground-floor", "name": "Meena"}],
        walkins=[{"id": "w", "customer_id": "c", "floor_id": "ground-floor", "customer_name": "Meena"}],
        quotations=[{"id": "q", "customer_id": "c", "floor_id": "ground-floor", "customer_name": "Meena"}])
    result = await module.CustomerSearchService(database).search(principal(), "Meena")
    assert result["total"] == 1
    assert result["rows"][0]["customer_id"] == "c"


@pytest.mark.asyncio
async def test_actual_order_wins_over_later_edited_selection_and_quotes(allow_all):
    database = Database(customers=[{"id": "c", "floor_id": "ground-floor", "name": "Meena", "address": "Main street"}],
        quotations=[{"id": "selection", "customer_id": "c", "floor_id": "ground-floor", "doc_type": "tiles_selection", "updated_at": "2099-01-01"},
                    {"id": "basis", "customer_id": "c", "floor_id": "ground-floor", "doc_type": "tiles_quotation", "status": "ordered"}],
        customer_orders=[{"id": "order", "floor_id": "ground-floor", "customer_id": "c", "quotation_id": "basis", "number": "TORD-1", "overall_status": "Ready", "total_boxes": 10}])
    profile = await module.CustomerSearchService(database).profile(principal(), "customer", "c", "ground-floor")
    assert [row["summary"]["id"] for row in profile["records"]] == ["order"]
    assert profile["customer"]["address"] == "Main street"
    assert profile["customer"]["reference"] is None
    assert len(profile["workflows"]) == 1


@pytest.mark.asyncio
async def test_multiple_active_quotes_retained_without_timestamp_guess_and_terminal_rows_omitted(allow_all):
    database = Database(customers=[{"id": "c", "floor_id": "ground-floor", "name": "Meena"}],
        quotations=[{"id": identity, "customer_id": "c", "floor_id": "ground-floor", "doc_type": "tiles_quotation", "status": status, "updated_at": date}
            for identity, status, date in [("q1", "approved", "2024-01-01"), ("q2", "draft", "2023-01-01"), ("cancelled", "cancelled", "2099-01-01"), ("lost", "lost", "2099-01-02")]])
    profile = await module.CustomerSearchService(database).profile(principal(), "customer", "c", "ground-floor")
    assert {row["summary"]["id"] for row in profile["records"]} == {"q1", "q2"}
    assert {row["summary"]["stage"] for row in profile["records"]} == {"quotation"}


@pytest.mark.asyncio
async def test_completed_ground_order_does_not_resurrect_its_quotation(allow_all):
    database = Database(customers=[{"id": "c", "floor_id": "ground-floor", "name": "Meena"}],
        quotations=[{"id": "q", "customer_id": "c", "floor_id": "ground-floor", "status": "ordered"}],
        customer_orders=[{"id": "order", "floor_id": "ground-floor", "customer_id": "c", "quotation_id": "q", "overall_status": "Delivered"}])
    profile = await module.CustomerSearchService(database).profile(principal(), "customer", "c", "ground-floor")
    assert profile["records"] == [] and profile["workflows"] == []


@pytest.mark.asyncio
async def test_kitchen_uses_persisted_stage_current_cycle_and_keeps_departments_separate(allow_all, monkeypatch):
    kitchen = {"id": "k", "customer_id": "kc", "floor_id": "second-floor", "customer": {"name": "Meena", "address": "Current address"},
        "stage": "quotation", "status": "Pending", "workflow_cycle": 2, "final_design_version_id": "design-2",
        "quotation_versions": [{"id": "old", "number": 1, "workflow_cycle": 1, "amount": 11},
            {"id": "new", "number": 2, "workflow_cycle": 2, "design_version_id": "design-2", "amount": 22}],
        "lead": {"notes": "Past lead"}, "activity": [{"summary": "Past event"}]}
    monkeypatch.setattr(module.KitchenProjectService, "get", AsyncMock(return_value=kitchen))
    database = Database(customers=[{"id": "c", "floor_id": "ground-floor", "name": "Meena"},
        {"id": "kc", "floor_id": "second-floor", "name": "Meena", "imported_from_customer_id": "c"}],
        kitchen_projects=[kitchen], quotations=[{"id": "q", "floor_id": "ground-floor", "customer_id": "c", "status": "draft", "doc_type": "tiles_quotation"}])
    profile = await module.CustomerSearchService(database).profile(principal(), "customer", "c", "ground-floor")
    assert {workflow["floor_id"] for workflow in profile["workflows"]} == {"ground-floor", "second-floor"}
    card = next(row for row in profile["records"] if row["kind"] == "kitchen")
    assert card["summary"]["stage"] == "quotation"
    assert card["data"]["number"] == 2 and card["data"]["amount"] == 22
    assert "Past" not in repr(profile)


@pytest.mark.asyncio
async def test_sanitary_completion_uses_exact_order_fulfillment_quantities(allow_all):
    database = Database(customers=[{"id": "c", "floor_id": "first-floor", "name": "Meena"}],
        quotations=[{"id": "done", "floor_id": "first-floor", "customer_id": "c", "status": "ordered"},
                    {"id": "open", "floor_id": "first-floor", "customer_id": "c", "status": "ordered"}],
        purchase_orders=[{"id": "p1", "floor_id": "first-floor", "quotation_id": "done", "items": [{"id": "i1", "qty": 5, "stage": "dispatched"}]},
                         {"id": "p2", "floor_id": "first-floor", "quotation_id": "open", "items": [{"id": "i2", "qty": 5, "stage": "in_box"}]}])
    profile = await module.CustomerSearchService(database).profile(principal(), "customer", "c", "first-floor")
    assert [row["summary"]["id"] for row in profile["records"]] == ["open"]


@pytest.mark.asyncio
async def test_kitchen_current_project_hides_old_shared_lead_and_completed_substage_is_still_current(allow_all, monkeypatch):
    project = {"id": "k", "customer_id": "c", "floor_id": "second-floor", "stage": "cad", "status": "Completed",
        "customer": {"name": "Meena"}, "cad": {"status": "Completed", "percentage": 100}}
    monkeypatch.setattr(module.KitchenProjectService, "get", AsyncMock(return_value=project))
    database = Database(kitchen_projects=[project], walkins=[{"id": "old", "customer_id": "c", "floor_id": "second-floor", "status": "new"}])
    profile = await module.CustomerSearchService(database).profile(principal(), "kitchen", "k", "second-floor")
    assert [row["summary"]["id"] for row in profile["records"]] == ["k"]
    assert profile["records"][0]["summary"]["stage"] == "cad"
    assert profile["records"][0]["data"]["percentage"] == 100


@pytest.mark.asyncio
async def test_unpermitted_kitchen_current_stage_cannot_resurrect_old_shared_lead(allow_all, monkeypatch):
    async def kitchen_grants(database, actor, action):
        object.__setattr__(actor, "_kitchen_stage_actions", {"view": ["lead"]})
        object.__setattr__(actor, "_kitchen_semantic_actions", {"view": ["lead"]})
    monkeypatch.setattr(module.kitchen_access, "require_capability", kitchen_grants)
    database = Database(walkins=[{"id": "old", "floor_id": "second-floor", "customer_id": "c", "customer_name": "Meena", "status": "new"}],
        kitchen_projects=[{"id": "hidden", "floor_id": "second-floor", "customer_id": "c", "stage": "quotation"}])
    profile = await module.CustomerSearchService(database).profile(principal(custom_access=True), "walkin", "old", "second-floor")
    assert profile["records"] == []
    assert "quotation" not in repr(profile)


@pytest.mark.asyncio
async def test_tile_completed_quantity_evidence_does_not_resurrect_its_ordered_quote(allow_all):
    database = Database(customers=[{"id": "c", "floor_id": "ground-floor", "name": "Meena"}],
        quotations=[{"id": "basis", "customer_id": "c", "floor_id": "ground-floor", "status": "ordered"}],
        customer_orders=[{"id": "o", "customer_id": "c", "floor_id": "ground-floor", "quotation_id": "basis", "overall_status": "Ready"}],
        purchase_orders=[{"id": "po", "customer_order_id": "o", "floor_id": "ground-floor", "items": [{"id": "i", "qty": 5, "boxes_dispatched": 5}]}],
        dispatches=[{"id": "d", "customer_order_id": "o", "floor_id": "ground-floor"}])
    profile = await module.CustomerSearchService(database).profile(principal(), "customer", "c", "ground-floor")
    assert profile["records"] == []


def test_kitchen_current_quote_uses_saved_design_basis_until_explicit_resave():
    row = {"workflow_cycle": 2, "final_design_version_id": "new-final",
        "design_versions": [{"id": "previous-final", "workflow_cycle": 2}, {"id": "new-final", "workflow_cycle": 2}],
        "quotation_versions": [{"id": "quote", "number": 3, "design_version_id": "previous-final", "amount": 120}]}
    assert module.current_data("kitchen", row, "quotation")["number"] == 3
    row["design_versions"][0]["workflow_cycle"] = 1
    assert "number" not in module.current_data("kitchen", row, "quotation")


def test_generated_internal_kitchen_reference_is_hidden_but_business_numbers_remain():
    assert module.display_reference("KIT-7779AA0A0C965C85") is None
    assert module.display_reference("Quotation 3") == "Quotation 3"
    assert module.display_reference("FQ-2026-0243") == "FQ-2026-0243"
