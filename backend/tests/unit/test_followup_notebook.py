import pytest
from types import SimpleNamespace

from services.followup_notebook import (
    NOTEBOOK_FIELDS,
    QUOTATION_FIELDS,
    NotebookValidationError,
    NotebookConflictError,
    complete_notebook_row,
    convert_notebook_row,
    normalize_mobile,
    notebook_query,
    notebook_search_query,
    patch_notebook_row,
    resolve_or_create_customer,
    serialize_notebook_row,
    timeline_event_for_field,
    validate_notebook_patch,
)


class _Cursor:
    def __init__(self, rows):
        self.rows = rows

    async def to_list(self, _limit):
        return list(self.rows)


class _Result:
    def __init__(self, matched_count):
        self.matched_count = matched_count


class _Collection:
    def __init__(self, rows=None):
        self.rows = list(rows or [])

    @staticmethod
    def _matches(row, query):
        if "$and" in query:
            return all(_Collection._matches(row, part) for part in query["$and"])
        if "$or" in query:
            return any(_Collection._matches(row, part) for part in query["$or"])
        for key, value in query.items():
            if isinstance(value, dict) and "$exists" in value:
                if (key in row) != value["$exists"]:
                    return False
            elif isinstance(value, dict) and "$type" in value:
                if value["$type"] == "string" and not isinstance(row.get(key), str):
                    return False
            elif isinstance(value, dict) and "$in" in value:
                if row.get(key) not in value["$in"]:
                    return False
            elif isinstance(value, dict) and "$regex" in value:
                if value["$regex"].lower() not in str(row.get(key) or "").lower():
                    return False
            elif row.get(key) != value:
                return False
        return True

    async def find_one(self, query, _projection=None):
        for row in self.rows:
            if self._matches(row, query):
                return dict(row)
        return None

    def find(self, query, _projection=None):
        return _Cursor([dict(row) for row in self.rows if self._matches(row, query)])

    async def insert_one(self, document):
        self.rows.append(dict(document))

    async def update_one(self, query, update):
        for index, row in enumerate(self.rows):
            if self._matches(row, query):
                self.rows[index] = {**row, **update.get("$set", {})}
                return _Result(1)
        return _Result(0)


class _Db:
    def __init__(self, *, customers=None, followups=None, quotations=None):
        self.customers = _Collection(customers)
        self.followups = _Collection(followups)
        self.quotations = _Collection(quotations)


def test_normalize_mobile_accepts_indian_formatting():
    assert normalize_mobile("+91 99099-06652") == "9909906652"
    assert normalize_mobile("9909906652") == "9909906652"


def test_notebook_contract_rejects_unlisted_fields():
    with pytest.raises(NotebookValidationError, match="unsupported field"):
        validate_notebook_patch({"project_stage": "production"}, converted=False, current={})


def test_notebook_contract_requires_identity_and_kitchen_type():
    with pytest.raises(NotebookValidationError, match="customer_phone"):
        validate_notebook_patch(
            {"customer_name": "A", "kitchen_type": "GI"}, converted=False, current={}, creating=True,
        )
    with pytest.raises(NotebookValidationError, match="kitchen_type"):
        validate_notebook_patch(
            {"customer_name": "A", "customer_phone": "9909906652", "kitchen_type": "Wood"},
            converted=False, current={}, creating=True,
        )
    with pytest.raises(NotebookValidationError, match="10 digits"):
        validate_notebook_patch(
            {"customer_name": "A", "customer_phone": "99099", "kitchen_type": "GI"},
            converted=False, current={}, creating=True,
        )


def test_furniture_contract_does_not_require_or_accept_kitchen_type():
    assert validate_notebook_patch(
        {"customer_name": "A", "customer_phone": "9909906652"},
        converted=False, current={}, creating=True, floor_id="third-floor",
    )["customer_name"] == "A"
    with pytest.raises(NotebookValidationError, match="only available on Kitchen"):
        validate_notebook_patch(
            {"kitchen_type": "GI"}, converted=False, current={}, floor_id="third-floor",
        )


