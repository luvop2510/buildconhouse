import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from models import FollowupCallOutcomePayload, QuotationUpdate, UserPublic
from routes import followup_routes, quotation_routes
from services.followup_notebook import NotebookValidationError, complete_notebook_row, validate_notebook_patch
from services.order_confirmation import has_placed_order


class Quotations:
    def __init__(self, status="approved", floor="first-floor"):
        self.document = {"id": "q1", "customer_id": "c1", "floor_id": floor, "status": status}
        self.query = None
    async def find_one(self, query, *_args):
        self.query = query
        return self.document if all(self.document.get(k) == v for k, v in query.items()) else None


@pytest.mark.parametrize("status,floor,confirmed", [
    ("approved", "first-floor", False), ("won", "first-floor", False),
    ("ordered", "ground-floor", False), ("ordered", "first-floor", True),
])
def test_won_proof_requires_ordered_quotation_on_source_floor(status, floor, confirmed):
    quotations = Quotations(status, floor)
    db = SimpleNamespace(quotations=quotations)
    assert asyncio.run(has_placed_order(db, {"quotation_id": "q1", "floor_id": "first-floor"})) is confirmed
    assert quotations.query == {"id": "q1", "floor_id": "first-floor", "status": "ordered"}


def test_notebook_inline_patch_cannot_bypass_order_confirmation():
    with pytest.raises(NotebookValidationError, match="order is placed"):
        validate_notebook_patch({"notebook_status": "won"}, converted=True, current={"notebook_status": "pending"})


def test_notebook_won_does_not_update_an_unplaced_lead():
    row = {"id": "f1", "customer_id": "c1", "quotation_id": "q1", "floor_id": "first-floor", "notebook_status": "pending", "updated_at": "v1"}
    class Followups:
        async def find_one(self, *_args):
            return row
        async def update_one(self, *_args):
            pytest.fail("unplaced lead must not be updated")
    db = SimpleNamespace(followups=Followups(), quotations=Quotations())
    with pytest.raises(NotebookValidationError, match="order is placed"):
        asyncio.run(complete_notebook_row(db, user=object(), floor_id="first-floor", row_id="f1", outcome="won", lost_reason=None, expected_updated_at="v1"))


@pytest.mark.parametrize("outcome", ["won", "converted"])
def test_call_won_does_not_update_an_unplaced_lead(monkeypatch, outcome):
    class Followups:
        async def find_one(self, *_args):
            return {"id": "f1", "quotation_id": "q1", "floor_id": "first-floor"}
        async def update_one(self, *_args):
            pytest.fail("unplaced lead must not be updated")
    monkeypatch.setattr(followup_routes, "db", SimpleNamespace(followups=Followups(), quotations=Quotations()))
    user = UserPublic(email="sales@example.com", full_name="Sales", role="sales", floor_ids=["first-floor"], active_floor_id="first-floor")
    with pytest.raises(HTTPException) as error:
        asyncio.run(followup_routes.log_call("f1", FollowupCallOutcomePayload(outcome=outcome, notes="Accepted proposal"), user=user))
    assert error.value.status_code == 409


@pytest.mark.parametrize("outcome", ["won", "converted"])
def test_call_confirmation_retains_already_placed_order(monkeypatch, outcome):
    row = {"id": "f1", "quotation_id": "q1", "floor_id": "first-floor"}
    class Followups:
        async def find_one(self, *_args):
            return row
        async def update_one(self, _query, update):
            row.update(update["$set"])
    async def event(*_args, **_kwargs):
        return None
    monkeypatch.setattr(followup_routes, "db", SimpleNamespace(followups=Followups(), quotations=Quotations("ordered")))
    monkeypatch.setattr(followup_routes, "log_event", event)
    user = UserPublic(email="sales@example.com", full_name="Sales", role="sales", floor_ids=["first-floor"], active_floor_id="first-floor")
    result = asyncio.run(followup_routes.log_call("f1", FollowupCallOutcomePayload(outcome=outcome, notes="Placed order confirmed"), user=user))
    assert result["status"] == "done" and result["completed_outcome"] == outcome


@pytest.mark.parametrize("status,doc_type", [("won", "standard"), ("ordered", "standard"), ("won", "tiles_quotation")])
def test_quotation_patch_cannot_skip_place_order(monkeypatch, status, doc_type):
    async def scoped(*_args, **_kwargs):
        return {"id": "q1", "floor_id": "first-floor", "status": "sent", "doc_type": doc_type, "address_snapshot": "Address"}
    monkeypatch.setattr(quotation_routes, "get_floor_scoped_or_404", scoped)
    monkeypatch.setattr(quotation_routes, "db", SimpleNamespace(quotations=object()))
    user = UserPublic(email="sales@example.com", full_name="Sales", role="sales", floor_ids=["first-floor"], active_floor_id="first-floor")
    with pytest.raises(HTTPException) as error:
        asyncio.run(quotation_routes.update_quotation("q1", QuotationUpdate(status=status), user=user))
    assert error.value.status_code == 409
