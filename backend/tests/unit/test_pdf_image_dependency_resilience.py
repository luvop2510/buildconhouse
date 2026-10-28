"""Degraded optional image storage must not monopolize PDF network workers."""
import threading

import httpx
import pytest

from services import pdf_image_loader as loader


@pytest.fixture
def isolated(monkeypatch):
    clock = [100.0]
    monkeypatch.setattr(loader, "monotonic", lambda: clock[0])
    monkeypatch.setattr(loader, "_allowed_hosts", lambda: {"slow.example.test", "healthy.example.test"})
    monkeypatch.setattr(loader, "_host_circuits", {})
    monkeypatch.setattr(loader, "_fetch_slots", threading.BoundedSemaphore(6))
    monkeypatch.setattr(loader, "_cache", loader.OrderedDict())
    monkeypatch.setattr(loader, "_cache_bytes", 0)
    return clock


def test_failure_opens_only_affected_host_and_recovers_after_probe(monkeypatch, isolated):
    calls = []
    failing = [True]
    def fetch(url):
        calls.append(url)
        if "slow." in url and failing[0]:
            raise loader.ImageDependencyUnavailable()
        return b"valid image"
    monkeypatch.setattr(loader, "_fetch_uncached", fetch)
    for index in range(3):
        assert loader.remote_image_bytes(f"https://slow.example.test/{index}") is None
    assert loader.remote_image_bytes("https://slow.example.test/skipped") is None
    assert len(calls) == 3
    assert loader.remote_image_bytes("https://healthy.example.test/photo") == b"valid image"
    isolated[0] += loader.CIRCUIT_RECOVERY_SECONDS + 1
    failing[0] = False
    assert loader.remote_image_bytes("https://slow.example.test/recovered") == b"valid image"
    assert loader.remote_image_bytes("https://slow.example.test/next") == b"valid image"


def test_missing_images_do_not_trip_host_but_slow_responses_do(monkeypatch, isolated):
    calls = []
    def missing(url):
        calls.append(url)
        return None
    monkeypatch.setattr(loader, "_fetch_uncached", missing)
    for index in range(10):
        loader.remote_image_bytes(f"https://slow.example.test/{index}")
    assert len(calls) == 10
    def slow(url):
        calls.append(url)
        isolated[0] += loader.SLOW_FETCH_SECONDS + 1
        return b"valid image"
    monkeypatch.setattr(loader, "_fetch_uncached", slow)
    for index in range(3):
        assert loader.remote_image_bytes(f"https://slow.example.test/slow-{index}") == b"valid image"
    assert loader.remote_image_bytes("https://slow.example.test/next") is None
    # Previously fetched images remain usable while the host is open.
    assert loader.remote_image_bytes("https://slow.example.test/slow-0") == b"valid image"
    assert len(calls) == 13


def test_saturated_host_fast_fails_while_other_host_has_capacity(monkeypatch, isolated):
    def fail(_url):
        raise loader.ImageDependencyUnavailable()
    monkeypatch.setattr(loader, "_fetch_uncached", fail)
    loader.remote_image_bytes("https://slow.example.test/first-failure")
    entered = threading.Barrier(loader.MAX_CONCURRENT_HOST_FETCHES + 1)
    release = threading.Event()
    def fetch(url):
        if "slow." in url:
            entered.wait(timeout=2)
            assert release.wait(2)
        return b"valid image"
    monkeypatch.setattr(loader, "_fetch_uncached", fetch)
    threads = [threading.Thread(target=loader.remote_image_bytes, args=(f"https://slow.example.test/{index}",))
               for index in range(loader.MAX_CONCURRENT_HOST_FETCHES)]
    for thread in threads:
        thread.start()
    try:
        entered.wait(timeout=2)
        assert loader.remote_image_bytes("https://slow.example.test/excess") is None
        assert loader.remote_image_bytes("https://healthy.example.test/photo") == b"valid image"
    finally:
        release.set()
        for thread in threads:
            thread.join(timeout=2)
            assert not thread.is_alive()


