"""Kitchen foundation invariants using a hermetic persistence double.

Independent Mongo tests prove the real query/constraint/HTTP boundaries.
"""
import copy

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from pymongo.errors import DuplicateKeyError

from models import UserPublic
from models_kitchen import CreateProject, LeadFields, MetadataPayload, ProjectCommand
from services import kitchen_projects
from services.kitchen_projects import KitchenProjectService


def create_request(**data):
    data["lead"] = {"site_location": "Synthetic site", **data.get("lead", {})}
    return CreateProject(**data)


def matches(doc, query):
    def field(path):
        value = doc
        for key in path.split("."):
            value = value.get(key) if isinstance(value, dict) else None
        return value
    for key, expected in query.items():
        if key == "$and":
            if not all(matches(doc, part) for part in expected):
                return False
        elif key == "$or":
            if not any(matches(doc, part) for part in expected):
                return False
        elif isinstance(expected, dict):
            if "$exists" in expected and (field(key) is not None) != expected["$exists"]:
                return False
            if "$ne" in expected and field(key) == expected["$ne"]:
                return False
            if "$lt" in expected and (field(key) is None or field(key) >= expected["$lt"]):
                return False
        elif field(key) != expected:
            return False
    return True


class Cursor:
    def __init__(self, rows):
        self.rows = copy.deepcopy(rows)
    def sort(self, *args):
        return self
    def limit(self, limit):
        self.rows = self.rows[:limit]
        return self
    def skip(self, count):
        self.rows = self.rows[count:]
        return self
    async def to_list(self, length):
        return self.rows[:length]


class Collection:
    def __init__(self):
        self.rows = []
    async def find_one(self, query, projection=None):
        return next((copy.deepcopy(row) for row in self.rows if matches(row, query)), None)
    def find(self, query, projection=None):
        return Cursor([row for row in self.rows if matches(row, query)])
    async def insert_one(self, doc):
        if any(row.get("_id") == doc.get("_id") for row in self.rows):
            raise DuplicateKeyError("Duplicate _id")
        self.rows.append(copy.deepcopy(doc))
    async def replace_one(self, query, replacement):
        from types import SimpleNamespace
        for i, row in enumerate(self.rows):
            if matches(row, query):
                self.rows[i] = copy.deepcopy(replacement)
                return SimpleNamespace(matched_count=1)
        return SimpleNamespace(matched_count=0)
    async def count_documents(self, query):
        return len([row for row in self.rows if matches(row, query)])
    async def update_one(self, query, update):
        from types import SimpleNamespace
        for row in self.rows:
            if matches(row, query):
                for operation, fields in update.items():
                    for path, value in fields.items():
                        target = row
                        segments = path.split(".")
                        for segment in segments[:-1]:
                            target = target.setdefault(segment, {})
                        key = segments[-1]
                        if operation == "$set":
                            target[key] = value
                        elif operation == "$inc":
                            target[key] = target.get(key, 0) + value
                        elif operation == "$unset":
                            target.pop(key, None)
                return SimpleNamespace(matched_count=1)
        return SimpleNamespace(matched_count=0)


class Database:
    def __init__(self):
        self.kitchen_projects = Collection()
        self.kitchen_configuration = Collection()
        self.customers = Collection()
        self.users = Collection()
        self.access_grants = Collection()


@pytest.fixture
def setup():
    database = Database()
    database.customers.rows = [{"id": "customer-a", "name": "Customer A", "phone": "+91 90000 00000", "address": "Site A", "floor_id": "second-floor"}]
    database.users.rows = [{"id": "staff-a", "full_name": "Staff A", "role": "sales", "active": True, "floor_ids": ["second-floor"]}]
    owner = UserPublic(id="owner", full_name="Owner", role="owner", active_floor_id="second-floor")
    return database, KitchenProjectService(database), owner


def cmd(version, command, payload=None, key=None):
    return ProjectCommand(expected_version=version, idempotency_key=key or f"command:{version}:{command}", command=command, payload=payload or {})


