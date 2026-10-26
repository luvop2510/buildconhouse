import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { captureRuntimeHealth } from './runtime-health';

const headers = { 'X-Floor-Id': 'second-floor' };
async function projectAt(context: APIRequestContext, stage: 'production' | 'installation') {
  const created = await context.post('/api/kitchen-projects', { headers, data: {
    customer_id: process.env.KITCHEN_E2E_CUSTOMER_ID, idempotency_key: randomUUID(),
    lead: { site_location: 'Internal note growth acceptance' },
  } });
  expect(created.ok(), await created.text()).toBe(true);
  let project = await created.json();
  for (const target of ['visit', 'cad', 'design', 'quotation', 'order', 'production', 'installation']) {
    const response = await context.post(`/api/kitchen-projects/${project.id}/commands`, { headers, data: {
      expected_version: project.version, idempotency_key: randomUUID(), command: 'move_stage', payload: { target_stage: target },
    } });
    expect(response.ok(), await response.text()).toBe(true);
    project = await response.json();
    if (target === stage) return project;
  }
  throw new Error(`Unsupported note acceptance stage ${stage}`);
}
async function height(field: Locator) { return field.evaluate(element => element.getBoundingClientRect().height); }
async function readable(field: Locator) {
  const geometry = await field.evaluate(element => ({ height: element.clientHeight, scroll: element.scrollHeight,
    overflow: getComputedStyle(element).overflowY, max: parseFloat(getComputedStyle(element).maxHeight) }));
  expect(geometry.height).toBeGreaterThanOrEqual(44);
  expect(geometry.height).toBeLessThanOrEqual(321);
  if (geometry.scroll > geometry.height + 1) expect(geometry.overflow).toBe('auto');
}
async function save(page: Page, stage: string) {
  const response = page.waitForResponse(row => row.url().endsWith('/commands') && row.request().postDataJSON()?.command === `${stage}_update`);
  await page.getByTestId(`kitchen-${stage}-save`).click();
  const saved = await response;
  expect(saved.ok(), await saved.text()).toBe(true);
  return saved.json();
}
for (const stage of ['production', 'installation'] as const) {
  test(`Internal ${stage} notes grow, shrink, wrap and retain saved text after reload`, async ({ page, context }, info) => {
    const project = await projectAt(context.request, stage);
    const health = captureRuntimeHealth(page);
    await page.addInitScript(() => {
      localStorage.setItem('forge.jwt.kind', JSON.stringify('staff'));
      localStorage.setItem('forge.active-floor', JSON.stringify('second-floor'));
    });
    await page.goto(`/kitchen/${project.id}/stages/${stage}`);
    const field = page.getByTestId(`kitchen-${stage}-notes`);
    await expect(field).toBeVisible();
    await expect(field).toHaveAccessibleName('Internal notes');
    const baseline = await height(field);
    expect(baseline).toBeGreaterThanOrEqual(44);
    expect(baseline).toBeLessThanOrEqual(52);
    const writes: string[] = [];
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/commands')) writes.push(request.postDataJSON().command);
    });
    await field.fill('Check the cabinet alignment.');
    await expect.poll(() => height(field)).toBeLessThanOrEqual(52);
    await field.press('Enter');
    await expect(field).toBeFocused();
    await expect(field).toHaveValue('Check the cabinet alignment.\n');
    await field.fill('Inspect the cabinet alignment before fitting the hinges.\nKeep the protective film until the final inspection.\nRecord the remaining work here for the internal team.');
    await expect.poll(() => height(field)).toBeGreaterThan(baseline + 24);
    await readable(field);
    const wrapped = 'Check cabinet alignment, hinge positions and worktop clearance before the internal inspection. '.repeat(7).trim();
    await field.fill(wrapped);
    await page.setViewportSize({ width: 320, height: 740 });
    await expect.poll(() => height(field)).toBeGreaterThan(250);
    await readable(field);
    const narrow = await height(field);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect.poll(() => height(field)).toBeLessThan(narrow);
    expect(await height(field)).toBeLessThanOrEqual(321);
    await readable(field);
    await field.fill('');
    await expect.poll(() => height(field)).toBeLessThanOrEqual(52);
    expect(writes, 'Changing internal note text only changes its draft').toEqual([]);
    await field.fill(wrapped);
    const saved = await save(page, stage);
    expect(saved[stage].notes).toBe(wrapped);
    expect(writes).toEqual([`${stage}_update`]);
    await page.reload();
    await expect(field).toHaveValue(wrapped);
    await expect.poll(() => height(field)).toBeGreaterThan(baseline + 24);
    await readable(field);
    await field.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`${stage}-internal-notes.png`) });
    await health.assertHealthy();
  });
}
