import asyncio
import hashlib
import io
import json
from types import SimpleNamespace

import pytest
from PIL import Image

from media_storage.base import StorageError
from scripts import predeploy_media_integrity as gate


class Cursor:
    def __init__(self, rows):
        self.rows, self.offset, self.maximum = rows, 0, None

    def sort(self, *args):
        return self

    def skip(self, offset):
        self.offset = offset
        return self

    def limit(self, maximum):
        self.maximum = maximum
        return self

    async def to_list(self, maximum):
        take = self.maximum if self.maximum is not None else maximum
        return self.rows[self.offset:self.offset + take]


class Collection:
    def __init__(self, rows):
        self.rows = rows

    def find(self, *args):
        return Cursor(self.rows)


def fixture_rows(count):
    image = io.BytesIO()
    Image.new("RGB", (2, 3), "white").save(image, format="PNG")
    data = image.getvalue()
    rows = [{"id": f"m{index}", "product_id": "p", "bucket": "products",
             "storage_key": f"image-{index}", "size_bytes": len(data),
             "sha1": hashlib.sha1(data).hexdigest(), "mime": "image/png",
             "width": 2, "height": 3} for index in range(count)]
    database = SimpleNamespace(products=Collection([{"id": "p"}]), product_media=Collection(rows))
    return rows, data, database


class Storage:
    def __init__(self, data, failures=()):
        self.data, self.failures = data, failures
        self.active = self.peak = self.calls = 0
        self.closed = False

    async def download(self, *, bucket, key):
        self.active += 1
        self.peak = max(self.peak, self.active)
        self.calls += 1
        try:
            await asyncio.sleep(0.001)
            if key in self.failures:
                raise StorageError("Supabase download failed [404]: secret-token https://credentials.invalid")
            return self.data
        finally:
            self.active -= 1

    async def close(self):
        self.closed = True


@pytest.mark.asyncio
async def test_bounded_full_scan_counts_all_failures_and_persists_safe_report(monkeypatch, tmp_path, capsys):
    rows, data, database = fixture_rows(205)
    rows[0].pop("storage_key")
    storage = Storage(data, {"image-7"})
    monkeypatch.setattr(gate, "db", database)
    monkeypatch.setattr(gate, "get_media_storage", lambda: storage)
    output = tmp_path / "nested" / "media.json"
    assert await gate.main(31, 0, None, 4, output) == 1
    report = json.loads(output.read_text())
    assert report["scanned"] == report["planned"] == 205
    assert report["complete"] and report["full_scan"]
    assert report["counts"] == {"missing_object": 1, "missing_storage_reference": 1}
    assert storage.calls == 204 and storage.peak == 4 and storage.closed
    assert "secret-token" not in output.read_text()
    assert "credentials.invalid" not in output.read_text()
    missing = next(issue for issue in report["issues"] if issue["kind"] == "missing_object")
    assert missing["detail"] == {"error_type": "StorageError", "status_code": 404}
    messages = capsys.readouterr()
    assert "100/205" in messages.err and "200/205" in messages.err and "205/205" in messages.err
    assert "secret-token" not in messages.out + messages.err
    assert not list(output.parent.glob(".media.json.*"))


@pytest.mark.asyncio
async def test_smoke_cap_is_explicit_and_healthy_rows_pass(monkeypatch, tmp_path):
    _, data, database = fixture_rows(25)
    storage = Storage(data)
    monkeypatch.setattr(gate, "db", database)
    monkeypatch.setattr(gate, "get_media_storage", lambda: storage)
    output = tmp_path / "media.json"
    assert await gate.main(4, 0, 9, 8, output) == 0
    report = json.loads(output.read_text())
    assert report["scanned"] == report["planned"] == 9
    assert report["complete"] and not report["full_scan"]
    assert report["issues"] == [] and storage.calls == 9 and storage.peak <= 8


@pytest.mark.asyncio
async def test_unexpected_inspection_failure_is_incomplete_and_closes_storage(monkeypatch, tmp_path):
    _, data, database = fixture_rows(10)
    storage = Storage(data)
    monkeypatch.setattr(gate, "db", database)
    monkeypatch.setattr(gate, "get_media_storage", lambda: storage)

    def invalid_inspection(media, data):
        raise ValueError("secret credential in malformed metadata")

    monkeypatch.setattr(gate, "inspect_media_bytes", invalid_inspection)
    output = tmp_path / "media.json"
    assert await gate.main(4, 0, None, 4, output) == 1
    report = json.loads(output.read_text())
    assert report["scanned"] == 0 and report["planned"] == 10
    assert not report["complete"] and report["error"] == {"error_type": "ValueError"}
    assert "secret credential" not in output.read_text()
    assert storage.closed and storage.active == 0


@pytest.mark.asyncio
async def test_database_read_failure_does_not_pass_an_empty_scan(monkeypatch, tmp_path):
    class BrokenCollection:
        def find(self, *args):
            raise ConnectionError("secret connection URL")

    monkeypatch.setattr(gate, "db", SimpleNamespace(products=BrokenCollection()))
    monkeypatch.setattr(gate, "get_media_storage", lambda: pytest.fail("storage should not open"))
    output = tmp_path / "media.json"
    assert await gate.main(4, 0, None, 4, output) == 1
    report = json.loads(output.read_text())
    assert report["scanned"] == report["planned"] == 0
    assert not report["complete"] and report["error"] == {"error_type": "ConnectionError"}
    assert "secret connection URL" not in output.read_text()


@pytest.mark.asyncio
async def test_storage_close_failure_is_reported_as_incomplete(monkeypatch, tmp_path):
    _, data, database = fixture_rows(3)

    class BrokenCloseStorage(Storage):
        async def close(self):
            self.closed = True
            raise RuntimeError("private provider response")

    storage = BrokenCloseStorage(data)
    monkeypatch.setattr(gate, "db", database)
    monkeypatch.setattr(gate, "get_media_storage", lambda: storage)
    output = tmp_path / "media.json"
    assert await gate.main(4, 0, None, 4, output) == 1
    report = json.loads(output.read_text())
    assert report["scanned"] == report["planned"] == 3
    assert not report["complete"] and report["error"] == {"error_type": "RuntimeError"}
    assert report["issues"] == [] and storage.closed
    assert "private provider response" not in output.read_text()


@pytest.mark.asyncio
@pytest.mark.parametrize("concurrency", [0, 9])
async def test_concurrency_bounds_rejected(concurrency):
    with pytest.raises(ValueError, match="Concurrency"):
        await gate.main(100, 0, None, concurrency)
