import { projectControl, openProjectTool } from './kitchen-controls';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const headers = { 'X-Floor-Id': 'second-floor' };
async function command(api: APIRequestContext, project: any, name: string, payload: object) {
  const response = await api.post(`/api/kitchen-projects/${project.id}/commands`, { headers, data: {
    expected_version: project.version, idempotency_key: randomUUID(), command: name, payload,
  } });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function open(page: Page, id: string, stage: string) {
  await page.goto(`/kitchen/${id}/stages/${stage}`);
  await expect(page.getByTestId('kitchen-project-ready')).toBeAttached();
}
async function todayDefault(page: Page, id: string) {
  const field = page.getByTestId(id);
  const today = await page.evaluate(() => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10));
  await expect(field).toHaveValue(today); // No focus, click or keyboard input is needed.
  await expect(field).toHaveAttribute('type', 'date');
  await expect(page.getByTestId(`${id}-calendar`)).toBeVisible();
  // Empty an editable field and explicitly reopen it, including already-focused calendars.
  await field.fill('');
  await expect(field).toHaveValue('');
  await field.blur();
  await field.focus();
  await expect(field).toHaveValue(today);
  await field.fill('2026-10-24');
  await field.blur();
  await field.focus();
  await expect(field).toHaveValue('2026-10-24');
}

test('Every Kitchen date entry point chooses India today when blank and preserves an edited choice', async ({ page, context }) => {
  page.on('dialog', dialog => { void dialog.accept(); }); // Intentional navigation discards the unsaved test-only decisions.
  await page.addInitScript(() => {
    localStorage.setItem('forge.jwt.kind', JSON.stringify('staff'));
    localStorage.setItem('forge.active-floor', JSON.stringify('second-floor'));
  });
  const created = await context.request.post('/api/kitchen-projects', { headers, data: {
    customer_id: process.env.KITCHEN_E2E_CUSTOMER_ID, idempotency_key: randomUUID(), lead: { site_location: 'Synthetic date defaults acceptance' },
  } });
  expect(created.ok(), await created.text()).toBe(true);
  let project = await created.json();
  await open(page, project.id, 'lead');
  await todayDefault(page, 'kitchen-lead-date');
  await expect(page.getByTestId('kitchen-lead-autosave')).toHaveText('Details saved');
  await page.reload();
  await expect(page.getByTestId('kitchen-lead-date')).toHaveValue('2026-10-24');
  await (await projectControl(page, 'kitchen-project-actions')).click();
  await page.getByRole('menuitem', { name: 'Completion date', exact: true }).click();
  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  await expect(page.getByTestId('kitchen-target-date')).toHaveValue(today);
  await expect(page.getByText('Completion date saved', { exact: true })).toBeVisible();
  const targetSaved = await context.request.get(`/api/kitchen-projects/${project.id}`, { headers });
  expect((await targetSaved.json()).target_completion_date).toBe(today); // No click/focus/edit required.
  await todayDefault(page, 'kitchen-target-date');
  await expect(page.getByText('Completion date saved', { exact: true })).toBeVisible();
  // Reload outside the UI to follow the latest optimistic version after routine autosaves.
  project = await (await context.request.get(`/api/kitchen-projects/${project.id}`, { headers })).json();
  for (const target_stage of ['visit', 'cad', 'design', 'quotation', 'order', 'production', 'installation']) {
    project = await command(context.request, project, 'move_stage', { target_stage });
    await open(page, project.id, target_stage);
    if (target_stage === 'visit') {
      await todayDefault(page, 'kitchen-visit-date');
      await expect(page.getByTestId('kitchen-visit-autosave')).toHaveText('Details saved');
    } else if (target_stage === 'design') {
      await todayDefault(page, 'kitchen-design-edit-shared');
      await page.getByTestId('kitchen-design-edit-response-approved').click();
      await todayDefault(page, 'kitchen-design-edit-approval-date');
      await page.getByTestId('kitchen-design-sent-yes').click();
      await todayDefault(page, 'kitchen-design-edit-handoff');
    } else if (target_stage === 'quotation') {
      await todayDefault(page, 'kitchen-quotation-date');
      await todayDefault(page, 'kitchen-quotation-shared-date');
    } else if (target_stage === 'order') {
      await todayDefault(page, 'kitchen-order-date');
      await openProjectTool(page, 'advance');
      await todayDefault(page, 'kitchen-advance-date');
    } else if (target_stage === 'production' || target_stage === 'installation') {
      await todayDefault(page, `kitchen-${target_stage}-start`);
      await todayDefault(page, `kitchen-${target_stage}-complete`);
      if (target_stage === 'installation') {
        await openProjectTool(page, 'site-visit');
        await todayDefault(page, 'kitchen-site-date');
      }
    }
    project = await (await context.request.get(`/api/kitchen-projects/${project.id}`, { headers })).json();
  }
  // No date focus may create financial orders, approvals, site visits or completed work.
  expect(project.orders).toHaveLength(0);
  expect(project.design_versions).toHaveLength(0);
  expect(project.site_visit_count).toBe(0);
  expect(project.production).toBeUndefined();
  expect(project.installation).toBeUndefined();
  await page.goto('/kitchen/stages/lead');
  await expect(page.getByTestId('kitchen-filters-open')).toHaveCount(0);
  await expect(page.getByTestId('kitchen-date-from')).toHaveCount(0);
  await expect(page.getByTestId('kitchen-date-to')).toHaveCount(0);
});