def test_half_open_allows_only_one_recovery_probe(monkeypatch, isolated):
    def fail(_url):
        raise loader.ImageDependencyUnavailable()
    monkeypatch.setattr(loader, "_fetch_uncached", fail)
    for index in range(3):
        loader.remote_image_bytes(f"https://slow.example.test/{index}")
    isolated[0] += loader.CIRCUIT_RECOVERY_SECONDS + 1
    entered, release = threading.Event(), threading.Event()
    def recover(_url):
        entered.set()
        assert release.wait(2)
        return b"valid image"
    monkeypatch.setattr(loader, "_fetch_uncached", recover)
    thread = threading.Thread(target=loader.remote_image_bytes, args=("https://slow.example.test/probe",))
    thread.start()
    try:
        assert entered.wait(2)
        assert loader.remote_image_bytes("https://slow.example.test/competing-probe") is None
    finally:
        release.set()
        thread.join(timeout=2)
    assert loader.remote_image_bytes("https://slow.example.test/after-probe") == b"valid image"


def test_untrusted_hosts_do_not_allocate_circuit_state(monkeypatch, isolated):
    monkeypatch.setattr(loader, "_fetch_uncached", lambda _url: pytest.fail("untrusted host reached network"))
    assert loader.remote_image_bytes("https://untrusted.example.test/photo") is None
    assert not loader._host_circuits


def test_healthy_host_retains_existing_prefetch_concurrency(monkeypatch, isolated):
    entered = threading.Barrier(loader.MAX_CONCURRENT_FETCHES)
    def fetch(_url):
        entered.wait(timeout=2)
        return b"valid image"
    monkeypatch.setattr(loader, "_fetch_uncached", fetch)
    urls = [f"https://healthy.example.test/{index}" for index in range(loader.MAX_CONCURRENT_FETCHES)]
    loader.prefetch_urls(urls, loader.remote_image_bytes, timeout=2)
    assert all(loader._cache_get(url) == b"valid image" for url in urls)


@pytest.mark.parametrize("status,network_calls", [(404, 5), (429, 3), (503, 3)])
def test_only_availability_statuses_trip_circuit(monkeypatch, isolated, status, network_calls):
    calls = []
    def handle(request):
        calls.append(request)
        return httpx.Response(status)
    monkeypatch.setattr(loader, "validate_image_url", lambda _url: True)
    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        monkeypatch.setattr(loader, "_client", client)
        for index in range(5):
            assert loader.remote_image_bytes(f"https://slow.example.test/{index}") is None
    assert len(calls) == network_calls


def test_read_timeouts_trip_circuit_without_retries(monkeypatch, isolated):
    calls = []
    def handle(request):
        calls.append(request)
        raise httpx.ReadTimeout("timeout", request=request)
    monkeypatch.setattr(loader, "validate_image_url", lambda _url: True)
    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        monkeypatch.setattr(loader, "_client", client)
        for index in range(5):
            assert loader.remote_image_bytes(f"https://slow.example.test/{index}") is None
    assert len(calls) == 3


def test_late_healthy_response_cannot_close_newer_open_circuit(monkeypatch, isolated):
    entered, release = threading.Event(), threading.Event()
    def fetch(url):
        if url.endswith("old"):
            entered.set()
            assert release.wait(2)
            return b"valid image"
        raise loader.ImageDependencyUnavailable()
    monkeypatch.setattr(loader, "_fetch_uncached", fetch)
    thread = threading.Thread(target=loader.remote_image_bytes, args=("https://slow.example.test/old",))
    thread.start()
    try:
        assert entered.wait(2)
        for index in range(3):
            loader.remote_image_bytes(f"https://slow.example.test/{index}")
    finally:
        release.set()
        thread.join(timeout=2)
    monkeypatch.setattr(loader, "_fetch_uncached", lambda _url: pytest.fail("late result closed the circuit"))
    assert loader.remote_image_bytes("https://slow.example.test/not-yet") is None


def test_drip_feed_cannot_keep_worker_past_stream_budget(monkeypatch, isolated):
    class Stream(httpx.SyncByteStream):
        def __iter__(self):
            for _ in range(10):
                isolated[0] += 2
                yield b"bytes"
    monkeypatch.setattr(loader, "validate_image_url", lambda _url: True)
    def handle(_request):
        return httpx.Response(200, headers={"content-type": "image/png"}, stream=Stream())
    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        monkeypatch.setattr(loader, "_client", client)
        assert loader.remote_image_bytes("https://slow.example.test/drip") is None
    assert isolated[0] == 100 + loader.FETCH_STREAM_BUDGET_SECONDS
