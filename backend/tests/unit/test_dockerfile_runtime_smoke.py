from pathlib import Path
import ast
import shlex


def test_runtime_image_includes_local_imports_of_all_copied_python_modules():
    """A checkout import can pass while Docker's COPY omits a dependency."""
    backend = Path(__file__).resolve().parents[2]
    copied = set()
    for line in (backend / "Dockerfile").read_text().splitlines():
        if not line.startswith("COPY "):
            continue
        for source in shlex.split(line)[1:-1]:
            path = backend / source
            if path.is_file() and path.suffix == ".py":
                copied.add(path)
            elif path.is_dir():
                copied.update(path.rglob("*.py"))
    local_modules = {path.stem: path for path in backend.glob("*.py")}
    local_packages = {path.name: path for path in backend.iterdir() if path.is_dir() and (path / "__init__.py").is_file()}
    missing = set()
    for source in copied:
        tree = ast.parse(source.read_text(), filename=str(source))
        for node in ast.walk(tree):
            names = [name.name.split(".")[0] for name in node.names] if isinstance(node, ast.Import) else [node.module.split(".")[0]] if isinstance(node, ast.ImportFrom) and node.module and not node.level else []
            for name in names:
                if name in local_modules and local_modules[name] not in copied:
                    missing.add((str(source.relative_to(backend)), local_modules[name].name))
                if name in local_packages and not any(local_packages[name] in path.parents for path in copied):
                    missing.add((str(source.relative_to(backend)), name))
    assert not missing, f"Runtime image omits local imports: {sorted(missing)}"


def test_runtime_image_copies_catalog_pipeline_and_imports_server():
    dockerfile = (Path(__file__).resolve().parents[2] / "Dockerfile").read_text()

    assert "COPY catalog_pipeline ./catalog_pipeline" in dockerfile
    assert "COPY buildcon_logo.png buildcon_cover_logo.png ./" in dockerfile
    assert "import server; from services.quotation_ppt import ASSET_DIR, PARTNER_LOGOS; assert server.app" in dockerfile
    assert '(ASSET_DIR / "buildcon_cover_logo.png").is_file()' in dockerfile
    assert "ENVIRONMENT='development'" in dockerfile
