"""Incomplete tile drafts save immediately; first creation has no serial line reads."""
import asyncio
from types import SimpleNamespace

from bson import ObjectId
from fastapi.encoders import jsonable_encoder
import pytest

from models import QuotationCreate, QuotationUpdate, UserPublic
from routes import quotation_routes as routes


def user():
    return UserPublic(id="sales", email="sales@test.example", full_name="Sales", role="sales",
                      floor_ids=["ground-floor"], active_floor_id="ground-floor")


async def noop(*args, **kwargs):
    return None


class Quotes:
    def __init__(self):
        self.documents = []

    async def insert_one(self, document):
        # Model actual Mongo mutation at the HTTP serialization boundary.
        document["_id"] = ObjectId()
        self.documents.append(document)

    async def update_one(self, query, update):
        self.documents[0].update(update["$set"])

    async def find_one(self, query, projection=None):
        return {k: v for k, v in self.documents[0].items() if k != "_id"}


@pytest.mark.parametrize("items", [[], [
    {"product_id": "p1", "sku": "P1", "name": "Tile 1", "qty": 1, "unit_price": 100},
    {"product_id": "p2", "sku": "P2", "name": "Tile 2", "qty": 2, "unit_price": 200},
]])
def test_tile_draft_create_and_update_accept_missing_address_and_retain_photo(monkeypatch, items):
    async def run():
        quotes = Quotes()
        called = set()
        def products(query, *args, **kwargs):
            ids = query["id"]["$in"]
            called.update(ids)
            async def to_list(limit):
                return [{"id": product_id, "category_id": "tile", "floor_id": "ground-floor"}
                        for product_id in ids][:limit]
            return SimpleNamespace(to_list=to_list)
        database = SimpleNamespace(quotations=quotes, customers=object(), products=SimpleNamespace(find=products))
        monkeypatch.setattr(routes, "db", database)
        async def scoped(collection, record_id, *args, **kwargs):
            if collection is database.customers:
                return {"id": "c1", "name": "Draft Customer", "phone": "9900000000"}
            return await quotes.find_one({"id": record_id})
        async def canonical(lines, floor):
            return [line.model_dump() if hasattr(line, "model_dump") else dict(line) for line in lines]
        async def number():
            return "FQ-2026-001"
        monkeypatch.setattr(routes, "get_floor_scoped_or_404", scoped)
        monkeypatch.setattr(routes, "_canonicalize_item_images", canonical)
        monkeypatch.setattr(routes, "_next_number", number)
        monkeypatch.setattr(routes, "log_event", noop)
        monkeypatch.setattr(routes, "_track_product_usage", noop)
        monkeypatch.setattr(routes, "reconcile_followups_admitted", noop)
        lines = [{**line, "image": "https://cdn.example.test/saved-photo.png"} for line in items]
        created = await asyncio.wait_for(routes.create_quotation(
            QuotationCreate(customer_id="c1", doc_type="tiles_quotation", address_snapshot="", items=lines), user=user()), 1)
        assert created.floor_id == "ground-floor"
        assert created.status == "draft"
        assert created.address_snapshot == ""
        assert "_id" not in jsonable_encoder(created)
        edited = await routes.update_quotation(created.id, QuotationUpdate(address_snapshot="", notes="partial details", silent=True), user=user())
        assert edited.notes == "partial details"
        assert len(edited.items) == len(items)
        assert all(line.image == "https://cdn.example.test/saved-photo.png" for line in edited.items)
        assert len(quotes.documents) == 1
        assert called == {line["product_id"] for line in items}
    asyncio.run(run())


@pytest.fixture
def keyed_drafts(monkeypatch):
    """Mongo-faithful unique receipt + serialized atomic transaction fake."""
    import db as database_module
    from pymongo.errors import DuplicateKeyError
    documents = {}
    receipts = {}
    lock = asyncio.Lock()
    class Settings:
        async def find_one(self, query, projection=None):
            await asyncio.sleep(0)
            return receipts.get(query["_id"])
        async def insert_one(self, document, **kwargs):
            if document["_id"] in receipts:
                raise DuplicateKeyError("duplicate receipt")
            receipts[document["_id"]] = dict(document)
    class Quotations:
        async def find_one(self, query, projection=None):
            doc = documents.get(query["id"])
            return dict(doc) if doc and all(doc.get(k) == v for k, v in query.items()) else None
        async def insert_one(self, document, **kwargs):
            document["_id"] = ObjectId()
            documents[document["id"]] = {k: v for k, v in document.items() if k != "_id"}
    class Session:
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            return None
        async def with_transaction(self, callback):
            async with lock:
                return await callback(self)
    class Client:
        async def start_session(self):
            return Session()
    database = SimpleNamespace(settings=Settings(), quotations=Quotations(), customers=object())
    async def scoped(*args, **kwargs):
        return {"id": "c1", "name": "Draft Customer"}
    async def canonical(lines, floor):
        return []
    async def number():
        await asyncio.sleep(0)
        return "FQ-2026-001"
    monkeypatch.setattr(routes, "db", database)
    monkeypatch.setattr(database_module, "client", Client())
    monkeypatch.setattr(routes, "get_floor_scoped_or_404", scoped)
    monkeypatch.setattr(routes, "_canonicalize_item_images", canonical)
    monkeypatch.setattr(routes, "_next_number", number)
    monkeypatch.setattr(routes, "log_event", noop)
    monkeypatch.setattr(routes, "reconcile_followups_admitted", noop)
    return documents, receipts


