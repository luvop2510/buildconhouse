from services.runtime_identity import source_revision


def test_render_deploy_identity_is_normalized(monkeypatch):
    monkeypatch.setenv("RENDER_GIT_COMMIT", "ABCDEF0123456789ABCDEF0123456789ABCDEF01")
    assert source_revision() == "abcdef0123456789abcdef0123456789abcdef01"


def test_invalid_environment_values_never_escape(monkeypatch):
    for value in ("", "unset", "https://secret.example/key", "a" * 39, "a" * 41, "a" * 40 + "\n"):
        monkeypatch.setenv("RENDER_GIT_COMMIT", value)
        assert source_revision() is None
    monkeypatch.delenv("RENDER_GIT_COMMIT")
    assert source_revision() is None
