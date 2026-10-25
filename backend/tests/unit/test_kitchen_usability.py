"""Kitchen usability changes retain document security and workflow history."""
import copy
import hashlib

import pytest
from fastapi import HTTPException

from models import UserPublic
from models_kitchen import STAGES
from services.kitchen_projects import resolved_policy, transition_error, validate
from services import kitchen_workflow
from services.kitchen_attachments import canonical_type, validate_file
from tests.unit.test_kitchen_projects import setup, cmd, create_request


@pytest.mark.parametrize('mime', ['', 'application/octet-stream', 'application/pdf', 'Application/PDF; charset=binary'])
def test_pdf_picker_metadata_is_normalized_but_bytes_are_verified(mime):
    data = b'%PDF-1.4 synthetic document'
    assert canonical_type(mime, 'Drawing.PDF') == 'application/pdf'
    assert validate_file(data, mime, 'Drawing.PDF', resolved_policy({})) == hashlib.sha256(data).hexdigest()
    with pytest.raises(HTTPException) as invalid:
        validate_file(b'not a PDF', mime, 'Drawing.PDF', resolved_policy({}))
    assert invalid.value.status_code == 415


@pytest.mark.asyncio
@pytest.mark.parametrize('stage', STAGES)
async def test_pdf_can_be_appended_at_every_stage_without_changing_workflow(setup, stage):
    database, service, owner = setup
    saved = await service.create(owner, create_request(customer_id='customer-a', idempotency_key='all-stage-doc'))
    project = database.kitchen_projects.rows[0]
    project['stage'] = stage
    project['status'] = 'Completed' if stage == 'completed' else project['status']
    original = copy.deepcopy(project)
    class Storage:
        objects = {}
        async def require_private_bucket(self, bucket):
            assert bucket == 'forge-private'
        async def exists(self, *, key, **kwargs):
            return key in self.objects
        async def upload(self, *, key, data, **kwargs):
            self.objects[key] = data
        async def download(self, *, key, **kwargs):
            return self.objects[key]
    storage = Storage()
    kwargs = dict(expected_version=saved['version'], key='upload-all-stages', filename='Drawing.pdf',
                  content_type='application/octet-stream', data=b'%PDF-1.4 synthetic', storage=storage, bucket='forge-private')
    result = await service.attach(owner, saved['id'], **kwargs)
    replay = await service.attach(owner, saved['id'], **kwargs)
    assert replay['replayed'] and len(replay['attachments']) == 1
    assert result['attachments'][0]['content_type'] == 'application/pdf'
    assert 'storage_key' not in result['attachments'][0]
    for field in ('stage', 'status', 'orders', 'approvals', 'design_versions', 'quotation_versions'):
        assert result[field] == original[field]
    assert result['version'] == original['version'] + 1
    data, _ = await service.attachment(owner, saved['id'], result['attachments'][0]['id'], storage)
    assert data == kwargs['data']


@pytest.mark.asyncio
async def test_design_without_document_and_editable_details_have_audited_progression(setup):
    database, service, owner = setup
    project = await service.create(owner, create_request(customer_id='customer-a', idempotency_key='design-edit-test'))
    project = await service.command(owner, project['id'], cmd(project['version'], 'convert'))
    project = await service.command(owner, project['id'], cmd(project['version'], 'save_visit', {'status': 'Visited', 'display_model': 'Wardrobe'}))
    project = await service.command(owner, project['id'], cmd(project['version'], 'advance_stage', {'target_stage': 'cad'}))
    project = await service.command(owner, project['id'], cmd(project['version'], 'save_cad', {'received': True, 'progress': 100, 'status': 'Completed'}))
    project = await service.command(owner, project['id'], cmd(project['version'], 'advance_stage', {'target_stage': 'design'}))
    project = await service.command(owner, project['id'], cmd(project['version'], 'design_present', {'presentation_date': '2026-10-25', 'requirements': 'Tall cabinets', 'budget_discussion': 'Discuss options'}))
    version = project['design_versions'][-1]
    assert version['attachment_id'] is None and version['url'] is None
    payload = {'version_id': version['id'], 'presentation_date': '2026-10-24', 'shared_date': '2026-10-25',
               'handoff_date': '2026-10-25', 'response': 'Approved',
               'requirements': 'Tall cabinets and drawers', 'budget_discussion': 'Within agreed budget', 'reason': 'Correct showroom record'}
    project = await service.command(owner, project['id'], cmd(project['version'], 'design_update', payload))
    assert project['design_revision_count'] == 0
    assert project['design_versions'][-1]['requirements'] == payload['requirements']
    correction = project['activity'][-1]['payload']
    assert correction['reason'] == payload['reason']
    assert correction['changes']['design']['before']['response'] == 'Pending'
    assert correction['changes']['design']['after']['response'] == 'Approved'
    staff = UserPublic(id='staff-a', full_name='Staff A', role='sales', active_floor_id='second-floor', floor_ids=['second-floor'])
    with pytest.raises(HTTPException) as denied:
        await service.command(staff, project['id'], cmd(project['version'], 'design_update', payload))
    assert denied.value.status_code == 403
    with pytest.raises(HTTPException) as stale:
        await service.command(owner, project['id'], cmd(project['version'] - 1, 'design_update', payload, 'stale-design-edit'))
    assert stale.value.status_code == 409
    project = await service.command(owner, project['id'], cmd(project['version'], 'advance_stage', {'target_stage': 'quotation'}))
    assert project['stage'] == 'quotation'


def test_legacy_policy_cannot_require_removed_controls():
    project = {'stage': 'visit', 'visit': {'status': 'Visited'}, 'duplicate_review': {'status': 'cleared'}}
    assert transition_error(project, 'cad', {'required_fields': {'visit': ['requirements', 'interested', 'budget_discussion']}}) is None