def keyed_body(**kwargs):
    return QuotationCreate(client_draft_id="9ca539c7-1bca-42d8-8074-4f6e6e891c93", customer_id="c1",
                           doc_type="tiles_quotation", **kwargs)


def test_lost_create_response_recovers_original_draft_without_duplicate(keyed_drafts):
    async def run():
        original = await routes.create_quotation(keyed_body(), user=user())
        # The response is discarded as if the connection closed after commit.
        replay = await routes.create_quotation(keyed_body(), user=user())
        assert replay.id == original.id
        assert len(keyed_drafts[0]) == len(keyed_drafts[1]) == 1
        assert jsonable_encoder(replay)["status"] == "draft"
    asyncio.run(run())


def test_concurrent_creates_share_one_atomic_receipt_and_document(keyed_drafts):
    async def run():
        responses = await asyncio.gather(*[routes.create_quotation(keyed_body(), user=user()) for _ in range(4)])
        assert len({response.id for response in responses}) == 1
        assert len(keyed_drafts[0]) == len(keyed_drafts[1]) == 1
    asyncio.run(run())


def test_deleted_draft_is_not_resurrected_by_a_delayed_create_retry(keyed_drafts):
    from fastapi import HTTPException
    async def run():
        await routes.create_quotation(keyed_body(), user=user())
        keyed_drafts[0].clear()
        with pytest.raises(HTTPException) as exc:
            await routes.create_quotation(keyed_body(), user=user())
        assert exc.value.status_code == 410
        assert not keyed_drafts[0]
        assert len(keyed_drafts[1]) == 1
    asyncio.run(run())


def test_draft_receipt_is_bound_to_actor_and_document_family(keyed_drafts):
    async def run():
        first = await routes.create_quotation(keyed_body(), user=user())
        second = await routes.create_quotation(keyed_body(), user=user().model_copy(update={"id": "other-sales"}))
        assert first.id != second.id
        assert len(keyed_drafts[0]) == len(keyed_drafts[1]) == 2
    asyncio.run(run())


def test_customer_lost_response_and_concurrent_retry_reuse_one_ground_contact(keyed_drafts, monkeypatch):
    from models import CustomerCreate
    from routes import customer_routes
    contacts = {}
    class Customers:
        async def find_one(self, query, projection=None):
            return next((dict(doc) for doc in contacts.values() if all(doc.get(key) == value for key, value in query.items())), None)
        async def insert_one(self, document, **kwargs):
            document["_id"] = ObjectId()
            contacts[document["id"]] = {key: value for key, value in document.items() if key != "_id"}
    routes.db.customers = Customers()
    monkeypatch.setattr(customer_routes, "db", routes.db)
    monkeypatch.setattr(customer_routes, "log_event", noop)
    body = CustomerCreate(name="Ground draft contact", client_draft_id=keyed_body().client_draft_id)
    async def run():
        responses = await asyncio.gather(*[customer_routes.create_customer(body, user=user()) for _ in range(4)])
        recovered = await customer_routes.create_customer(body, user=user())
        assert {response.id for response in responses} == {recovered.id}
        assert len(contacts) == len(keyed_drafts[1]) == 1
        assert recovered.floor_id == "ground-floor"
        assert "password_hash" not in jsonable_encoder(recovered)
        contacts.clear()
        from fastapi import HTTPException
        with pytest.raises(HTTPException) as exc:
            await customer_routes.create_customer(body, user=user())
        assert exc.value.status_code == 410
        assert not contacts
    asyncio.run(run())


