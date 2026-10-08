"""Synthetic documents and process doubles exercise parser abuse boundaries."""
import asyncio
from io import BytesIO
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
import zipfile

from fastapi import HTTPException
import pytest

from catalog_pipeline import image_extractor, isolated_parser, resource_limits as limits


def workbook(sheet: str, extra=None) -> bytes:
    output = BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr("xl/workbook.xml", "<workbook/>")
        archive.writestr("xl/worksheets/sheet1.xml", sheet)
        for name, content in (extra or {}).items():
            archive.writestr(name, content)
    return output.getvalue()


def test_normal_supplier_workbook_passes_resource_preflight():
    limits.validate_source(workbook('<worksheet><dimension ref="A1:F200"/><sheetData><row r="200"><c r="F200"><v>1</v></c></row></sheetData></worksheet>'), "supplier.xlsx")


@pytest.mark.parametrize("reference", ["XFD1048576", "Z100000", "A1048576"])
def test_sparse_coordinate_rectangle_rejected_before_adapter(reference):
    with pytest.raises(limits.ImportResourceLimitError):
        limits.validate_xlsx(workbook(f'<worksheet><sheetData><row><c r="{reference}"><v>1</v></c></row></sheetData></worksheet>'))


def test_expanded_zip_member_limit_is_independent_of_small_upload(monkeypatch):
    data = workbook("<worksheet/>", {"xl/media/image.bin": b"a" * 20_000})
    assert len(data) < 2_000
    monkeypatch.setattr(limits, "MAX_MEMBER_BYTES", 10_000)
    with pytest.raises(limits.ImportResourceLimitError, match="expanded"):
        limits.validate_xlsx(data)


@pytest.mark.parametrize("encoding", ["utf-8", "utf-16"])
def test_xml_entities_rejected_even_when_encoded(encoding):
    xml = '<!DOCTYPE worksheet [<!ENTITY payload "payload">]><worksheet>&payload;</worksheet>'.encode(encoding)
    with pytest.raises(limits.ImportResourceLimitError, match="entities"):
        limits.validate_xlsx(workbook(xml))


def test_aggregate_sparse_rectangle_budget(monkeypatch):
    monkeypatch.setattr(limits, "MAX_WORKBOOK_CELLS", 150)
    sheet = '<worksheet><dimension ref="A1:J10"/></worksheet>'
    with pytest.raises(limits.ImportResourceLimitError, match="cell"):
        limits.validate_xlsx(workbook(sheet, {"xl/worksheets/sheet2.xml": sheet}))


def test_all_adapter_entry_points_receive_source_preflight(monkeypatch):
    from catalog_pipeline import adapters, parse_worker
    from catalog_pipeline.base import ExtractionReport, ProductRow
    rows = [ProductRow(brand="Vitra", name="Basin", sku="SKU", category="Basins", mrp=100, image_quality="good")]
    extract = SimpleNamespace(extract=lambda data, filename: (rows, ExtractionReport("Vitra", filename, "excel")))
    monkeypatch.setattr(adapters, "get_adapter", lambda brand: extract)
    result = parse_worker.extract_document("Vitra", "supplier.xlsx", workbook("<worksheet/>"))
    assert result["rows"][0]["sku"] == "SKU" and result["extraction"]["brand"] == "Vitra"
    bad = workbook('<worksheet><dimension ref="A1:XFD1048576"/></worksheet>')
    with pytest.raises(limits.ImportResourceLimitError):
        parse_worker.extract_document("Vitra", "supplier.xlsx", bad)


@pytest.mark.parametrize("converter", ["_convert_emf_to_png", "_convert_wmf_to_png"])
@pytest.mark.parametrize("failure", [False, True])
def test_vector_converter_cleans_inputs_and_outputs(monkeypatch, converter, failure):
    observed = []
    def convert(args, **kwargs):
        source = args[args.index("-i") + 1] if "-i" in args else args[-2].removeprefix("wmf:")
        observed.append(Path(source).parent)
        if failure:
            raise FileNotFoundError("fake converter unavailable")
        target = args[args.index("-o") + 1] if "-o" in args else args[-1]
        Path(target).write_bytes(b"converted")
        return SimpleNamespace(returncode=0)
    monkeypatch.setattr(image_extractor.subprocess, "run", convert)
    result = getattr(image_extractor, converter)(b"vector")
    assert result == (None if failure else b"converted")
    assert observed and all(not directory.exists() for directory in observed)


@pytest.mark.asyncio
async def test_parser_process_has_separate_session_and_cleans_source(monkeypatch):
    monkeypatch.setattr(isolated_parser, "_parse_slots", asyncio.Semaphore(1))
    monkeypatch.setenv("JWT_SECRET", "must-not-reach-parser")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "must-not-reach-parser")
    captured = {}
    async def spawn(*args, **kwargs):
        captured.update(source=Path(args[3]), options=kwargs)
        Path(args[4]).write_text(json.dumps({"rows": [], "extraction": {}, "certification": {}}))
        return SimpleNamespace(returncode=0, wait=AsyncMock(return_value=0))
    monkeypatch.setattr(isolated_parser.asyncio, "create_subprocess_exec", spawn)
    assert (await isolated_parser.extract_isolated("Vitra", "supplier.xlsx", b"file"))["rows"] == []
    assert not captured["source"].parent.exists()
    assert captured["options"]["start_new_session"] == (isolated_parser.os.name == "posix")
    assert "JWT_SECRET" not in captured["options"]["env"]
    assert "SUPABASE_SERVICE_ROLE_KEY" not in captured["options"]["env"]


@pytest.mark.asyncio
async def test_parser_timeout_stops_process_before_cleaning_directory(monkeypatch):
    slots = asyncio.Semaphore(1)
    monkeypatch.setattr(isolated_parser, "_parse_slots", slots)
    monkeypatch.setattr(isolated_parser, "PARSE_DEADLINE_SECONDS", 0.01)
    captured = {}
    async def slow_wait():
        await asyncio.sleep(10)
    process = SimpleNamespace(returncode=None, wait=slow_wait)
    async def spawn(*args, **kwargs):
        captured["source"] = Path(args[3])
        return process
    async def stop(actual):
        assert actual is process and captured["source"].exists()
        actual.returncode = -9
        captured["stopped"] = True
    monkeypatch.setattr(isolated_parser.asyncio, "create_subprocess_exec", spawn)
    monkeypatch.setattr(isolated_parser, "_stop_parser", stop)
    with pytest.raises(HTTPException) as rejected:
        await isolated_parser.extract_isolated("Vitra", "supplier.xlsx", b"file")
    assert rejected.value.status_code == 422 and captured["stopped"]
    assert not captured["source"].parent.exists() and slots._value == 1


@pytest.mark.asyncio
async def test_parser_admission_rejects_extra_upload_without_spawning(monkeypatch):
    monkeypatch.setattr(isolated_parser, "_parse_slots", asyncio.Semaphore(0))
    spawn = AsyncMock()
    monkeypatch.setattr(isolated_parser.asyncio, "create_subprocess_exec", spawn)
    with pytest.raises(HTTPException) as rejected:
        await isolated_parser.extract_isolated("Vitra", "supplier.xlsx", b"file")
    assert rejected.value.status_code == 429
    spawn.assert_not_awaited()