@pytest.mark.parametrize('progress,status', [(0, 'Not Started'), (1, 'In Progress'), (50, 'In Progress'), (99, 'In Progress'), (100, 'Completed')])
def test_cad_status_is_derived_even_for_stale_client_status(progress, status):
    from models_kitchen import CadFields
    fields = CadFields(received=True, progress=progress, status='Not Started', ready=True)
    assert fields.status == status
    assert fields.ready is (progress == 100)


def test_order_document_replacement_preserves_previous_file_and_commercial_terms(setup):
    _, _, owner = setup
    project = {'stage': 'order', 'orders': [{'id': 'order', 'confirmed': True, 'status': 'Confirmed', 'final_amount': '125.10', 'confirmation_document_id': 'original'}],
               'attachments': [{'id': 'original'}, {'id': 'replacement'}]}
    kitchen_workflow.apply(project, 'order_document', {'attachment_id': 'replacement'}, {}, owner, 'now', validate)
    order = project['orders'][0]
    assert order['confirmation_document_id'] == 'replacement'
    assert order['document_history'][-1]['previous_attachment_id'] == 'original'
    assert order['final_amount'] == '125.10'
    assert project['attachments'] == [{'id': 'original'}, {'id': 'replacement'}]
    with pytest.raises(HTTPException):
        kitchen_workflow.apply(project, 'order_document', {'attachment_id': 'foreign'}, {}, owner, 'now', validate)


def test_order_date_notes_are_editable_with_chronology_and_history(setup):
    _, _, owner = setup
    project = {'stage': 'order', 'orders': [{'id': 'order', 'quotation_version_id': 'quote', 'order_date': '2026-10-21', 'notes': 'Old note', 'final_amount': '100.00', 'advance': {'date': '2026-10-23'}}],
               'quotation_versions': [{'id': 'quote', 'shared_date': '2026-10-20'}]}
    kitchen_workflow.apply(project, 'order_update', {'order_date': '2026-10-22', 'notes': 'Corrected'}, {}, owner, 'now', validate)
    order = project['orders'][0]
    assert order['order_date'] == '2026-10-22' and order['notes'] == 'Corrected'
    assert order['corrections'][0]['before']['notes'] == 'Old note'
    assert order['final_amount'] == '100.00'
    order['amendments'] = [{'date': '2026-10-22'}]
    for date in ('2026-10-19', '2026-10-23', '2026-10-24'):
        with pytest.raises(HTTPException):
            kitchen_workflow.apply(project, 'order_update', {'order_date': date}, {}, owner, 'now', validate)


def test_design_correction_cannot_manually_replace_customer_revision_total(setup):
    _, _, owner = setup
    project = {'stage': 'design', 'design_versions': [{'id': 'design', 'response': 'Pending', 'workflow_cycle': 1}], 'design_revision_count': 1}
    with pytest.raises(HTTPException) as denied:
        kitchen_workflow.apply(project, 'design_update', {'version_id': 'design', 'presentation_date': '2026-10-22', 'response': 'Pending', 'revision_count': 10, 'reason': 'Manual override'}, {}, owner, 'now', validate)
    assert denied.value.status_code == 422
    assert project['design_revision_count'] == 1


@pytest.mark.parametrize('approved', [False, True])
def test_changed_initial_order_amount_keeps_quotation_and_requires_customer_approval(setup, approved):
    _, _, owner = setup
    project = {'stage': 'order', 'orders': [], 'attachments': [], 'design_versions': [{'id': 'design', 'response': 'Approved'}],
               'quotation_versions': [{'id': 'quote', 'design_version_id': 'design', 'amount': '125.10', 'response': 'Approved', 'shared_date': '2026-10-21'}]}
    fields = {'quotation_version_id': 'quote', 'order_date': '2026-10-22', 'final_amount': '120.00', 'amount_customer_approved': approved}
    if not approved:
        with pytest.raises(HTTPException):
            kitchen_workflow.apply(project, 'order_confirm', fields, {}, owner, 'now', validate)
        assert not project['orders']
    else:
        kitchen_workflow.apply(project, 'order_confirm', fields, {}, owner, 'now', validate)
        assert project['orders'][-1]['original_amount'] == '125.10'
        assert project['orders'][-1]['final_amount'] == project['order_amount'] == '120.00'
        assert project['orders'][-1]['amendments'][0]['customer_approved'] is True
        assert project['quotation_versions'][0]['amount'] == '125.10'


@pytest.mark.asyncio
async def test_pdf_assignment_persists_with_owner_authority(setup):
    _, service, owner = setup
    project = await service.create(owner, create_request(customer_id='customer-a', assigned_to='staff-a', idempotency_key='pdf-complete-fields'))
    assert project['assigned_to'] == 'staff-a' and project['assigned_to_name'] == 'Staff A'
    project = await service.command(owner, project['id'], cmd(project['version'], 'move_stage', {'target_stage': 'visit'}))
    assert project['assigned_to'] is None  # No automatic assignment of later stages.
    project = await service.command(owner, project['id'], cmd(project['version'], 'assign', {'stage': 'visit', 'user_id': 'staff-a'}))
    assert project['assignments'] == {'lead':'staff-a', 'visit':'staff-a'}
    assert project['activity'][-1]['type'] == 'assign'
    with pytest.raises(HTTPException) as invalid:
        await service.command(owner, project['id'], cmd(project['version'], 'assign', {'stage':'visit','user_id':'foreign-worker'}))
    assert invalid.value.status_code == 422
