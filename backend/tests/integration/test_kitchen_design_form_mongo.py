"""Atomic simplified Design form uses real HTTP persistence and version history."""
import asyncio
import copy

from tests.integration.test_kitchen_projects_mongo import environment, configure, reach_stage, headers, accepted, command


def test_simplified_design_form_atomic_dates_versions_and_production_lock():
    async def run():
        async with environment() as env:
            await configure(env)
            project = await reach_stage(env, 'design')
            fields = {'requirements': 'Tall cabinets', 'budget_discussion': 'Within budget',
                'response': 'Approved', 'shared_date': '2026-10-22', 'approval_date': '2026-10-23',
                'handoff_date': '2026-10-24', 'notes': 'Internal form notes'}
            project = await accepted(env, project, 'design_present', fields)
            first = copy.deepcopy(project['design_versions'][0])
            assert first['presentation_date'] is None
            assert first['shared_by'] == first['handoff_by'] == env['ids']['owner']
            assert project['design_revision_count'] == 0
            project = await accepted(env, project, 'design_update', {'version_id': first['id'],
                'response': 'Approved', 'notes': 'Internal correction', 'reason': 'Update internal note'})
            assert project['design_versions'][0]['presentation_date'] is None
            first = copy.deepcopy(project['design_versions'][0])
            invalid = await command(env, project, 'design_present', {**fields, 'handoff_date': '2026-10-22'})
            assert invalid.status_code == 422
            denied = await command(env, project, 'design_present', {'notes': 'Another drawing'}, actor='worker')
            assert denied.status_code == 422 or denied.status_code == 403
            project = await accepted(env, project, 'design_present', {'notes': 'Another drawing'})
            assert project['design_versions'][0] == first
            assert project['design_versions'][-1]['number'] == 2
            assert project['design_versions'][-1]['presentation_date'] is None
            assert project['design_revision_count'] == 0
            reloaded = await env['api'].get(f"/api/kitchen-projects/{project['id']}", headers=headers(env))
            assert reloaded.status_code == 200
            assert reloaded.json()['design_versions'] == project['design_versions']
            await env['db'].kitchen_projects.update_one({'id': project['id']}, {'$set': {
                'production': {'status': 'In Production', 'start_date': '2026-10-25'}}})
            locked = await command(env, project, 'design_present', {'notes': 'Must return to Design'})
            assert locked.status_code == 422 and 'Return to Design' in locked.text
    asyncio.run(run())


def test_editable_quotation_fields_round_trip_without_implicit_status_and_keep_order_basis():
    async def run():
        async with environment() as env:
            await configure(env)
            project = await reach_stage(env, 'quotation')
            fields = {'design_version_id': project['design_versions'][-1]['id'], 'amount': None,
                'received_status': 'Not recorded', 'sent_status': 'No', 'received_date': None,
                'shared_date': None, 'response': 'Pending', 'notes': 'Private draft'}
            project = await accepted(env, project, 'quotation_receive', fields)
            quote = copy.deepcopy(project['quotation_versions'][-1])
            assert all(quote[key] == value for key, value in fields.items())
            updated = {'version_id': quote['id'], 'amount': '1234.50', 'received_status': 'Yes',
                'received_date': '2026-10-24', 'sent_status': 'Yes', 'shared_date': '2026-10-25',
                'response': 'Approved', 'notes': 'Internal approval note'}
            project = await accepted(env, project, 'quotation_update', updated)
            reloaded = await env['api'].get(f"/api/kitchen-projects/{project['id']}", headers=headers(env))
            assert reloaded.json()['quotation_versions'] == project['quotation_versions']
            project = await accepted(env, project, 'move_stage', {'target_stage': 'order'})
            project = await accepted(env, project, 'order_confirm', {'quotation_version_id': quote['id'],
                'final_amount': '1234.50', 'order_date': '2026-10-26'})
            original = copy.deepcopy(project['orders'])
            project = await accepted(env, project, 'move_stage', {'target_stage': 'quotation'})
            project = await accepted(env, project, 'quotation_update', {'version_id': quote['id'], 'amount': '1300.00'})
            assert project['orders'] == original
            assert project['activity'][-1]['payload']['changes']['quotation']['before']['amount'] == '1234.50'
            assert project['activity'][-1]['payload']['changes']['quotation']['after']['amount'] == '1300.00'
            denied = await command(env, project, 'quotation_update', {'version_id': quote['id'], 'notes': 'No'}, actor='worker')
            assert denied.status_code in {403, 422}
            await env['db'].kitchen_projects.update_one({'id': project['id']}, {'$set': {
                'production': {'status': 'In Production', 'start_date': '2026-10-26'}}})
            locked = await command(env, project, 'quotation_update', {'version_id': quote['id'], 'notes': 'No'})
            assert locked.status_code == 422 and 'Return to Design' in locked.text
    asyncio.run(run())


def test_design_form_dates_record_actors_on_explicit_first_save():
    async def run():
        async with environment() as env:
            await configure(env)
            project = await reach_stage(env, 'design')
            project = await accepted(env, project, 'design_present', {'notes': 'New draft'})
            design = project['design_versions'][-1]
            project = await accepted(env, project, 'design_update', {'version_id': design['id'], 'reason': 'Explicit dates',
                'shared_date': '2026-10-24', 'response': 'Approved', 'approval_date': '2026-10-25', 'handoff_date': '2026-10-26'})
            design = project['design_versions'][-1]
            assert design['shared_by'] == design['handoff_by'] == env['ids']['owner']
            assert design['presentation_date'] is None
    asyncio.run(run())