@pytest.mark.asyncio
async def test_create_replay_preserves_customer_and_allows_second_project(setup):
    database, service, owner = setup
    body = create_request(customer_id="customer-a", idempotency_key="creation-a", lead={"budget": "125.10"})
    first = await service.create(owner, body)
    replay = await service.create(owner, body)
    second = await service.create(owner, create_request(customer_id="customer-a", idempotency_key="creation-b"))
    assert first["id"] == replay["id"] != second["id"]
    assert replay["replayed"] is True
    assert first["customer_id"] == second["customer_id"] == "customer-a"
    assert len(database.customers.rows) == 1
    assert len(database.kitchen_projects.rows) == 2
    assert first["lead"]["budget"] == "125.10"
    assert first["project_reference"] == first["reference"] and first["project_reference"]
    assert second["duplicate_review"]["status"] == "pending"
    assert "command_receipts" not in first and "creation_fingerprint" not in first
    with pytest.raises(HTTPException) as different:
        await service.create(owner, create_request(customer_id="customer-a", idempotency_key="creation-a", lead={"budget": "125.11"}))
    assert different.value.status_code == 409


@pytest.mark.asyncio
async def test_visited_gate_retries_stale_versions_and_atomic_history(setup):
    database, service, owner = setup
    first = await service.create(owner, create_request(customer_id="customer-a", idempotency_key="creation-a"))
    converted = await service.command(owner, first["id"], cmd(1, "convert"))
    assert converted["stage"] == "visit" and converted["customer_id"] == first["customer_id"]
    with pytest.raises(HTTPException) as missing:
        await service.command(owner, first["id"], cmd(2, "advance_stage", {"target_stage": "cad"}))
    assert missing.value.status_code == 422
    assert database.kitchen_projects.rows[0]["version"] == 2
    visit = cmd(2, "save_visit", {"status": "Visited", "requirements": "New kitchen", "visit_date": "2026-10-19", "interested": True})
    saved = await service.command(owner, first["id"], visit)
    replay = await service.command(owner, first["id"], visit)
    assert replay["version"] == saved["version"] == 3 and replay["replayed"]
    with pytest.raises(HTTPException) as stale:
        await service.command(owner, first["id"], cmd(2, "metadata", {"next_action": "Stale"}))
    assert stale.value.status_code == 409
    advanced = await service.command(owner, first["id"], cmd(3, "advance_stage", {"target_stage": "cad"}))
    assert advanced["site_visit_count"] == advanced["design_revision_count"] == 0
    assert advanced["stage"] == "cad" and advanced["version"] == 4
    assert len(database.kitchen_projects.rows[0]["command_receipts"]) == len(advanced["activity"]) == 4
    assert advanced["activity"][2]["payload"]["changes"]["visit"]["before"]["status"] == "Scheduled"
    with pytest.raises(HTTPException) as unknown:
        await service.command(owner, first["id"], cmd(4, "advance_stage", {"target_stage": "design"}))
    assert unknown.value.status_code == 422 and "CAD" in unknown.value.detail


@pytest.mark.asyncio
async def test_permission_scope_customer_floor_and_assignment(setup):
    database, service, owner = setup
    first = await service.create(owner, create_request(customer_id="customer-a", idempotency_key="creation-a"))
    staff = UserPublic(id="staff-a", full_name="Staff A", role="sales", floor_ids=["second-floor"], active_floor_id="second-floor")
    with pytest.raises(HTTPException) as inaccessible:
        await service.get(staff, first["id"])
    assert inaccessible.value.status_code == 404
    assigned = await service.command(owner, first["id"], cmd(1, "assign", {"stage": "lead", "user_id": "staff-a"}))
    assert assigned["assigned_to"] == "staff-a"
    assert (await service.get(staff, first["id"]))["id"] == first["id"]
    with pytest.raises(HTTPException) as forbidden:
        await service.command(staff, first["id"], cmd(2, "assign", {"stage": "visit", "user_id": "staff-a"}))
    assert forbidden.value.status_code == 403
    database.customers.rows[0]["floor_id"] = "first-floor"
    with pytest.raises(HTTPException) as other_floor:
        await service.create(owner, create_request(customer_id="customer-a", idempotency_key="creation-b"))
    assert other_floor.value.status_code == 404


@pytest.mark.asyncio
async def test_unconfigured_policy_and_aggregate_bound_fail_without_writes(setup, monkeypatch):
    database, service, owner = setup
    policy = await service.public_policy(owner)
    assert policy["production"]["require_manager_approval"] and policy["production"]["require_advance"]
    assert policy["closure"]["require_manager_approval"] and not policy["department_manager_user_ids"]
    assert policy["identity_timing"] == "creation" and policy["files"]["max_bytes"] == 25_000_000
    assert database.kitchen_configuration.rows == []
    monkeypatch.setattr(kitchen_projects, "MAX_AGGREGATE_BYTES", 10)
    with pytest.raises(HTTPException) as too_large:
        await service.create(owner, create_request(customer_id="customer-a", idempotency_key="creation-a"))
    assert too_large.value.status_code == 413 and not database.kitchen_projects.rows


