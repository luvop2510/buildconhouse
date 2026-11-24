from base64 import b64decode
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import subprocess
import sys
from threading import Thread
from urllib.parse import parse_qs, urlsplit

import pytest


SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "buildcon_catalogue.py"
TOKEN = "synthetic-http-fixture-token"


@pytest.fixture
def api_server(monkeypatch):
    calls = []
    jobs = {}
    parts = {}
    brands = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def reply(self, data, status=200):
            raw = data if isinstance(data, bytes) else json.dumps(data).encode()
            self.send_response(status)
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def handle_catalogue(self):
            url = urlsplit(self.path)
            path = url.path.removeprefix("/api/catalog/management")
            raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            body = json.loads(raw) if raw else {}
            if (self.headers.get("Authorization") != f"Bearer {TOKEN}"
                    or self.headers.get("X-Floor-Id") != "first-floor"
                    or parse_qs(url.query) != {"floor_id": ["first-floor"]}):
                return self.reply({"detail": "Incorrect scoped authorization"}, 401)
            calls.append((self.command, path, body))
            if path == "/options":
                return self.reply({"brands": brands, "max_bytes": 4096, "part_bytes": 10})
            if path == "/categories":
                return self.reply({"id": "category", **body, "floor_id": "first-floor"})
            if path == "/jobs":
                key = body["key"]
                if key not in jobs:
                    jobs[key] = {"id": key, "status": "upload"}
                return self.reply(jobs[key])
            _, _, job_id, *action = path.split("/")
            if job_id not in jobs:
                return self.reply({"detail": f"Reflect {TOKEN} in upstream error"}, 403)
            job = jobs[job_id]
            if action and action[0] == "parts":
                parts[int(action[1])] = b64decode(body["data_base64"])
                return self.reply({"ok": True})
            if action == ["preview"]:
                job.update(status="preview", summary={"add": 1}, rows=[{"sku": "012-private-row"}])
            if action == ["apply"]:
                job.update(status="complete", result={"applied": 1})
                if not brands:
                    brands.append({"id": "new-brand", "name": "BIANA"})
            if action == ["errors.xlsx"]:
                return self.reply(b"PK\x03\x04fixture")
            return self.reply(job)

        do_GET = do_POST = do_PUT = handle_catalogue

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv("BUILDCON_API_TOKEN", TOKEN)
    try:
        yield f"http://127.0.0.1:{server.server_port}", calls, parts
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def run_cli(origin, *args):
    return subprocess.run([sys.executable, str(SCRIPT), "--url", origin, *args], capture_output=True, text=True, timeout=15)


def test_cli_uses_one_job_for_preview_apply_and_retry(tmp_path, api_server):
    origin, calls, uploaded = api_server
    source = tmp_path / "source.csv"
    source.write_text("Article No.,Product Name,Category,MRP\n001A,Fixture,Faucet,450\n", encoding="utf-8")
    command = ("import", "--floor", "sanitary", "--brand", "BIANA", "--operation", "add",
               "--create-brand", "--create-categories", str(source))
    preview = run_cli(origin, *command)
    assert preview.returncode == 0, preview.stderr
    status = json.loads(preview.stdout)
    assert status["status"] == "preview"
    assert "012-private-row" not in preview.stdout
    assert source.read_bytes() == b"".join(uploaded[index] for index in sorted(uploaded))
    assert len(uploaded) > 1
    assert not any(path.endswith("/apply") for _, path, _ in calls)

    errors = tmp_path / "errors.xlsx"
    applied = run_cli(origin, *command, "--apply", "--errors", str(errors))
    assert applied.returncode == 0, applied.stderr
    assert json.loads(applied.stdout)["result"] == {"applied": 1}
    assert errors.read_bytes().startswith(b"PK")
    retried = run_cli(origin, *command, "--apply")
    assert retried.returncode == 0, retried.stderr
    assert json.loads(retried.stdout)["id"] == status["id"]
    assert sum(path.endswith("/apply") for _, path, _ in calls) == 1
    assert sum(path.endswith("/preview") for _, path, _ in calls) == 1

    category = run_cli(origin, "category", "--floor", "sanitary", "--brand", "BIANA", "--name", "Basin")
    assert category.returncode == 0, category.stderr
    assert json.loads(category.stdout)["brand_id"] == "new-brand"


def test_cli_never_prints_the_staff_token(api_server):
    origin, _, _ = api_server
    bad = run_cli(origin, "job", "--floor", "sanitary", "unavailable")
    assert bad.returncode == 1
    assert "[redacted]" in bad.stderr
    assert TOKEN not in bad.stdout + bad.stderr
