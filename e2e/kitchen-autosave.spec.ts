import { openProjectTool } from './kitchen-controls';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { captureRuntimeHealth } from './runtime-health';

const headers = { 'X-Floor-Id': 'second-floor' };
async function command(api: APIRequestContext, project: any, name: string, payload: object) {
  const response = await api.post(`/api/kitchen-projects/${project.id}/commands`, { headers, data: {
    expected_version: project.version, idempotency_key: randomUUID(), command: name, payload,
  } });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function confirmedOrder(api: APIRequestContext) {
  const response = await api.post('/api/kitchen-projects', { headers, data: {
    customer_id: process.env.KITCHEN_E2E_CUSTOMER_ID, idempotency_key: randomUUID(),
    lead: { site_location: 'Synthetic ordinary order autosave acceptance' },
  } });
  expect(response.ok(), await response.text()).toBe(true);
  let project = await response.json();
  for (const target_stage of ['visit', 'cad', 'design']) project = await command(api, project, 'move_stage', { target_stage });
  project = await command(api, project, 'design_present', { presentation_date: '2026-10-26' });
  const designId = project.design_versions.at(-1).id;
  project = await command(api, project, 'design_share', { version_id: designId, date: '2026-10-26' });
  project = await command(api, project, 'design_response', { version_id: designId, response: 'Approved', approval_date: '2026-10-26' });
  project = await command(api, project, 'design_handoff', { version_id: designId, date: '2026-10-26' });
  project = await command(api, project, 'move_stage', { target_stage: 'quotation' });
  project = await command(api, project, 'quotation_receive', { design_version_id: designId, amount: '1000', received_date: '2026-10-26' });
  const quotationId = project.quotation_versions.at(-1).id;
  project = await command(api, project, 'quotation_share', { version_id: quotationId, date: '2026-10-26' });
  project = await command(api, project, 'quotation_response', { version_id: quotationId, response: 'Approved' });
  project = await command(api, project, 'move_stage', { target_stage: 'order' });
  return command(api, project, 'order_confirm', { quotation_version_id: quotationId, order_date: '2026-10-26', final_amount: '1000', notes: 'Initial internal note' });
}
async function open(page: Page, project: any) {
  await page.addInitScript(() => {
    localStorage.setItem('forge.jwt.kind', JSON.stringify('staff'));
    localStorage.setItem('forge.active-floor', JSON.stringify('second-floor'));
  });
  await page.goto(`/kitchen/${project.id}/stages/order`);
  await expect(page.getByTestId('kitchen-project-ready')).toBeAttached();
}
async function savedOrder(api: APIRequestContext, id: string) {
  const response = await api.get(`/api/kitchen-projects/${id}`, { headers });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).orders.at(-1);
}

test('Confirmed order, advance and amendment calendars default blank dates without submitting money changes', async ({ page, context }) => {
  const project = await confirmedOrder(context.request);
  await open(page, project);
  const writes: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/commands')) writes.push(request.postDataJSON().command);
  });
  const today = await page.evaluate(() => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10));
  // Opening a saved date preserves history; clearing and reopening explicitly chooses today.
  const date = page.getByTestId('kitchen-order-edit-date');
  await date.focus();
  await expect(date).toHaveValue('2026-10-26');
  for (const [disclosure, id] of [['advance', 'kitchen-advance-date'], ['amendment', 'kitchen-amend-date']]) {
    await openProjectTool(page, disclosure as 'advance' | 'amendment');
    const field = page.getByTestId(id);
    await expect(field).toHaveValue(today); // selected before any click or focus
    await field.fill('');
    await field.blur();
    await field.focus();
    await expect(field).toHaveValue(today);
    await field.fill('2026-10-27');
    await field.blur();
    await field.focus();
    await expect(field).toHaveValue('2026-10-27');
  }
  await page.waitForTimeout(900);
  expect(writes).toEqual([]);
  const saved = await savedOrder(context.request, project.id);
  expect(saved.final_amount).toBe('1000.00');
  expect(saved.advance.received).toBe(false);
});