def test_strict_dates_money_and_command_fields():
    assert LeadFields(budget="1.2").budget == "1.20"
    for value in (1.2, "NaN", "-1", "1.001", "Infinity"):
        with pytest.raises(ValidationError):
            LeadFields(budget=value)
    for value in ("2026-02-30", "19/10/2026", "20261019"):
        with pytest.raises(ValidationError):
            LeadFields(lead_date=value)
    with pytest.raises(ValidationError):
        MetadataPayload(deadline="2026-10-19T09:30:00")
    with pytest.raises(ValidationError):
        create_request(customer_id="customer-a", idempotency_key="creation-a", site_visit_count=9)
    assert MetadataPayload(deadline="2026-10-19T09:30:00+05:30").deadline == "2026-10-19T04:00:00+00:00"


@pytest.mark.asyncio
async def test_customer_tombstone_excludes_creation_and_success_pins_identity(setup):
    database, service, owner = setup
    database.customers.rows[0]["kitchen_delete_token"] = "concurrent-delete"
    with pytest.raises(HTTPException) as blocked:
        await service.create(owner, create_request(customer_id="customer-a", idempotency_key="creation-a"))
    assert blocked.value.status_code == 409 and database.kitchen_projects.rows == []
    database.customers.rows[0].pop("kitchen_delete_token")
    await service.create(owner, create_request(customer_id="customer-a", idempotency_key="creation-a"))
    assert database.customers.rows[0]["kitchen_reference_reserved"] is True


@pytest.mark.asyncio
async def test_mandatory_lead_identity_fields_reject_before_customer_pin(setup):
    database, service, owner = setup
    with pytest.raises(HTTPException) as missing:
        await service.create(owner, CreateProject(customer_id="customer-a", idempotency_key="creation-a"))
    assert missing.value.status_code == 422 and not database.customers.rows[0].get("kitchen_reference_reserved")
    for key, value in (("name", "  "), ("phone", "--")):
        original = database.customers.rows[0][key]
        database.customers.rows[0][key] = value
        with pytest.raises(HTTPException) as invalid:
            await service.create(owner, create_request(customer_id="customer-a", idempotency_key=f"missing-{key}"))
        assert invalid.value.status_code == 422 and not database.kitchen_projects.rows
        database.customers.rows[0][key] = original
    created = await service.create(owner, create_request(customer_id="customer-a", idempotency_key="creation-a"))
    converted = await service.command(owner, created["id"], cmd(1, "convert"))
    saved = await service.command(owner, created["id"], cmd(2, "save_visit", {"status": "Visited", "interested": True, "requirements": "Layout", "next_action": "CAD next"}))
    assert converted["version"] == 2 and saved["next_action"] == "CAD next"
    advanced = await service.command(owner, created["id"], cmd(3, "advance_stage", {"target_stage": "cad"}))
    assert advanced["visit"]["visit_date"] is None  # optional/unknown date is not invented


def test_policy_files_and_required_fields_are_whitelisted():
    from models_kitchen import ConfigurePolicy
    for patch in ({"required_fields": {"lead": ["made_up"]}}, {"required_fields": {"made_up": []}},
                  {"files": {"allowed_types": ["text/html"], "max_bytes": 100}},
                  {"files": {"allowed_types": ["application/pdf"], "max_bytes": True}},
                  {"files": {"allowed_types": ["application/pdf"], "max_bytes": 25_000_001}}):
        with pytest.raises(ValidationError):
            ConfigurePolicy(expected_version=1, **patch)


