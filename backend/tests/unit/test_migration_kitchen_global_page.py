"""Never mistake an incompatible existing index for successful readiness."""
import importlib
from types import SimpleNamespace

import pytest
from pymongo.errors import OperationFailure

migration = importlib.import_module("migrations.0039_kitchen_global_search_page")


@pytest.mark.asyncio
@pytest.mark.parametrize("variant", [{}, {"sparse": True}, {"unique": True}, {"partialFilterExpression": {"active": True}}])
async def test_existing_global_page_index_is_accepted_only_when_equivalent(variant):
    class Collection:
        async def create_index(self, *_args, **_kwargs):
            raise OperationFailure("Existing index", code=85)

        async def index_information(self):
            return {"old_name": {"key": [("floor_id", 1), ("updated_at", -1), ("id", 1)], **variant}}

    database = SimpleNamespace(kitchen_projects=Collection())
    if variant:
        with pytest.raises(OperationFailure):
            await migration.up(database)
    else:
        await migration.up(database)
