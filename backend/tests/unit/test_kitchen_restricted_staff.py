import copy
import pytest
from fastapi import HTTPException
from services import kitchen_access as access
from services.access_grants import build_grant, resource_supports
from tests.unit.test_kitchen_projects import setup, cmd
from tests.unit.test_kitchen_stage_access import stage_staff
from tests.unit.test_kitchen_version_relationships import aggregate


def grant(user, resource, actions):
    return build_grant(user_id=user.id, resource=resource, actions=actions, floor_id='second-floor', expires_at=None, actor_id='owner', actor_name='Owner')


async def restricted_user(db, stage='design', actions=None):
    user, existing = stage_staff(db, stage, actions or ['view', 'update'])
    db.users.rows[0]['delegation_grants'] = [existing, grant(user, 'kitchen_restricted', ['view'])]
    await access.capability(db, user, 'view')
    return user


def test_registry_scopes_pdf_actions():
    assert resource_supports('kitchen_design', 'second-floor', ['view', 'pdf_choose', 'pdf_open', 'pdf_download'])
    assert not resource_supports('kitchen_production', 'second-floor', ['view', 'pdf_open'])
    assert not resource_supports('customers', 'second-floor', ['view', 'pdf_open'])


@pytest.mark.asyncio
async def test_marker_and_final_pdf_purposes(setup):
    db, _, _ = setup
    legacy, _ = stage_staff(db, 'design')
    await access.capability(db, legacy, 'view')
    assert not access.restricted(legacy)
    assert access.pdf_allowed(legacy, 'design', 'open')
    user = await restricted_user(db, actions=['view', 'update', 'pdf_open'])
    project = {'stage': 'design', 'final_design_version_id': 'final', 'design_versions': [{'id': 'final', 'final_attachment_id': 'final-pdf'}, {'id': 'draft', 'final_attachment_id': 'draft-pdf'}]}
    final = {'id': 'final-pdf', 'content_type': 'application/pdf'}
    access.require_attachment(user, project, final, 'open')
    for metadata, purpose in [(final, 'download'), ({**final, 'id': 'draft-pdf'}, 'open')]:
        with pytest.raises(HTTPException):
            access.require_attachment(user, project, metadata, purpose)
    with pytest.raises(HTTPException):
        access.require_upload(user, project, 'application/pdf')
    access.require_upload(user, {'stage': 'installation'}, 'application/pdf')
    access.require_attachment(user, {'stage': 'installation'}, {**final, 'stage': 'installation'}, 'download')
    with pytest.raises(HTTPException):
        access.require_attachment(user, {'stage': 'installation'}, {**final, 'stage': 'design'}, 'download')


@pytest.mark.asyncio
async def test_redaction_with_all_stages(setup):
    db, _, _ = setup
    user, workspace = stage_staff(db, 'design')
    workspace['resource'] = 'kitchen_projects'
    db.users.rows[0]['delegation_grants'] = [workspace, grant(user, 'kitchen_restricted', ['view'])]
    await access.capability(db, user, 'view')
    project = aggregate('design')
    project.update(final_design_version_id='d1', order_amount='500', activity=[{'notes': '₹500'}], attachments=[{'id': 'doc', 'stage': 'design', 'content_type': 'application/pdf'}], orders=[{'final_amount': '500', 'installments': [{'amount': '200'}]}])
    project['design_versions'][0]['final_attachment_id'] = 'doc'
    result = access.redact_project(copy.deepcopy(project), project, user)
    assert result['order_amount'] is None
    assert result['orders'][0]['final_amount'] is None
    assert result['orders'][0]['installments'] == []
    assert not result.get('activity')
    assert result['attachments'] == []


@pytest.mark.asyncio
async def test_direct_service_paths_denied(setup):
    db, service, _ = setup
    user = await restricted_user(db, stage='production')
    project = aggregate('production')
    project.update(id='p', floor_id='second-floor', version=1, command_receipts=[], lifecycle_status='Active', attachments=[{'id': 'pdf', 'content_type': 'application/pdf'}])
    db.kitchen_projects.rows = [project]
    with pytest.raises(HTTPException) as upload:
        await service._attach(user, 'p', expected_version=1, key='upload-test-key', filename='x.pdf', content_type='application/pdf', data=b'%PDF', storage=None, bucket='private')
    assert upload.value.status_code == 403
    with pytest.raises(HTTPException) as download:
        await service.attachment(user, 'p', 'pdf', None)
    assert download.value.status_code == 403
    with pytest.raises(HTTPException) as write:
        await service._command(user, 'p', cmd(1, 'order_installment', {'amount': '100'}), {}, project)
    assert write.value.status_code == 403
    with pytest.raises(HTTPException) as sorting:
        await service.list(user, sort='order_amount')
    assert sorting.value.status_code == 403


