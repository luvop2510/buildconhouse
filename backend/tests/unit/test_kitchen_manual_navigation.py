"""Stage movement is independent of recorded business-task completion."""
import copy
import pytest
from fastapi import HTTPException
from models import UserPublic
from models_kitchen import STAGES
from services import kitchen_workflow
from tests.unit.test_kitchen_projects import setup, cmd, create_request

@pytest.mark.asyncio
async def test_incomplete_project_can_move_all_stages_both_directions_with_history(setup):
    database, service, owner = setup
    project = await service.create(owner, create_request(customer_id='customer-a', idempotency_key='manual-all-stages'))
    original = copy.deepcopy(project)
    for target in [*STAGES[1:], *reversed(STAGES[:-1])]:
        before = project['stage']
        project = await service.command(owner, project['id'], cmd(project['version'], 'move_stage', {'target_stage': target}))
        assert project['stage'] == target
        assert project['activity'][-1]['payload']['from_stage'] == before
        assert project['activity'][-1]['payload']['to_stage'] == target
        for field in ('lead', 'visit', 'cad', 'orders', 'approvals', 'design_versions', 'quotation_versions', 'production', 'installation'):
            assert project.get(field) == original.get(field)
    assert project['manual_stage_navigation'] is True
    assert project['completion_date']
    assert (project.get('installation') or {}).get('completion_date') is None

@pytest.mark.asyncio
async def test_manual_move_retains_replay_version_permission_and_adjacency_guards(setup):
    database, service, owner = setup
    project = await service.create(owner, create_request(customer_id='customer-a', idempotency_key='manual-safe-replay'))
    request = cmd(project['version'], 'move_stage', {'target_stage': 'visit'}, 'manual-replay-key')
    moved = await service.command(owner, project['id'], request)
    replay = await service.command(owner, project['id'], request)
    assert replay['replayed'] and replay['version'] == moved['version']
    with pytest.raises(HTTPException) as stale:
        await service.command(owner, project['id'], cmd(project['version'], 'move_stage', {'target_stage': 'cad'}, 'manual-stale-key'))
    assert stale.value.status_code == 409
    with pytest.raises(HTTPException) as invalid:
        await service.command(owner, project['id'], cmd(moved['version'], 'move_stage', {'target_stage': 'order'}))
    assert invalid.value.status_code == 422
    denied = UserPublic(id='denied', full_name='Denied', role='owner', active_floor_id='first-floor', floor_ids=['first-floor'])
    with pytest.raises(HTTPException) as forbidden:
        await service.command(denied, project['id'], cmd(moved['version'], 'move_stage', {'target_stage': 'lead'}))
    assert forbidden.value.status_code == 403

@pytest.mark.asyncio
@pytest.mark.parametrize('lifecycle', ['On Hold', 'Cancelled'])
async def test_manual_move_preserves_held_status_and_saved_approval_evidence(setup, lifecycle):
    database, service, owner = setup
    project = await service.create(owner, create_request(customer_id='customer-a', idempotency_key='manual-held-stages'))
    stored = database.kitchen_projects.rows[0]
    stored['stage'] = 'completed'
    stored['lifecycle_status'] = lifecycle
    stored['approvals'] = [{'id':'existing-approval', 'scope':'production', 'decision':'Approved'}]
    project = await service.command(owner, project['id'], cmd(project['version'], 'move_stage', {'target_stage': 'installation'}))
    assert project['stage'] == 'installation' and project['status'] == lifecycle
    assert project['approvals'] == stored['approvals']
    project = await service.command(owner, project['id'], cmd(project['version'], 'move_stage', {'target_stage': 'completed'}))
    assert project['status'] == lifecycle


def test_manual_back_to_installation_is_not_automatically_undone():
    project = {'stage':'installation', 'manual_stage_navigation':True, 'installation':{'status':'Completed','completion_date':'2026-10-20'}}
    kitchen_workflow.recompute_completion(project, {})
    assert project['stage'] == 'installation'
