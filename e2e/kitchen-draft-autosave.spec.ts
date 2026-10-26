import { projectControl } from './kitchen-controls';
import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
const headers = { 'X-Floor-Id': 'second-floor' };
async function open(page: Page, id: string) {
  await page.addInitScript(() => {
    localStorage.setItem('forge.jwt.kind', JSON.stringify('staff'));
    localStorage.setItem('forge.active-floor', JSON.stringify('second-floor'));
  });
  await page.goto(`/kitchen/${id}/stages/lead`);
  await expect(page.getByTestId('kitchen-project-ready')).toBeAttached();
}
test('Routine lead details autosave, remain focusable and reload without submitting Lost status', async ({ page, context }) => {
  const created = await context.request.post('/api/kitchen-projects', { headers, data: {
    customer_id: process.env.KITCHEN_E2E_CUSTOMER_ID, idempotency_key: randomUUID(), lead: { site_location: 'Draft acceptance site' },
  } });
  expect(created.ok(), await created.text()).toBe(true);
  const project = await created.json();
  await open(page, project.id);
  await page.getByTestId('kitchen-lead-details-toggle').click();
  const notes = page.getByTestId('kitchen-lead-notes');
  await notes.fill('Routine note');
  await notes.pressSequentially(' with the latest details');
  await expect(page.getByTestId('kitchen-lead-autosave')).toHaveText('Details saved');
  await expect(notes).toBeFocused();
  const persisted = await context.request.get(`/api/kitchen-projects/${project.id}`, { headers });
  expect((await persisted.json()).lead.notes).toBe('Routine note with the latest details');
  await page.reload();
  await expect(notes).toHaveValue('Routine note with the latest details');
  await page.getByTestId('kitchen-lead-status-lost').click();
  await page.getByTestId('kitchen-lead-lost-reason').fill('Draft decision still needs explicit save');
  await expect(page.getByTestId('kitchen-lead-autosave')).toContainText('Unsaved');
  await page.waitForTimeout(900); // Beyond the debounce: negative assertion for a consequential draft.
  const unchanged = await context.request.get(`/api/kitchen-projects/${project.id}`, { headers });
  expect((await unchanged.json()).lead.status).toBe('New');
  await (await projectControl(page, 'kitchen-project-actions')).click();
  await page.getByRole('menuitem', { name: 'Stage history', exact: true }).click();
  await page.getByTestId('kitchen-stage-visit').click();
  await (await projectControl(page, 'kitchen-project-actions')).click();
  await page.getByRole('menuitem', { name: 'Stage history', exact: true }).click();
  await page.getByTestId('kitchen-stage-lead').click();
  await expect(page.getByTestId('kitchen-lead-lost-reason')).toHaveValue('Draft decision still needs explicit save');
});
test('Reloading newer lead data retains the local draft and stops autosave until review', async ({ page, context }) => {
  const created = await context.request.post('/api/kitchen-projects', { headers, data: {
    customer_id: process.env.KITCHEN_E2E_CUSTOMER_ID, idempotency_key: randomUUID(), lead: { site_location: 'Original saved location' },
  } });
  const project = await created.json();
  await open(page, project.id);
  await page.getByTestId('kitchen-lead-site_location').fill(''); // Invalid local draft must not autosave.
  const changed = await context.request.post(`/api/kitchen-projects/${project.id}/commands`, { headers, data: {
    expected_version: project.version, idempotency_key: randomUUID(), command: 'edit_lead', payload: { site_location: 'Newer server location' },
  } });
  expect(changed.ok(), await changed.text()).toBe(true);
  await (await projectControl(page, 'kitchen-project-actions')).click();
  await page.getByRole('menuitem', { name: 'Reload saved project', exact: true }).click();
  await expect(page.getByTestId('kitchen-lead-draft-reload')).toBeVisible();
  await expect(page.getByTestId('kitchen-lead-site_location')).toHaveValue('');
  await page.getByTestId('kitchen-lead-site_location').fill('Retained entry for review');
  await page.waitForTimeout(900);
  const persisted = await context.request.get(`/api/kitchen-projects/${project.id}`, { headers });
  expect((await persisted.json()).lead.site_location).toBe('Newer server location');
  await page.getByTestId('kitchen-lead-draft-reload').click();
  await expect(page.getByTestId('kitchen-lead-site_location')).toHaveValue('Newer server location');
  await page.getByTestId('kitchen-lead-site_location').fill('Reviewed new entry');
  await expect(page.getByTestId('kitchen-lead-autosave')).toHaveText('Details saved');
});