test('Slow order autosave keeps focus and newer typing, then reloads the newest persisted value', async ({ page, context }, info) => {
  const project = await confirmedOrder(context.request);
  const health = captureRuntimeHealth(page);
  await open(page, project);
  for (const name of ['order-confirmation', 'order-status']) {
    await expect(page.getByTestId(`kitchen-disclose-${name}`)).toHaveAttribute('aria-expanded', 'false');
  }
  await expect(page.getByTestId('kitchen-disclose-order-details')).toHaveCount(0);
  await expect(page.getByTestId('kitchen-order-details')).toHaveCount(0);
  await expect(page.getByText('Approved final amount:', { exact: false })).toHaveCount(1);
  await expect(page.getByTestId('kitchen-amend-save')).toHaveCount(0);
  await expect(page.getByTestId('kitchen-advance-save')).toHaveCount(0);
  await expect(page.getByTestId('kitchen-order-edit-notes')).toBeVisible();
  const writes: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/commands')) writes.push(request.postDataJSON().command);
  });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let intercepted = false;
  await page.route('**/commands', async route => {
    if (!intercepted && route.request().postDataJSON()?.command === 'order_update') {
      intercepted = true;
      const response = await route.fetch();
      await gate;
      await route.fulfill({ response });
    } else await route.continue();
  });
  await page.getByTestId('kitchen-disclose-order-confirmation').click();
  const field = page.getByTestId('kitchen-order-edit-notes');
  try {
    await field.fill('First note while the save is delayed');
    await expect.poll(() => intercepted).toBe(true);
    await expect(field).toBeEditable();
    await expect(field).toBeFocused();
    await expect(page.getByTestId('kitchen-order-confirmation-save')).toBeDisabled();
    await field.fill('Newest note typed while the previous response was pending');
    await expect(field).toBeFocused();
    release();
    await expect(page.getByTestId('kitchen-order-autosave')).toHaveText('Order details saved');
    await expect.poll(async () => (await savedOrder(context.request, project.id)).notes).toBe('Newest note typed while the previous response was pending');
    expect(writes).toEqual(['order_update', 'order_update']);
    await page.reload();
    await expect(field).toHaveValue('Newest note typed while the previous response was pending');
    await page.screenshot({ path: info.outputPath('order-compact-autosaved.png'), fullPage: true });
    await health.assertHealthy();
  } finally { release(); }
});

test('Offline order autosave retains entries, reports failure and retries explicitly without financial writes', async ({ page, context }) => {
  const project = await confirmedOrder(context.request);
  const health = captureRuntimeHealth(page);
  await open(page, project);
  const writes: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/commands')) writes.push(request.postDataJSON().command);
  });
  const field = page.getByTestId('kitchen-order-edit-notes');
  await context.setOffline(true);
  await field.fill('Offline draft stays available until a confirmed save');
  await expect(page.getByTestId('kitchen-order-autosave-retry')).toBeVisible();
  await expect(field).toHaveValue('Offline draft stays available until a confirmed save');
  await expect(page.getByTestId('kitchen-order-autosave')).toContainText('could not be saved');
  await context.setOffline(false);
  expect((await savedOrder(context.request, project.id)).notes).toBe('Initial internal note');
  const saved = page.waitForResponse(response => response.url().endsWith('/commands') && response.request().postDataJSON()?.command === 'order_update');
  await page.getByTestId('kitchen-order-autosave-retry').click();
  expect((await saved).ok()).toBe(true);
  await expect(page.getByTestId('kitchen-order-autosave')).toHaveText('Order details saved');
  expect(writes.length).toBeGreaterThanOrEqual(2);
  expect(writes.every(name => name === 'order_update')).toBe(true);
  await page.reload();
  await expect(field).toHaveValue('Offline draft stays available until a confirmed save');
  const order = await savedOrder(context.request, project.id);
  expect(order.final_amount).toBe('1000.00');
  expect(order.advance.received).toBe(false);
  expect(order.amendments).toEqual([]);
  await health.assertHealthy();
});

test('Invalid order chronology stays unsaved and a corrected draft can save', async ({ page, context }) => {
  const project = await confirmedOrder(context.request);
  const health = captureRuntimeHealth(page);
  await open(page, project);
  const field = page.getByTestId('kitchen-order-edit-date');
  await field.fill('2026-10-20');
  await expect(page.getByTestId('kitchen-order-autosave-retry')).toBeVisible();
  await expect(field).toHaveValue('2026-10-20');
  expect((await savedOrder(context.request, project.id)).order_date).toBe('2026-10-26');
  await field.fill('2026-10-26');
  await page.getByTestId('kitchen-order-edit-notes').fill('Corrected date with retained internal details');
  await expect(page.getByTestId('kitchen-order-autosave')).toHaveText('Order details saved');
  expect((await savedOrder(context.request, project.id)).notes).toBe('Corrected date with retained internal details');
  await health.assertHealthy();
});