def test_notebook_api_is_limited_to_kitchen_and_furniture_floors():
    from fastapi import HTTPException
    from routes.followup_routes import require_notebook_floor

    user = SimpleNamespace(active_floor_id="first-floor", floor_ids=["first-floor"], role="sales")
    with pytest.raises(HTTPException, match="Kitchen or Furniture"):
        require_notebook_floor("first-floor", user)


def test_quotation_fields_are_rejected_before_conversion():
    with pytest.raises(NotebookValidationError, match="require conversion"):
        validate_notebook_patch({"quotation_price": 100}, converted=False, current={})
    assert QUOTATION_FIELDS == {"quotation_price"}


def test_lost_requires_notes():
    with pytest.raises(NotebookValidationError, match="Notes"):
        validate_notebook_patch({"notebook_status": "lost"}, converted=False, current={"notes": ""})


def test_won_followup_is_locked_but_quotation_fields_can_change():
    current = {"notebook_status": "won", "is_converted": True}
    with pytest.raises(NotebookValidationError, match="locked"):
        validate_notebook_patch({"notes": "change"}, converted=True, current=current)
    assert validate_notebook_patch({"quotation_price": 100}, converted=True, current=current) == {"quotation_price": 100}


def test_projection_hides_shared_followup_metadata_and_adds_quote_fields_only_after_conversion():
    source = {
        "id": "1", "customer_name": "A", "customer_phone": "9909906652", "notebook_status": "new",
        "priority_score": 90, "reason": "internal", "is_converted": False,
    }
    row = serialize_notebook_row(source)
    assert row["status"] == "new"
    assert "priority_score" not in row and "reason" not in row
    assert "quotation_price" not in row
    converted = serialize_notebook_row({**source, "is_converted": True, "quotation_price": 100})
    assert converted["quotation_price"] == 100


def test_search_query_contains_only_notebook_text_fields():
    query = notebook_search_query("architect")
    fields = {next(iter(item)) for item in query["$or"]}
    assert fields == {
        "customer_name", "customer_phone", "address", "architect_interior_designer", "referred_by", "notes",
    }
    assert "quotation_price" not in fields


def test_notebook_query_is_pinned_to_the_url_floor_not_the_active_floor():
    user = SimpleNamespace(active_floor_id="first-floor", floor_ids=["first-floor", "second-floor"], role="sales")
    assert notebook_query(user, "second-floor", {"id": "row-1"}) == {
        "floor_id": "second-floor", "notebook_key": {"$type": "string"}, "id": "row-1",
    }


def test_timeline_event_names_are_stable():
    assert timeline_event_for_field("notebook_status", "new", "won")[0] == "project_followup.status_changed"
    assert timeline_event_for_field("quotation_price", None, 100)[0] == "project_followup.quotation_updated"
    assert timeline_event_for_field("customer_name", "A", "B")[0] == "project_followup.customer_updated"
    assert timeline_event_for_field("notes", "A", "B")[0] == "project_followup.edited"


class _ChainCursor(_Cursor):
    def sort(self, _fields):
        return self

    def limit(self, _size):
        return self


@pytest.mark.asyncio
async def test_notebook_list_is_floor_scoped_and_search_excludes_quote_fields(monkeypatch):
    from routes import followup_routes

    class _FollowupCollection(_Collection):
        def find(self, query, _projection=None):
            return _ChainCursor([dict(row) for row in self.rows if self._matches(row, query)])

    followups = _FollowupCollection([
        {"id": "k1", "floor_id": "second-floor", "notebook_key": "second-floor:c1", "is_converted": False,
         "customer_name": "Kitchen", "notebook_status": "new", "updated_at": "2"},
        # Shared Followup documents are serialized with notebook_key=None;
        # they must never bleed into the notebook projection.
        {"id": "legacy", "floor_id": "second-floor", "notebook_key": None, "is_converted": False,
         "customer_name": "Legacy CRM", "notebook_status": "new", "updated_at": "3"},
        {"id": "f1", "floor_id": "third-floor", "notebook_key": "third-floor:c2", "is_converted": False,
         "customer_name": "Furniture", "notebook_status": "new", "updated_at": "1"},
    ])
    monkeypatch.setattr(followup_routes, "db", SimpleNamespace(followups=followups))
    user = SimpleNamespace(active_floor_id="second-floor", floor_ids=["second-floor"], role="sales")
    result = await followup_routes.list_notebook(
        "second-floor", view="followups", status=None, q="Kitchen", cursor=None, limit=10, user=user,
    )
    assert [row["id"] for row in result["rows"]] == ["k1"]
    assert result["next_cursor"] is None
    query = notebook_search_query("Kitchen")
    assert all("quotation" not in str(item).lower() for item in query["$or"])