@pytest.mark.asyncio
async def test_policy_admission_excludes_configuration_and_releases_on_error(setup):
    from models_kitchen import ConfigurePolicy
    database, service, owner = setup
    async with service.admission(owner, "update"):
        internal = database.kitchen_configuration.rows[0]
        assert internal["active_command_count"] == 1 and len(internal["command_admissions"]) == 1
        with pytest.raises(HTTPException) as occupied:
            await service.configure(owner, ConfigurePolicy(expected_version=1, decision_contract="2026-10-20", cad_require_received=True))
        assert occupied.value.status_code == 409
        public = await service.public_policy(owner)
        assert "active_command_count" not in public and "command_admissions" not in public
    assert database.kitchen_configuration.rows[0]["active_command_count"] == 0
    await service.configure(owner, ConfigurePolicy(expected_version=1, decision_contract="2026-10-20", cad_require_received=True))
    with pytest.raises(RuntimeError):
        async with service.admission(owner, "update"):
            raise RuntimeError("Synthetic failure before aggregate write")
    assert database.kitchen_configuration.rows[0]["active_command_count"] == 0
    assert database.kitchen_configuration.rows[0]["command_admissions"] == {}


@pytest.mark.asyncio
async def test_policy_admission_releases_exact_token_when_cancelled(setup):
    import asyncio
    database, service, owner = setup
    admitted = asyncio.Event()
    async def pending():
        async with service.admission(owner, "update"):
            admitted.set()
            await asyncio.Event().wait()
    task = asyncio.create_task(pending())
    await admitted.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert database.kitchen_configuration.rows[0]["active_command_count"] == 0
    assert database.kitchen_configuration.rows[0]["command_admissions"] == {}


@pytest.mark.parametrize("stage,command,payload", [
    ("order", "order_advance", {"received": True, "amount": "5.00", "date": "2026-10-18"}),
    ("production", "production_update", {"status": "In Production", "start_date": "2026-10-18"}),
    ("installation", "installation_update", {"status": "In Progress", "start_date": "2026-10-19"}),
    ("installation", "site_visit", {"actual": True, "date": "2026-10-20"}),
])
def test_actual_work_dates_follow_confirmed_stage_dates(setup, stage, command, payload):
    from services import kitchen_workflow
    _, _, owner = setup
    project = {"stage": stage, "orders": [{"id": "order", "status": "Confirmed", "order_date": "2026-10-19", "final_amount": "10.00"}],
               "production": {"status": "Completed", "completion_date": "2026-10-20"},
               "installation": {"status": "In Progress", "start_date": "2026-10-21"}}
    if stage == "production":
        project["production"] = {"status": "Not Started"}
    with pytest.raises(HTTPException) as invalid:
        kitchen_workflow.apply(project, command, payload, {}, owner, "now", kitchen_projects.validate)
    assert invalid.value.status_code == 422


def test_order_document_first_attachment_preserves_commercial_agreement(setup):
    from services import kitchen_workflow
    _, _, owner = setup
    project = {"stage": "order", "orders": [{"id": "order", "status": "Confirmed", "final_amount": "125.10"}],
               "attachments": [{"id": "confirmation"}]}
    kitchen_workflow.apply(project, "order_document", {"attachment_id": "confirmation"}, {}, owner, "now", kitchen_projects.validate)
    assert project["orders"][0]["confirmation_document_id"] == "confirmation"
    assert project["orders"][0]["final_amount"] == "125.10"
    with pytest.raises(HTTPException):
        kitchen_workflow.apply(project, "order_document", {"attachment_id": "confirmation"}, {}, owner, "now", kitchen_projects.validate)


def test_design_and_quotation_documents_require_a_project_file_or_https_reference():
    from models_kitchen import DesignPresentation, QuotationReceived
    from services.kitchen_workflow import document
    project = {"attachments": [{"id": "own-file"}]}
    for model, fields in ((DesignPresentation, {"presentation_date": "2026-10-21"}),
                          (QuotationReceived, {"design_version_id": "design", "received_date": "2026-10-21", "amount": "10.01"})):
        for payload in (fields, {**fields, "url": ""}, {**fields, "attachment_id": "foreign-file"}):
            with pytest.raises((HTTPException, ValidationError)):
                document(project, model(**payload))
        assert document(project, model(**fields, attachment_id="own-file"))["attachment_id"] == "own-file"
        assert document(project, model(**fields, url="https://example.test/reference.pdf"))["url"] == "https://example.test/reference.pdf"


def office_bytes(extension, additions=None, *, main=None):
    """Small synthetic OOXML packages, never client documents."""
    import io
    import zipfile
    part = "word/document.xml" if extension == ".docx" else "xl/workbook.xml"
    namespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main" if extension == ".docx" else "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    kind = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml" if extension == ".docx" else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
    root = "document" if extension == ".docx" else "workbook"
    values = {"[Content_Types].xml": f'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/{part}" ContentType="{kind}"/></Types>',
              "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
              part: main or f'<{root} xmlns="{namespace}"/>'}
    values.update(additions or {})
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as package:
        for name, value in values.items():
            package.writestr(name, value)
    return output.getvalue()