@pytest.mark.asyncio
async def test_restricted_chunk_read_and_transfer_begin_are_denied(setup):
    from services.kitchen_file_transfers import download_part, KitchenFileTransfers, TransferStart
    db, _, _ = setup
    user = await restricted_user(db, stage='production')
    project = aggregate('production')
    project.update(id='p', floor_id='second-floor', lifecycle_status='Active', attachments=[{'id': 'pdf', 'content_type': 'application/pdf', 'stage': 'production'}])
    db.kitchen_projects.rows = [project]
    with pytest.raises(HTTPException) as read:
        await download_part(db, user, 'p', 'pdf', 0, None)
    assert read.value.status_code == 403
    request = TransferStart(filename='final.pdf', content_type='application/pdf', size_bytes=100,
                            expected_version=1, idempotency_key='transfer-test-key', purpose='final_production')
    with pytest.raises(HTTPException) as write:
        await KitchenFileTransfers(db).begin(user, 'p', request)
    assert write.value.status_code == 403


@pytest.mark.asyncio
async def test_dashboard_and_export_hide_money(setup, monkeypatch):
    db, service, _ = setup
    user, workspace = stage_staff(db, 'order', ['view', 'export'])
    workspace['resource'] = 'kitchen_projects'
    db.users.rows[0]['delegation_grants'] = [workspace, grant(user, 'kitchen_restricted', ['view'])]
    class DashboardCursor:
        async def to_list(self, _):
            return [{'totals': [{'value': 98765, 'projects': 1}], 'customers': [{'count': 1}], 'stages': [], 'workload': []}]
    monkeypatch.setattr(db.kitchen_projects, 'aggregate', lambda *a, **kw: DashboardCursor(), raising=False)
    dashboard = await service.dashboard(user)
    assert dashboard['active_order_value'] is None
    assert dashboard['confirmed_order_value'] is None
    async def fake_list(*args, **kwargs):
        return {'total': 1, 'rows': [{'reference': 'p', 'customer': {'name': 'A'}, 'order_amount': '98765', 'completion_date': '2026-01-01', 'design_revision_count': 0, 'site_visit_count': 0}]}
    monkeypatch.setattr(service, 'list', fake_list)
    data = await service.export_completed(user)
    assert b'98765' not in data


@pytest.mark.asyncio
@pytest.mark.parametrize('stage,command', [('production', 'production_update')])
async def test_restricted_work_save_preserves_hidden_notes(setup, stage, command):
    from tests.unit.test_kitchen_projects import create_request
    db, service, owner = setup
    created = await service.create(owner, create_request(customer_id='customer-a', idempotency_key='restricted-notes-create'))
    stored = db.kitchen_projects.rows[0]
    stored.update(aggregate(stage))
    stored['manual_stage_navigation'] = True
    stored[stage] = {'status': 'Not Started', 'notes': 'Private amount 12345'}
    user = await restricted_user(db, stage=stage)
    await service.command(user, created['id'], cmd(created['version'], command, {'status': 'Not Started', 'notes': None}))
    assert db.kitchen_projects.rows[0][stage]['notes'] == 'Private amount 12345'


@pytest.mark.asyncio
async def test_restricted_installation_notes_remain_visible_and_editable(setup):
    from tests.unit.test_kitchen_projects import create_request
    db, service, owner = setup
    created = await service.create(owner, create_request(customer_id='customer-a', idempotency_key='installation-notes-create'))
    stored = db.kitchen_projects.rows[0]
    stored.update(aggregate('installation'))
    stored['installation'] = {'status': 'Not Started', 'notes': 'Existing installation instructions'}
    stored['order_amount'] = '12345'
    user = await restricted_user(db, stage='installation')
    before = await service.get(user, created['id'])
    assert before['installation']['notes'] == 'Existing installation instructions'
    assert before['order_amount'] is None
    after = await service.command(user, created['id'], cmd(created['version'], 'installation_update', {'status': 'Not Started', 'notes': 'Updated instructions'}))
    assert after['installation']['notes'] == 'Updated instructions'
    assert db.kitchen_projects.rows[0]['installation']['notes'] == 'Updated instructions'
    assert after['order_amount'] is None


