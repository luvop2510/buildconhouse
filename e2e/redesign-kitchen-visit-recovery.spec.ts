import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

for (const mode of ['autosave', 'manual', 'next'] as const) {
  test(`critical Kitchen Visit ${mode} confirms a lost saved response before Next CAD`, async ({ page }) => {
    await mockSession(page, '/kitchen/visit-recovery/stages/visit', false, { floorId: 'second-floor' });
    let project: any = {
      id: 'visit-recovery', reference: 'KIT-VISIT-RECOVERY', customer_id: 'customer', customer: { id: 'customer', name: 'Synthetic visit recovery', phone: '9000000001' },
      version: 1, workflow_cycle: 1, stage: 'visit', status: 'Scheduled', lead: { status: 'Qualified', site_location: 'Synthetic site' },
      visit: { status: 'Scheduled', visit_date: '2026-10-27', display_model: null, notes: null },
      cad: { received: false, progress: 0, ready: false, status: 'Not Started', notes: null },
      assignments: {}, activity: [], attachments: [], design_versions: [], quotation_versions: [], orders: [], approvals: [], exceptions: [], blocked_transitions: [],
      permissions: { can_update: true, can_assign: true, can_approve_exceptions: true },
    };
    const writes: any[] = [];
    let confirmations = 0;
    await page.route('**/api/kitchen-projects**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      expect(request.headers()['x-floor-id']).toBe('second-floor');
      if (path.endsWith('/configuration')) return route.fulfill({ json: { version: 1, department_manager_user_ids: [], files: {} } });
      if (path.endsWith('/commands')) {
        const body = request.postDataJSON(); writes.push(body);
        if (body.expected_version !== project.version) return route.fulfill({ status: 409, json: { detail: 'Kitchen project changed; reload before saving' } });
        if (body.command === 'save_visit') {
          project = { ...project, version: project.version + 1, visit: { ...project.visit, ...body.payload } };
          return route.abort('failed'); // The write committed; only its response was lost.
        }
        expect(body.command).toBe('move_stage');
        expect(body.payload).toEqual({ target_stage: 'cad' });
        project = { ...project, version: project.version + 1, stage: 'cad' };
        return route.fulfill({ json: project });
      }
      if (path.endsWith('/visit-recovery')) {
        if (writes.some(body => body.command === 'save_visit')) confirmations++;
        return route.fulfill({ json: project });
      }
      return route.fulfill({ json: { rows: [], total: 0, page: 1, limit: 25 } });
    });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/kitchen/visit-recovery/stages/visit');
    await expect(page.getByTestId('kitchen-project-ready')).toBeAttached();
    if (mode === 'manual') await page.getByTestId('kitchen-visit-status-visited').click();
    await page.getByTestId('kitchen-visit-notes').fill('Saved visit notes must survive a lost response');
    if (mode === 'manual') await page.getByTestId('kitchen-visit-save').click();
    if (mode === 'next') await page.getByTestId('kitchen-advance-cad').click();
    else await expect(page.getByTestId('kitchen-visit-autosave')).toHaveText('Details saved');
    await expect(page.getByText('Could not save', { exact: true })).toHaveCount(0);
    if (mode !== 'next') await page.getByTestId('kitchen-advance-cad').click();
    await expect(page).toHaveURL(/\/stages\/cad(?:\?|$)/);
    expect(writes.map(body => body.command)).toEqual(['save_visit', 'move_stage']);
    expect(writes[1].expected_version).toBe(2);
    expect(project.visit.notes).toBe('Saved visit notes must survive a lost response');
    expect(project.version).toBe(3);
    expect(confirmations).toBe(1);
    expect(errors).toEqual([]);
  });
}