@pytest.mark.asyncio
async def test_create_notebook_reuses_the_same_floor_customer_row(monkeypatch):
    from models import NotebookFollowupCreatePayload
    from routes import followup_routes

    db = _Db()

    async def _log_event(**_kwargs):
        return None

    monkeypatch.setattr(followup_routes, "db", db)
    monkeypatch.setattr(followup_routes, "log_event", _log_event)
    # Notebook retries stay inside the currently selected floor.
    user = SimpleNamespace(active_floor_id="second-floor", floor_ids=["first-floor", "second-floor"], role="sales")
    body = NotebookFollowupCreatePayload(
        customer_name="A", customer_phone="9909906652", kitchen_type="GI",
    )

    first = await followup_routes.create_notebook_row("second-floor", body, user)
    second = await followup_routes.create_notebook_row("second-floor", body, user)

    assert first["id"] == second["id"]
    assert len(db.followups.rows) == 1
    assert len(db.customers.rows) == 1
    assert {row["customer_id"] for row in db.followups.rows} == {db.customers.rows[0]["id"]}


@pytest.mark.asyncio
async def test_resolve_or_create_customer_reuses_floor_scoped_mobile(monkeypatch):
    db = _Db(customers=[{"id": "c1", "name": "Existing", "phone": "+91 9909906652", "floor_id": "second-floor"}])
    user = object()
    customer = await resolve_or_create_customer(
        db, user=user, floor_id="second-floor", name="New Name", phone="9909906652", address=None,
    )
    assert customer["id"] == "c1"
    assert len(db.customers.rows) == 1


@pytest.mark.asyncio
async def test_patch_notebook_row_updates_only_one_field_and_revision(monkeypatch):
    db = _Db(followups=[{
        "id": "f1", "floor_id": "second-floor", "notebook_key": "second-floor:c1",
        "customer_name": "A", "customer_phone": "9909906652", "kitchen_type": "GI",
        "notebook_status": "new", "notes": "", "updated_at": "v1", "is_converted": False,
    }])
    row = await patch_notebook_row(
        db, user=object(), floor_id="second-floor", row_id="f1",
        patch={"address": "New address"}, expected_updated_at="v1",
    )
    assert row["address"] == "New address"
    assert row["notes"] == ""
    assert db.followups.rows[0]["customer_name"] == "A"
    assert db.followups.rows[0]["updated_at"] != "v1"


@pytest.mark.asyncio
async def test_furniture_patch_conflict_identifies_the_cell_to_reload_and_highlight():
    db = _Db(followups=[{
        "id": "furniture-1", "floor_id": "third-floor", "notebook_key": "third-floor:c1",
        "customer_name": "A", "customer_phone": "9909906652", "notebook_status": "pending",
        "notes": "Current server note", "updated_at": "v2", "is_converted": False,
    }])
    with pytest.raises(NotebookConflictError) as error:
        await patch_notebook_row(
            db, user=object(), floor_id="third-floor", row_id="furniture-1",
            patch={"notes": "Stale client note"}, expected_updated_at="v1",
        )
    assert error.value.row["notes"] == "Current server note"
    assert error.value.changed_fields == ["notes"]


