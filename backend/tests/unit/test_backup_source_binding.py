import json

import pytest

from scripts.verify_backup_source import run_cli, source_fingerprint, verify_source


@pytest.fixture
def source():
    return {"MONGO_URL": "mongodb+srv://user:secret@cluster.example.test/",
            "DB_NAME": "fixture_db", "SUPABASE_URL": "https://storage.example.test"}


@pytest.mark.parametrize("key,value", [
    ("DB_NAME", "other_db"),
    ("MONGO_URL", "mongodb+srv://user:secret@other.example.test/"),
    ("SUPABASE_URL", "https://other-storage.example.test"),
])
def test_rejects_export_to_a_different_source(source, key, value):
    expected = source_fingerprint(source)
    assert not verify_source({**source, key: value}, expected)


def test_password_rotation_does_not_change_target_identity(source):
    expected = source_fingerprint(source)
    assert verify_source({**source, "MONGO_URL": "mongodb+srv://new:new-secret@cluster.example.test/"}, expected)


@pytest.mark.parametrize("expected", ["", "not-a-hash", "a" * 63, "A" * 64])
def test_absent_or_malformed_expected_identity_fails_closed(source, expected):
    with pytest.raises(ValueError):
        verify_source(source, expected)


@pytest.mark.parametrize("key,value", [
    ("MONGO_URL", "https://cluster.example.test"), ("MONGO_URL", "mongodb://"),
    ("DB_NAME", ""), ("DB_NAME", "../other"),
    ("DB_NAME", "fixture_db\t"), ("DB_NAME", " fixture_db"),
    ("DB_NAME", "fixture_db\n"), ("DB_NAME", "fixture_db\x00"),
    ("DB_NAME", "fixture_db\x7f"),
    ("MONGO_URL", " mongodb+srv://user:secret@cluster.example.test/"),
    ("MONGO_URL", "mongodb+srv://user:secret@cluster.\texample.test/"),
    ("SUPABASE_URL", "https://storage.example.test\n"),
    ("SUPABASE_URL", "http://storage.example.test"),
    ("SUPABASE_URL", "https://secret@storage.example.test"),
    ("SUPABASE_URL", "https://storage.example.test/other?secret=fixture"),
    ("SUPABASE_URL", "https://storage.example.test:invalid"),
])
def test_invalid_source_identity_fails_closed(source, key, value):
    with pytest.raises(ValueError):
        source_fingerprint({**source, key: value})


def test_cli_failure_never_echoes_secret_source(monkeypatch, capsys, source):
    for key, value in source.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setenv("SUPABASE_URL", "https://private-sentinel@storage.example.test")
    monkeypatch.setenv("EXPECTED_SOURCE_FINGERPRINT", "a" * 64)
    assert run_cli([]) == 1
    output = capsys.readouterr().out
    assert "private-sentinel" not in output and "storage.example.test" not in output
    assert json.loads(output) == {"source_binding_verified": False, "exception_type": "ValueError"}
