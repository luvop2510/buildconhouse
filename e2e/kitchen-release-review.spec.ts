import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { captureRuntimeHealth } from './runtime-health';

const headers = { 'X-Floor-Id': 'second-floor' };
function contrast(first: string, second: string) {
  const luminance = (color: string) => (color.match(/[\d.]+/g) || []).slice(0, 3)
    .map(value => Number(value) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
async function seed(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('forge.jwt.kind', JSON.stringify('staff'));
    localStorage.setItem('forge.active-floor', JSON.stringify('second-floor'));
  });
}

test('Retired Kitchen filters cannot hide a project and controls stay removed', async ({ page, context }, info) => {
  const created = await context.request.post('/api/kitchen-projects', { headers, data: {
    customer_id: process.env.KITCHEN_E2E_CUSTOMER_ID, idempotency_key: randomUUID(),
    lead: { site_location: 'Kitchen review site' },
  } });
  expect(created.ok(), await created.text()).toBe(true);
  const project = await created.json();
  const health = captureRuntimeHealth(page);
  await seed(page);
  const response = page.waitForResponse(r => r.request().method() === 'GET' && new URL(r.url()).pathname === '/api/kitchen-projects');
  await page.goto(`/kitchen/stages/lead?search=${encodeURIComponent(project.reference)}&view=list&assignee=unassigned&attention=next_action_overdue&sort=next_action&date_field=deadline`);
  const read = await response;
  expect(read.ok(), await read.text()).toBe(true);
  const query = new URL(read.url()).searchParams;
  expect(query.has('assignee')).toBe(false);
  expect(query.get('attention')).not.toBe('next_action_overdue');
  expect(query.get('sort')).not.toBe('next_action');
  expect(query.get('date_field')).not.toBe('deadline');
  await expect(page.getByTestId(`kitchen-project-${project.id}`)).toBeVisible();
  await expect(page.getByTestId(`kitchen-project-${project.id}`)).not.toContainText('Unassigned');
  await expect(page.getByTestId(`kitchen-project-${project.id}`)).not.toContainText('next action');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('kitchen-queue-review.png'), fullPage: true });
  await page.getByTestId('kitchen-filters-open').click();
  await expect(page.getByText('Assigned person', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Next action deadline', { exact: true })).toHaveCount(0);
  await page.getByTestId('kitchen-filters-apply').click();
  await page.getByTestId(`kitchen-project-${project.id}`).click();
  await expect(page.getByTestId('kitchen-current-task-region')).toBeVisible();
  await expect(page.getByTestId('kitchen-assign-save')).toHaveCount(0);
  await expect(page.getByTestId('kitchen-meta-next-action')).toHaveCount(0);
  await health.assertHealthy();
});

test('Kitchen lead intake retains entries, fits its panel and creates without assignment', async ({ page, context }, info) => {
  const health = captureRuntimeHealth(page);
  await seed(page);
  await page.goto('/kitchen/stages/lead');
  await page.getByTestId('kitchen-create').click();
  const phone = `9${String(Date.now() + Math.floor(Math.random() * 1000000)).slice(-9)}`;
  const customer = `Kitchen layout review ${info.project.name}`;
  const restingInput = await page.getByTestId('kitchen-customer-name').boundingBox();
  const fieldColors = await page.getByTestId('kitchen-customer-name').evaluate(element => {
    const container = getComputedStyle(element.parentElement!);
    return { border: container.borderTopColor, background: container.backgroundColor, text: getComputedStyle(element).color };
  });
  expect(contrast(fieldColors.border, fieldColors.background)).toBeGreaterThanOrEqual(3);
  expect(contrast(fieldColors.text, fieldColors.background)).toBeGreaterThanOrEqual(4.5);
  expect(restingInput!.height).toBeGreaterThanOrEqual(44);
  const nameInput = page.getByTestId('kitchen-customer-name');
  await nameInput.fill(customer);
  const beforeEnter = await nameInput.boundingBox();
  await nameInput.press('Enter');
  await expect(nameInput).toBeFocused();
  await expect(nameInput).toHaveValue(customer);
  const afterEnter = await nameInput.boundingBox();
  expect(Math.abs(afterEnter!.y - beforeEnter!.y)).toBeLessThan(2);
  const focusedInput = await nameInput.boundingBox();
  expect(focusedInput!.width).toBeCloseTo(restingInput!.width, 0);
  expect(focusedInput!.height).toBeCloseTo(restingInput!.height, 0);
  await page.getByTestId('kitchen-customer-phone').fill(phone);
  await page.getByTestId('kitchen-create-lead-site_location').fill('A long site location that should wrap without changing any other controls');
  const before = await page.getByTestId('kitchen-customer-name').inputValue();
  const viewport = page.viewportSize()!;
  await page.setViewportSize({ width: viewport.width, height: Math.max(550, viewport.height - 180) });
  await expect(page.getByTestId('kitchen-customer-name')).toHaveValue(before);
  await expect(page.getByText('Assigned person', { exact: true })).toHaveCount(0);
  const bounds = await page.getByTestId('kitchen-create-sheet').boundingBox();
  const name = await page.getByTestId('kitchen-customer-name').boundingBox();
  expect(name!.x).toBeGreaterThanOrEqual(bounds!.x + 16);
  expect(name!.x + name!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width - 16);
  await page.getByTestId('kitchen-create-submit').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('kitchen-create-review.png') });
  const saved = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/kitchen-projects');
  await page.getByTestId('kitchen-create-submit').click();
  const response = await saved;
  expect(response.ok(), await response.text()).toBe(true);
  expect(response.request().postDataJSON()).not.toHaveProperty('assigned_to');
  const project = await response.json();
  const independent = await context.request.get(`/api/kitchen-projects/${project.id}`, { headers });
  expect(await independent.json()).toMatchObject({ customer: { name: customer, phone }, lead: { site_location: 'A long site location that should wrap without changing any other controls' } });
  await expect(page.getByTestId('kitchen-current-task-region')).toBeVisible();
  await page.screenshot({ path: info.outputPath('kitchen-project-review.png'), fullPage: true });
  await health.assertHealthy();
});

test('Kitchen task controls remain reachable at 200 percent text with reduced motion', async ({ page, context }, info) => {
  const created = await context.request.post('/api/kitchen-projects', { headers, data: {
    customer_id: process.env.KITCHEN_E2E_CUSTOMER_ID, idempotency_key: randomUUID(),
    lead: { site_location: 'Kitchen expanded text review' },
  } });
  expect(created.ok(), await created.text()).toBe(true);
  const project = await created.json();
  await seed(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`/kitchen/${project.id}/stages/lead`);
  await expect(page.getByTestId('kitchen-current-task-region')).toBeVisible();
  // This verifies web text enlargement; physical native Dynamic Type is separate.
  await page.evaluate(() => {
    const values = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="kitchen-project-detail"] *'))
      .map(element => ({ element, font: parseFloat(getComputedStyle(element).fontSize), line: parseFloat(getComputedStyle(element).lineHeight) }));
    for (const { element, font, line } of values) {
      element.style.fontSize = `${font * 2}px`;
      if (Number.isFinite(line)) element.style.lineHeight = `${line * 2}px`;
    }
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.getByTestId('kitchen-lead-save').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('kitchen-lead-save')).toBeInViewport();
  const calendar = await page.getByTestId('kitchen-lead-date').boundingBox();
  expect(calendar!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: info.outputPath('kitchen-expanded-text-review.png') });
});