@pytest.mark.asyncio
async def test_furniture_customer_edit_emits_the_customer_updated_audit_event(monkeypatch):
    from models import NotebookCellPatchPayload
    from routes import followup_routes

    db = _Db(followups=[{
        "id": "furniture-1", "floor_id": "third-floor", "notebook_key": "third-floor:c1",
        "customer_id": "c1", "customer_name": "Before", "customer_phone": "9909906652",
        "notebook_status": "new", "notes": "", "updated_at": "v1", "is_converted": False,
    }])
    events = []

    async def _log_event(**event):
        events.append(event)

    monkeypatch.setattr(followup_routes, "db", db)
    monkeypatch.setattr(followup_routes, "log_event", _log_event)
    user = SimpleNamespace(active_floor_id="third-floor", floor_ids=["third-floor"], role="sales")
    await followup_routes.patch_notebook(
        "third-floor", "furniture-1",
        NotebookCellPatchPayload(field="customer_name", value="After", updated_at="v1"), user,
    )
    assert events[0]["event_type"] == "project_followup.customer_updated"
    assert events[0]["floor_id"] == "third-floor"


def test_invalid_notebook_cursor_is_a_client_error_not_an_internal_error():
    from fastapi import HTTPException
    from routes.followup_routes import _decode_notebook_cursor

    with pytest.raises(HTTPException) as error:
        _decode_notebook_cursor("not-a-base64-cursor")
    assert error.value.status_code == 400


@pytest.mark.asyncio
async def test_conversion_updates_same_row_and_is_idempotent(monkeypatch):
    db = _Db(followups=[{
        "id": "f1", "floor_id": "second-floor", "notebook_key": "second-floor:c1",
        "customer_name": "A", "customer_phone": "9909906652", "kitchen_type": "GI",
        "notebook_status": "new", "notes": "Ready", "updated_at": "v1", "is_converted": False,
    }])
    row = await convert_notebook_row(
        db, user=object(), floor_id="second-floor", row_id="f1",
        patch={"quotation_price": 100},
        expected_updated_at="v1",
    )
    assert row["is_converted"] is True
    assert db.followups.rows[0]["id"] == "f1"
    retry = await convert_notebook_row(
        db, user=object(), floor_id="second-floor", row_id="f1",
        patch={}, expected_updated_at="stale",
    )
    assert retry["id"] == "f1" and retry["quotation_price"] == 100


@pytest.mark.asyncio
async def test_furniture_conversion_requires_and_stores_a_price():
    db = _Db(followups=[{
        "id": "furniture-1", "floor_id": "third-floor", "notebook_key": "third-floor:c1",
        "customer_name": "A", "customer_phone": "9909906652", "notebook_status": "new",
        "notes": "", "updated_at": "v1", "is_converted": False,
    }])
    with pytest.raises(NotebookValidationError, match="quotation_price is required"):
        await convert_notebook_row(
            db, user=object(), floor_id="third-floor", row_id="furniture-1", patch={}, expected_updated_at="v1",
        )
    row = await convert_notebook_row(
        db, user=object(), floor_id="third-floor", row_id="furniture-1", patch={"quotation_price": 25000}, expected_updated_at="v1",
    )
    assert row["is_converted"] is True and row["quotation_price"] == 25000


@pytest.mark.asyncio
async def test_conversion_keeps_the_lead_active_as_a_quotation_followup():
    db = _Db(followups=[{
        "id": "f1", "floor_id": "second-floor", "notebook_key": "second-floor:c1",
        "customer_name": "A", "customer_phone": "9909906652", "kitchen_type": "GI",
        "notebook_status": "new", "status": "open", "updated_at": "v1", "is_converted": False,
    }])
    await convert_notebook_row(
        db, user=object(), floor_id="second-floor", row_id="f1",
        patch={"quotation_price": 50000}, expected_updated_at="v1",
    )
    assert db.followups.rows[0]["notebook_status"] == "pending"
    assert db.followups.rows[0]["status"] == "open"
    assert db.followups.rows[0]["converted_at"]