@pytest.mark.asyncio
@pytest.mark.parametrize('stage,command,payload', [
    ('lead', 'edit_lead', {'budget': None, 'notes': None}),
    ('visit', 'save_visit', {'notes': None, 'budget_discussion': None, 'requirements': None}),
    ('cad', 'save_cad', {'notes': None}),
])
async def test_restricted_early_stage_saves_preserve_redacted_fields(setup, stage, command, payload):
    from tests.unit.test_kitchen_projects import create_request
    db, service, owner = setup
    created = await service.create(owner, create_request(customer_id='customer-a', idempotency_key='early-stage-notes-create'))
    stored = db.kitchen_projects.rows[0]
    stored['stage'] = stage
    stored[stage]['notes'] = 'Private notes'
    if stage == 'lead':
        stored[stage]['budget'] = '12345.00'
    if stage == 'visit':
        stored[stage]['budget_discussion'] = 'Private budget'
        stored[stage]['requirements'] = 'Private requirements'
    user = await restricted_user(db, stage=stage)
    await service.command(user, created['id'], cmd(created['version'], command, payload))
    assert db.kitchen_projects.rows[0][stage]['notes'] == 'Private notes'
    if stage == 'lead':
        assert db.kitchen_projects.rows[0][stage]['budget'] == '12345.00'
    if stage == 'visit':
        assert db.kitchen_projects.rows[0][stage]['budget_discussion'] == 'Private budget'
        assert db.kitchen_projects.rows[0][stage]['requirements'] == 'Private requirements'


@pytest.mark.asyncio
async def test_restricted_configuration_hides_activity_and_financial_threshold(setup, monkeypatch):
    db, service, _ = setup
    user = await restricted_user(db)
    async def fake_policy():
        return {'decision_contract': '2026-10-20', 'department_manager_user_ids': [],
                'production': {'minimum_advance_amount': '12345', 'minimum_advance_percent': 20}, 'activity': [{'notes': '12345'}]}
    monkeypatch.setattr(service, 'policy', fake_policy)
    result = await service.public_policy(user)
    assert result['activity'] == []
    assert result['production']['minimum_advance_amount'] is None
    assert result['production']['minimum_advance_percent'] is None


@pytest.mark.asyncio
@pytest.mark.parametrize('stage', ['design', 'quotation', 'order', 'production', 'completed'])
async def test_restricted_non_pdf_files_cannot_bypass_commercial_privacy(setup, stage):
    db, _, _ = setup
    user = await restricted_user(db, stage=stage)
    project = aggregate(stage)
    project['attachments'] = [{'id': 'xlsx', 'stage': stage, 'content_type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'filename': 'quote.xlsx'}]
    with pytest.raises(HTTPException):
        access.require_upload(user, project, project['attachments'][0]['content_type'])
    with pytest.raises(HTTPException):
        access.require_attachment(user, project, project['attachments'][0], 'download')
    assert access.redact_project(copy.deepcopy(project), project, user)['attachments'] == []


@pytest.mark.asyncio
async def test_restricted_earlier_and_installation_files_unchanged(setup):
    db, _, _ = setup
    user = await restricted_user(db, stage='lead')
    for stage in ('lead', 'visit', 'cad', 'installation'):
        project = {'stage': stage}
        access.require_upload(user, project, 'application/pdf')
        access.require_upload(user, project, 'image/png')
        access.require_attachment(user, project, {'id': 'file', 'stage': stage, 'content_type': 'application/pdf'}, 'download')
        access.require_attachment(user, project, {'id': 'file', 'stage': stage, 'content_type': 'image/png'}, 'download')


@pytest.mark.asyncio
async def test_old_transfer_cannot_continue_after_file_permission_revoked(setup):
    from unittest.mock import AsyncMock
    from services.kitchen_file_transfers import KitchenFileTransfers
    db, _, _ = setup
    user = await restricted_user(db, stage='quotation')
    service = KitchenFileTransfers(db)
    service.authorized = AsyncMock(return_value=({'stage': 'quotation'}, {}))
    service.session = AsyncMock(return_value={'content_type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'})
    with pytest.raises(HTTPException) as part:
        await service.put_part(user, 'project', 'transfer', 0, None)
    assert part.value.status_code == 403
    with pytest.raises(HTTPException) as finish:
        await service.finish(user, 'project', 'transfer', None, None, None)
    assert finish.value.status_code == 403
