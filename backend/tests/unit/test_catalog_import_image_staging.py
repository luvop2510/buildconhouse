"""Embedded supplier images must be staged in private Supabase, never BSON."""
from __future__ import annotations

import asyncio
import base64
from types import SimpleNamespace

import catalog_pipeline.orchestrator as orchestrator


class _Blobs:
    def __init__(self):
        self.docs: dict[str, dict] = {}

    async def find_one(self, query, *_args, **_kwargs):
        row = self.docs.get(query["sha1"])
        return dict(row) if row else None

    async def update_one(self, query, update, upsert=False):
        key = query["sha1"]
        row = self.docs.setdefault(key, {})
        if not row:
            row.update(update.get("$setOnInsert", {}))
        row.update(update.get("$set", {}))


class _Storage:
    def __init__(self):
        self.objects: dict[tuple[str, str], tuple[bytes, str]] = {}

    async def exists(self, *, bucket, key):
        return (bucket, key) in self.objects

    async def upload(self, *, bucket, key, data, content_type, **_kwargs):
        self.objects[(bucket, key)] = (data, content_type)

    async def download(self, *, bucket, key):
        return self.objects[(bucket, key)][0]


def test_embedded_import_image_is_private_supabase_staged_and_resolvable(monkeypatch):
    blobs = _Blobs()
    storage = _Storage()
    monkeypatch.setattr(orchestrator, "db", SimpleNamespace(catalog_image_blobs=blobs))
    monkeypatch.setattr(orchestrator, "get_media_storage", lambda: storage)
    monkeypatch.setattr(orchestrator, "private_bucket", lambda: "forge-private")

    raw = b"supplier-image-bytes"
    data_url = "data:image/png;base64," + base64.b64encode(raw).decode("ascii")
    rows = [{"images": [data_url], "image_meta": [{}]}]

    asyncio.run(orchestrator._offload_row_images(rows))

    ref = rows[0]["images"][0]
    assert ref.startswith("blob:")
    sha1 = ref.removeprefix("blob:")
    staged = blobs.docs[sha1]
    assert "data_url" not in staged
    assert staged["bucket"] == "forge-private"
    assert storage.objects[("forge-private", staged["storage_key"])] == (raw, "image/png")
    assert asyncio.run(orchestrator._resolve_blob(ref)) == data_url