def test_keyed_customer_creation_cannot_switch_sanitary_contact_to_ground(keyed_drafts):
    from models import CustomerCreate
    from routes import customer_routes
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc:
        asyncio.run(customer_routes.create_customer(CustomerCreate(name="Draft", client_draft_id=keyed_body().client_draft_id),
                    user=user().model_copy(update={"active_floor_id": "first-floor", "floor_ids": ["first-floor"]})))
    assert exc.value.status_code == 422


def test_large_quotation_product_reads_use_one_bounded_batch(monkeypatch):
    from models import QuotationLineItem
    async def run():
        queries = []
        def products(query, *args):
            queries.append(query)
            async def to_list(limit):
                assert limit == 100
                return [{"id": product_id} for product_id in query["id"]["$in"]]
            return SimpleNamespace(to_list=to_list)
        monkeypatch.setattr(routes, "db", SimpleNamespace(products=SimpleNamespace(find=products)))
        lines = [QuotationLineItem(product_id=f"p{i}", sku=str(i), name="Tile", qty=1, unit_price=100) for i in range(100)]
        rows = await routes._quotation_catalog_products(lines, user(), floor_id="ground-floor")
        assert [row["id"] for row in rows] == [line.product_id for line in lines]
        assert len(queries) == 1
        assert queries[0]["floor_id"] == "ground-floor"
    asyncio.run(run())


def test_replayed_draft_reports_original_revision_and_current_external_changes(keyed_drafts):
    async def run():
        original = await routes.create_quotation(keyed_body(), user=user())
        assert original.create_replayed is False
        replay = await routes.get_client_tile_draft(keyed_body().client_draft_id, "tiles_quotation", user=user())
        assert replay.create_replayed is True
        assert replay.create_original_updated_at == original.updated_at == replay.updated_at
        assert "create_replayed" not in keyed_drafts[0][original.id]
        keyed_drafts[0][original.id].update(updated_at="2026-11-01T00:00:00+00:00", status="ordered")
        changed = await routes.create_quotation(keyed_body(), user=user())
        assert changed.create_original_updated_at != changed.updated_at
        assert changed.status == "ordered"
    asyncio.run(run())


def test_cancelled_draft_key_prevents_late_create_and_is_idempotent(keyed_drafts):
    from fastapi import HTTPException
    async def run():
        for _ in range(2):
            cancelled = await routes.cancel_client_tile_draft(keyed_body().client_draft_id, "tiles_quotation", user=user())
            assert cancelled["ok"] is True
        with pytest.raises(HTTPException) as exc:
            await routes.create_quotation(keyed_body(), user=user())
        assert exc.value.status_code == 410
        assert not keyed_drafts[0]
        assert len(keyed_drafts[1]) == 1
    asyncio.run(run())


def test_key_discard_reuses_ordered_document_deletion_guard(keyed_drafts, monkeypatch):
    from fastapi import HTTPException
    async def run():
        original = await routes.create_quotation(keyed_body(), user=user())
        keyed_drafts[0][original.id]["status"] = "ordered"
        async def protected_delete(quotation_id, user):
            assert quotation_id == original.id
            raise HTTPException(409, "This quotation has an order")
        monkeypatch.setattr(routes, "delete_quotation", protected_delete)
        with pytest.raises(HTTPException) as exc:
            await routes.cancel_client_tile_draft(keyed_body().client_draft_id, "tiles_quotation", user=user())
        assert exc.value.status_code == 409
        assert keyed_drafts[0][original.id]["status"] == "ordered"
        assert not next(iter(keyed_drafts[1].values())).get("cancelled")
    asyncio.run(run())


@pytest.mark.parametrize("change_before_read", [True, False])
def test_recovery_patch_never_overwrites_a_newer_revision(monkeypatch, change_before_read):
    from fastapi import HTTPException
    document = {"id": "q1", "number": "Q1", "floor_id": "ground-floor", "doc_type": "tiles_quotation",
                "customer_id": "c1", "customer_name": "Draft", "created_by": "sales", "status": "draft",
                "updated_at": "newer" if change_before_read else "original"}
    class Quotations:
        async def update_one(self, selector, update):
            assert selector == {"id": "q1", "updated_at": "original"}
            document.update(updated_at="newer", notes="external edit")
            return SimpleNamespace(matched_count=0)
    database = SimpleNamespace(quotations=Quotations())
    monkeypatch.setattr(routes, "db", database)
    async def scoped(*args, **kwargs):
        return dict(document)
    monkeypatch.setattr(routes, "get_floor_scoped_or_404", scoped)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(routes.update_quotation("q1", QuotationUpdate(notes="old recovered draft", silent=True,
                                      expected_updated_at="original"), user=user()))
    assert exc.value.status_code == 409
    assert document.get("notes") != "old recovered draft"