test('Production and Installation select both dates on load without interaction and keep removed sections off the task', async ({ page, context }) => {
  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  await page.addInitScript(() => {
    localStorage.setItem('forge.jwt.kind', JSON.stringify('staff'));
    localStorage.setItem('forge.active-floor', JSON.stringify('second-floor'));
  });
  const response = await context.request.post('/api/kitchen-projects', { headers, data: {
    customer_id: process.env.KITCHEN_E2E_CUSTOMER_ID, idempotency_key: randomUUID(), lead: { site_location: 'Automatic two-date acceptance' },
  } });
  expect(response.ok(), await response.text()).toBe(true);
  let project = await response.json();
  for (const target_stage of ['visit','cad','design','quotation','order']) project = await command(context.request, project, 'move_stage', { target_stage });
  await open(page, project.id, 'order');
  for (const id of ['kitchen-disclose-advance','kitchen-disclose-amendment','kitchen-advance-details']) await expect(page.getByTestId(id)).toHaveCount(0);
  await expect(page.getByTestId('kitchen-current-task-region')).not.toContainText('Advance payment');
  await expect(page.getByTestId('kitchen-current-task-region')).not.toContainText('Amend approved amount');
  for (const stage of ['production','installation']) {
    project = await command(context.request, project, 'move_stage', { target_stage: stage });
    await open(page, project.id, stage);
    // Neither date is focused, clicked, filled or changed before these assertions.
    await expect(page.getByTestId(`kitchen-${stage}-start`)).toHaveValue(today);
    await expect(page.getByTestId(`kitchen-${stage}-complete`)).toHaveValue(today);
    await expect(page.getByTestId('kitchen-disclose-site-visit')).toHaveCount(0);
    await expect(page.getByTestId('kitchen-site-save')).toHaveCount(0);
    await expect(page.getByTestId('kitchen-current-task-region')).not.toContainText('Installation site visits');
    const beforeSave = await (await context.request.get(`/api/kitchen-projects/${project.id}`, { headers })).json();
    expect(beforeSave[stage]).toBeUndefined(); // Defaults alone never record work.
    for (const status of ['not-started', stage === 'production' ? 'in-production' : 'in-progress']) {
      await page.getByTestId(`kitchen-${stage}-status-${status}`).click();
      const response = page.waitForResponse(r => r.url().endsWith('/commands') && r.request().postDataJSON()?.command === `${stage}_update`);
      await page.getByTestId(`kitchen-${stage}-save`).click();
      const accepted = await response;
      expect(accepted.ok(), await accepted.text()).toBe(true);
      const record = (await accepted.json())[stage];
      expect(record.start_date).toBe(status === 'not-started' ? null : today);
      expect(record.completion_date).toBeNull();
      await page.reload();
      await expect(page.getByTestId(`kitchen-${stage}-start`)).toHaveValue(today);
      await expect(page.getByTestId(`kitchen-${stage}-complete`)).toHaveValue(today);
    }
    const start = stage === 'production' ? '2026-10-22' : '2026-10-24';
    const complete = stage === 'production' ? '2026-10-23' : '2026-10-25';
    await page.getByTestId(`kitchen-${stage}-status-completed`).click();
    await page.getByTestId(`kitchen-${stage}-start`).fill(start);
    await page.getByTestId(`kitchen-${stage}-complete`).fill(complete);
    const saved = page.waitForResponse(r => r.url().endsWith('/commands') && r.request().postDataJSON()?.command === `${stage}_update`);
    await page.getByTestId(`kitchen-${stage}-save`).click();
    expect((await saved).ok()).toBe(true);
    await page.reload();
    await expect(page.getByTestId(`kitchen-${stage}-start`)).toHaveValue(start);
    await expect(page.getByTestId(`kitchen-${stage}-complete`)).toHaveValue(complete);
    project = await (await context.request.get(`/api/kitchen-projects/${project.id}`, { headers })).json();
  }
});