@pytest.mark.parametrize("extension,mime,data", [
    (".pdf", "application/pdf", b"%PDF-1.4\nSynthetic"),
    (".dwg", "application/acad", b"AC1032" + b"\0" * 26),
    (".dxf", "application/x-dxf", b"0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nEOF\n"),
    (".jpg", "image/jpeg", b"\xff\xd8\xff\xe0Synthetic"),
    (".png", "image/png", b"\x89PNG\r\n\x1a\nSynthetic"),
    (".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", None),
    (".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", None),
])
def test_resolved_d10_permitted_types_match_extension_mime_and_content(extension, mime, data):
    import hashlib
    from services.kitchen_attachments import validate_file
    policy = kitchen_projects.resolved_policy({})
    content = data if data is not None else office_bytes(extension)
    assert validate_file(content, mime, f"synthetic{extension}", policy) == hashlib.sha256(content).hexdigest()
    with pytest.raises(HTTPException) as mismatch:
        validate_file(content, mime, "synthetic.exe", policy)
    assert mismatch.value.status_code == 415


@pytest.mark.parametrize("filename,mime,data,code", [
    ("broken.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", b"PK\x03\x04broken", 415),
    ("fake.dwg", "image/vnd.dwg", b"MZ" + b"\0" * 100, 415),
    ("unknown.dwg", "image/vnd.dwg", b"AC9999" + b"\0" * 26, 415),
    ("short.dwg", "image/vnd.dwg", b"AC1032", 415),
    ("fake.dxf", "image/vnd.dxf", b"0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nNOT_EOF\n", 415),
    ("unicode.dxf", "image/vnd.dxf", b"0\nSECTION\n\xff", 415),
    ("../escape.pdf", "application/pdf", b"%PDF-1.4", 422),
    ("folder\\escape.pdf", "application/pdf", b"%PDF-1.4", 422),
    ("wrong.pdf", "image/png", b"\x89PNG\r\n\x1a\n", 415),
    ("payload.exe.pdf", "application/pdf", b"MZ-executable", 415),
    ("large.dwg", "image/vnd.dwg", b"AC1032" + b"\0" * (768 * 1024), 413),
])
def test_resolved_d10_unsafe_files_and_unchanged_transport_limit(filename, mime, data, code):
    from services.kitchen_attachments import validate_file
    with pytest.raises(HTTPException) as invalid:
        validate_file(data, mime, filename, kitchen_projects.resolved_policy({}))
    assert invalid.value.status_code == code


@pytest.mark.parametrize("addition", [
    {"../escape.xml": "<test/>"}, {"/absolute.xml": "<test/>"},
    {"word\\escape.xml": "<test/>"}, {"word/vbaProject.bin": "macro"},
    {"word/embeddings/object.xml": "<test/>"}, {"word/script.js": "alert(1)"},
    {"word/large.xml": "x" * 200000},
    {"word/extra.xml": '<!DOCTYPE x [<!ENTITY x "secret">]><x>&x;</x>'},
])
def test_resolved_d10_office_packages_reject_traversal_executable_expansion_and_entities(addition):
    from services.kitchen_attachments import validate_file
    mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    with pytest.raises(HTTPException) as invalid:
        validate_file(office_bytes(".docx", addition), mime, "synthetic.docx", kitchen_projects.resolved_policy({}))
    assert invalid.value.status_code == 415


def test_resolved_d10_office_packages_reject_missing_parts_wrong_root_and_encryption():
    import io
    import struct
    import zipfile
    from services.kitchen_attachments import validate_file
    mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    missing = io.BytesIO()
    with zipfile.ZipFile(missing, "w") as package:
        package.writestr("[Content_Types].xml", "<Types/>")
    encrypted = bytearray(office_bytes(".docx"))
    for signature, offset in ((b"PK\x03\x04", 6), (b"PK\x01\x02", 8)):
        start = 0
        while (position := encrypted.find(signature, start)) >= 0:
            flags = struct.unpack_from("<H", encrypted, position + offset)[0]
            struct.pack_into("<H", encrypted, position + offset, flags | 1)
            start = position + 4
    for content in (missing.getvalue(), office_bytes(".docx", main='<workbook xmlns="wrong"/>'), bytes(encrypted)):
        with pytest.raises(HTTPException) as invalid:
            validate_file(content, mime, "synthetic.docx", kitchen_projects.resolved_policy({}))
        assert invalid.value.status_code == 415