@pytest.mark.asyncio
async def test_lost_outcome_requires_reason_and_closes_shared_followup():
    db = _Db(followups=[{
        "id": "f1", "floor_id": "third-floor", "notebook_key": "third-floor:c1",
        "customer_name": "A", "customer_phone": "9909906652", "notebook_status": "pending",
        "status": "open", "updated_at": "v1", "is_converted": True,
    }])
    with pytest.raises(NotebookValidationError, match="lost reason"):
        await complete_notebook_row(
            db, user=object(), floor_id="third-floor", row_id="f1", outcome="lost",
            lost_reason="", expected_updated_at="v1",
        )
    row = await complete_notebook_row(
        db, user=object(), floor_id="third-floor", row_id="f1", outcome="lost",
        lost_reason="Selected another vendor", expected_updated_at="v1",
    )
    assert row["status"] == "lost"
    assert db.followups.rows[0]["status"] == "dismissed"
    assert db.followups.rows[0]["completed_outcome"] == "lost"
    assert db.followups.rows[0]["lost_reason"] == "Selected another vendor"


@pytest.mark.asyncio
async def test_won_outcome_preserves_historical_note():
    db = _Db(followups=[{
        "id": "f1", "floor_id": "third-floor", "notebook_key": "third-floor:c1",
        "customer_id": "c1", "quotation_id": "q1",
        "customer_name": "A", "customer_phone": "9909906652", "notebook_status": "pending",
        "status": "open", "updated_at": "v1", "is_converted": True,
    }], quotations=[{"id": "q1", "floor_id": "third-floor", "customer_id": "c1", "status": "ordered"}])
    row = await complete_notebook_row(
        db, user=object(), floor_id="third-floor", row_id="f1", outcome="won",
        lost_reason=None, expected_updated_at="v1",
    )
    assert row["status"] == "won"
    assert row["notes"] == ""
    assert db.followups.rows[0]["resolution_note"] == "Client won"


@pytest.mark.asyncio
async def test_notebook_partner_assignment_updates_the_lead_and_customer(monkeypatch):
    from models import NotebookReferrerPayload
    from routes import followup_routes

    db = _Db(
        customers=[{"id": "c1", "floor_id": "third-floor", "name": "A"}],
        followups=[{
            "id": "f1", "floor_id": "third-floor", "notebook_key": "third-floor:c1",
            "customer_id": "c1", "customer_name": "A", "customer_phone": "9909906652",
            "notebook_status": "new", "status": "open", "updated_at": "v1", "is_converted": False,
        }],
    )
    db.referrers = _Collection([{
        "id": "r1", "floor_id": "third-floor", "name": "Aster Architects",
        "type": "architect", "active": True,
    }])
    events = []

    async def _log_event(**event):
        events.append(event)

    monkeypatch.setattr(followup_routes, "db", db)
    monkeypatch.setattr(followup_routes, "log_event", _log_event)
    user = SimpleNamespace(active_floor_id="third-floor", floor_ids=["third-floor"], role="sales")
    row = await followup_routes.assign_notebook_referrer(
        "third-floor", "f1", NotebookReferrerPayload(referrer_id="r1", updated_at="v1"), user,
    )

    assert row["referrer_name"] == "Aster Architects"
    assert db.followups.rows[0]["referrer_type"] == "architect"
    assert db.customers.rows[0]["referrer_id"] == "r1"
    assert events[0]["event_type"] == "project_followup.referrer_assigned"


@pytest.mark.parametrize("price", [float("nan"), float("inf"), float("-inf"), "NaN", "Infinity", "1e999", True])
def test_notebook_quotation_price_rejects_nonfinite_values(price):
    with pytest.raises(NotebookValidationError, match="finite number"):
        validate_notebook_patch({"quotation_price": price}, converted=True, current={})


def test_notebook_quotation_price_preserves_negative_validation_and_normalizes_numbers():
    with pytest.raises(NotebookValidationError, match="cannot be negative"):
        validate_notebook_patch({"quotation_price": -100}, converted=True, current={})
    assert validate_notebook_patch({"quotation_price": "12500.50"}, converted=True, current={}) == {"quotation_price": 12500.5}
