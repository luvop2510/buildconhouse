"""Security and capacity regressions for remote PDF product images."""
from __future__ import annotations

from io import BytesIO
import socket
import threading
import time

from PIL import Image

from services import pdf_image_loader as loader


def _resolver(addresses: list[str]):
    def resolve(_host, _port, *, type):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 443)) for address in addresses]
    return resolve


def _image_bytes(fmt: str = "PNG", size: tuple[int, int] = (20, 20)) -> bytes:
    output = BytesIO()
    Image.new("RGB", size, "blue").save(output, format=fmt)
    return output.getvalue()


def test_image_url_requires_allowlisted_https_host_and_public_dns():
    allowed = {"cdn.example.test"}
    assert loader.validate_image_url("https://cdn.example.test/a.png", allowed_hosts=allowed, resolver=_resolver(["8.8.8.8"]))
    assert not loader.validate_image_url("http://cdn.example.test/a.png", allowed_hosts=allowed, resolver=_resolver(["8.8.8.8"]))
    assert not loader.validate_image_url("https://other.example.test/a.png", allowed_hosts=allowed, resolver=_resolver(["8.8.8.8"]))
    assert not loader.validate_image_url("https://cdn.example.test/a.png", allowed_hosts=allowed, resolver=_resolver(["127.0.0.1"]))
    assert not loader.validate_image_url("https://cdn.example.test/a.png", allowed_hosts=allowed, resolver=_resolver(["8.8.8.8", "10.0.0.1"]))


def test_image_validation_rejects_animated_gif_unsupported_mime_and_bombs():
    assert not loader._valid_image(_image_bytes("GIF"), "image/gif")
    assert not loader._valid_image(_image_bytes(), "text/html")
    assert not loader._valid_image(_image_bytes(size=(loader.MAX_IMAGE_DIMENSION + 1, 1)), "image/png")


def test_prefetch_uses_global_workers_with_a_per_request_budget():
    active = peak = 0
    lock = threading.Lock()

    def fetch(_url):
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(peak, active)
        time.sleep(0.02)
        with lock:
            active -= 1
        return None

    loader.prefetch_urls([f"https://example.test/{index}.png" for index in range(8)], fetch, workers=3, timeout=2)
    assert peak == 3


def test_cold_direct_image_loads_also_share_the_global_fetch_budget(monkeypatch):
    active = peak = 0
    lock = threading.Lock()
    monkeypatch.setattr(loader, "_fetch_slots", threading.BoundedSemaphore(2))
    monkeypatch.setattr(loader, "_allowed_hosts", lambda: {"cdn.example.test"})
    monkeypatch.setattr(loader, "_host_circuits", {})
    loader._cache.clear()
    loader._cache_bytes = 0

    def fetch(_url):
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(peak, active)
        time.sleep(0.02)
        with lock:
            active -= 1
        return None

    monkeypatch.setattr(loader, "_fetch_uncached", fetch)
    threads = [threading.Thread(target=loader.remote_image_bytes, args=(f"https://cdn.example.test/{index}.png",)) for index in range(6)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert peak == 2


def test_cache_is_ttl_and_byte_bounded(monkeypatch):
    monkeypatch.setattr(loader, "MAX_CACHE_BYTES", 5)
    loader._cache.clear()
    loader._cache_bytes = 0
    loader._cache_put("one", b"1234")
    loader._cache_put("two", b"5678")
    assert loader._cache_get("one") is None
    assert loader._cache_get("two") == b"5678"


class _Response:
    def __init__(self, status_code: int, headers: dict[str, str], chunks=()):
        self.status_code = status_code
        self.headers = headers
        self._chunks = chunks

    @property
    def is_redirect(self):
        return 300 <= self.status_code < 400

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def iter_bytes(self):
        return iter(self._chunks)


class _Client:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def stream(self, _method, url, **_kwargs):
        self.calls.append(url)
        return self.response


def test_redirect_is_revalidated_before_any_followup_request(monkeypatch):
    client = _Client(_Response(302, {"location": "https://private.example.test/image.png"}))
    monkeypatch.setattr(loader, "_client", client)
    checked = []

    def validate(url):
        checked.append(url)
        return "private" not in url

    monkeypatch.setattr(loader, "validate_image_url", validate)
    assert loader._fetch_uncached("https://cdn.example.test/image.png") is None
    assert client.calls == ["https://cdn.example.test/image.png"]
    assert checked == ["https://cdn.example.test/image.png", "https://private.example.test/image.png"]


def test_declared_or_streamed_oversize_image_is_not_cached_or_decoded(monkeypatch):
    client = _Client(_Response(200, {"content-length": str(loader.MAX_IMAGE_BYTES + 1), "content-type": "image/png"}))
    monkeypatch.setattr(loader, "_client", client)
    monkeypatch.setattr(loader, "validate_image_url", lambda _url: True)
    assert loader._fetch_uncached("https://cdn.example.test/image.png") is None
