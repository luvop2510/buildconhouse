"""Key-based discard uses the same exclusive admission as document deletion."""
import asyncio
from contextlib import asynccontextmanager

import pytest

from services import mutation_admission


@pytest.mark.parametrize("method,path,exclusive", [
    ("DELETE", "/api/quotations/client-draft/draft-key", True),
    ("DELETE", "/api/quotations/document-id", True),
    ("DELETE", "/api/customers/customer-id", True),
    ("POST", "/api/quotations", False),
    ("PATCH", "/api/quotations/document-id", False),
    ("DELETE", "/api/quotations/document-id/whatsapp-draft", False),
])
def test_admission_matches_tile_discard_and_preserves_other_routes(monkeypatch, method, path, exclusive):
    calls = []
    @asynccontextmanager
    async def admitted(database, *, exclusive=False):
        calls.append(exclusive)
        yield
    monkeypatch.setattr(mutation_admission, "admission", admitted)
    async def app(scope, receive, send):
        calls.append("handled")
    asyncio.run(mutation_admission.MutationAdmissionMiddleware(app)(
        {"type": "http", "method": method, "path": path}, None, None,
    ))
    assert calls == [exclusive, "handled"]
