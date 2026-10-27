"""Canonical Kitchen identity protections beyond the aggregate commands."""
from types import SimpleNamespace

import pytest

from services.customer_data_reset import reset_customer_data


class Session:
    async def __aenter__(self):
        return self
    async def __aexit__(self, *args):
        pass
    async def with_transaction(self, operation, **kwargs):
        return await operation(self)


class Client:
    async def start_session(self):
        return Session()


class Lookup:
    def __init__(self, row):
        self.row = row
    async def find_one(self, *args, **kwargs):
        return self.row


@pytest.mark.asyncio
@pytest.mark.parametrize("project,pin", [(True, False), (False, True)])
async def test_historical_reset_fails_before_deletes_for_kitchen_identity(monkeypatch, project, pin):
    monkeypatch.setenv("FORGE_CUSTOMER_RESET_MAINTENANCE", "true")
    database = SimpleNamespace(settings=Lookup(None), kitchen_projects=Lookup({"id": "p"} if project else None),
                               customers=Lookup({"id": "c"} if pin else None))
    with pytest.raises(RuntimeError, match="Kitchen-linked"):
        await reset_customer_data(database, Client(), request_id="customer-reset-20261010")