def test_resolved_d10_cad_octet_stream_alias_and_office_encoding_do_not_bypass_validation():
    from services.kitchen_attachments import validate_file
    policy = kitchen_projects.resolved_policy({})
    cad = b"AC1032" + b"\0" * 26
    for mime in ("", "application/octet-stream"):
        assert validate_file(cad, mime, "synthetic.dwg", policy)
        with pytest.raises(HTTPException) as arbitrary:
            validate_file(b"MZ-executable", mime, "synthetic.exe", policy)
        assert arbitrary.value.status_code == 415
    mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    unsafe_xml = '<?xml version="1.0" encoding="UTF-16"?><!DOCTYPE document [<!ENTITY x "secret">]><document xmlns="http://schemas.openxmlformats.org/wordprocessingml/2006/main">&x;</document>'.encode("utf-16")
    for content in (b"MZ-stub" + office_bytes(".docx"), office_bytes(".docx", {"word/document.xml": unsafe_xml})):
        with pytest.raises(HTTPException) as unsafe:
            validate_file(content, mime, "synthetic.docx", policy)
        assert unsafe.value.status_code == 415


def test_resolved_d10_binary_dxf_typed_framing_and_utf8_text_are_validated():
    import struct
    from services.kitchen_attachments import validate_file
    policy = kitchen_projects.resolved_policy({})
    pairs = [(0, b"SECTION"), (2, b"HEADER"), (9, b"$ACADVER"), (1, b"AC1032"), (0, b"ENDSEC"), (0, b"EOF")]
    sentinel = b"AutoCAD Binary DXF\r\n\x1a\x00"
    binary = sentinel + b"".join(struct.pack("<H", group) + value + b"\0" for group, value in pairs)
    legacy_binary = sentinel + b"".join(bytes([group]) + value + b"\0" for group, value in pairs)
    unicode_text = "0\nSECTION\n2\nHEADER\n1\nकिचन\n0\nENDSEC\n0\nEOF\n".encode("utf-8")
    for content in (binary, legacy_binary, unicode_text):
        assert validate_file(content, "image/vnd.dxf", "synthetic.dxf", policy)
    for content in (sentinel, binary[:-1], binary[:-4], binary + b"trailing", sentinel + b"\0", binary.replace(b"ENDSEC", b"NOTEND")):
        with pytest.raises(HTTPException) as bad:
            validate_file(content, "image/vnd.dxf", "synthetic.dxf", policy)
        assert bad.value.status_code == 415


def test_resolved_d10_xlsx_print_settings_are_bounded_data_parts_not_blanket_binary_rejection():
    import struct
    from services.kitchen_attachments import validate_file
    policy = kitchen_projects.resolved_policy({})
    mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    settings_mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.printerSettings"
    devmode = bytearray(220)
    struct.pack_into("<HH", devmode, 68, 220, 0)  # DEVMODEW dmSize/dmDriverExtra
    base_types = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>{extra}</Types>'
    printer_part = "xl/printerSettings/printerSettings1.bin"
    for declaration in (f'<Default Extension="bin" ContentType="{settings_mime}"/>',
                        f'<Override PartName="/{printer_part}" ContentType="{settings_mime}"/>'):
        data = office_bytes(".xlsx", {"[Content_Types].xml": base_types.format(extra=declaration), printer_part: bytes(devmode)})
        assert validate_file(data, mime, "print-settings.xlsx", policy)
    for path, kind, content in (("xl/unknown.bin", settings_mime, bytes(devmode)),
                                (printer_part, "application/octet-stream", bytes(devmode)),
                                (printer_part, settings_mime, b"MZ" + b"\0" * 218),
                                (printer_part, settings_mime, bytes(devmode[:-1]))):
        declaration = f'<Override PartName="/{path}" ContentType="{kind}"/>'
        data = office_bytes(".xlsx", {"[Content_Types].xml": base_types.format(extra=declaration), path: content})
        with pytest.raises(HTTPException) as unsafe:
            validate_file(data, mime, "unsafe-settings.xlsx", policy)
        assert unsafe.value.status_code == 415
