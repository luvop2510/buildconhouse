import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
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

async function projectAt(context: APIRequestContext, stage: string) {
  const created = await context.post('/api/kitchen-projects', { headers, data: {
    customer_id: process.env.KITCHEN_E2E_CUSTOMER_ID, idempotency_key: randomUUID(), lead: { site_location: 'Commercial recovery acceptance' },
  } });
  expect(created.ok(), await created.text()).toBe(true);
  let project = await created.json();
  if (stage === 'lead') return project;
  for (const target of ['visit', 'cad', 'design', 'quotation', 'order', 'production', 'installation']) {
    const moved = await context.post(`/api/kitchen-projects/${project.id}/commands`, { headers, data: {
      expected_version: project.version, idempotency_key: randomUUID(), command: 'move_stage', payload: { target_stage: target },
    } });
    expect(moved.ok(), await moved.text()).toBe(true);
    project = await moved.json();
    if (target === stage) return project;
  }
  throw new Error(`Unsupported acceptance stage ${stage}`);
}

async function clickCommand(page: Page, id: string, command: string) {
  const pending = page.waitForResponse(response => response.url().endsWith('/commands') && response.request().postDataJSON()?.command === command);
  await page.getByTestId(id).click();
  const response = await pending;
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

test('Kitchen every stage separates its saved details into bordered label and value fields', async ({ page, context }, info) => {
  const project = await projectAt(context.request, 'lead');
  await seed(page);
  await page.goto(`/kitchen/${project.id}/stages/lead`);
  for (const stage of ['lead', 'visit', 'cad', 'design', 'quotation', 'order', 'production', 'installation', 'completed']) {
    await page.getByTestId(`kitchen-progress-${stage}`).click();
    const details = page.getByTestId(`kitchen-${stage}-details`);
    await expect(details).toBeVisible();
    const fields = await details.evaluate(element => Array.from(element.children).map(field => ({
      border: getComputedStyle(field).borderTopWidth, text: field.textContent,
      width: field.getBoundingClientRect().width, height: field.getBoundingClientRect().height,
    })));
    expect(fields.length).toBeGreaterThanOrEqual(3);
    for (const field of fields) {
      expect(field.border, `${stage}: each detail has its own outline`).toBe('1px');
      expect(field.text).toContain(':');
      expect(field.width).toBeGreaterThan(80);
      expect(field.height).toBeGreaterThan(40);
    }
    const status = page.getByTestId('kitchen-save-status');
    expect(await status.evaluate(element => getComputedStyle(element).borderTopWidth)).toBe('1px');
    if (stage === 'order') {
      await expect(details.getByText('Customer order confirmation: No', { exact: true })).toBeVisible();
      await expect(details.getByText('Order status: Pending', { exact: true })).toBeVisible();
      await expect(details.getByText('Current approved quotation: None', { exact: true })).toBeVisible();
      await details.scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath('order-separate-details.png') });
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
});

test('Kitchen missing quotation and order prerequisites offer working return actions and retain entry', async ({ page, context }, info) => {
  const project = await projectAt(context.request, 'quotation');
  const health = captureRuntimeHealth(page);
  await seed(page);
  await page.goto(`/kitchen/${project.id}/stages/quotation`);
  await expect(page.getByTestId('kitchen-quotation-receive')).toBeDisabled();
  await expect(page.getByText('Record a design presentation in Design first.', { exact: true })).toBeVisible();
  await page.getByTestId('kitchen-quotation-amount').fill('1250.50');
  await page.getByTestId('kitchen-quotation-receive').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('quotation-prerequisites.png') });
  const design = await clickCommand(page, 'kitchen-complete-design', 'move_stage');
  expect(design.stage).toBe('design');
  await expect(page).toHaveURL(new RegExp(`/stages/design(?:\\?.*)?$`));
  await clickCommand(page, 'kitchen-advance-quotation', 'move_stage');
  await expect(page.getByTestId('kitchen-quotation-amount')).toHaveValue('1250.50');
  await clickCommand(page, 'kitchen-advance-order', 'move_stage');
  await expect(page.getByTestId('kitchen-order-confirm')).toBeDisabled();
  await expect(page.getByText('Order status: Pending', { exact: true })).toBeVisible();
  await page.getByTestId('kitchen-order-confirm').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('order-pending-confirmation.png') });
  const quotation = await clickCommand(page, 'kitchen-complete-quotation', 'move_stage');
  expect(quotation.stage).toBe('quotation');
  await expect(page.getByTestId('kitchen-quotation-amount')).toHaveValue('1250.50');
  await page.getByTestId('kitchen-quotation-upload').click();
  await expect(page.getByTestId('kitchen-document-pick')).toBeEnabled();
  await health.assertHealthy();
});

test('Kitchen save and next persists production, actual site visit and installation in one journey', async ({ page, context }, info) => {
  const project = await projectAt(context.request, 'production');
  const health = captureRuntimeHealth(page);
  await seed(page);
  await page.goto(`/kitchen/${project.id}/stages/production`);
  await page.getByTestId('kitchen-production-status-completed').click();
  await page.getByTestId('kitchen-production-start').fill('2026-10-25');
  await page.getByTestId('kitchen-production-complete').fill('2026-10-26');
  await clickCommand(page, 'kitchen-production-save-next', 'move_stage');
  await expect(page).toHaveURL(new RegExp(`/stages/installation(?:\\?.*)?$`));
  const afterProduction = await context.request.get(`/api/kitchen-projects/${project.id}`, { headers });
  expect(await afterProduction.json()).toMatchObject({ stage: 'installation', production: { status: 'Completed', start_date: '2026-10-25', completion_date: '2026-10-26' } });
  await page.reload();
  await page.getByTestId('kitchen-disclose-site-visit').click();
  await expect(page.getByTestId('kitchen-site-save')).toBeDisabled();
  await expect(page.getByText('Choose whether this visit actually took place to enable recording.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Visit actually took place: Yes — actual visit', exact: true }).click();
  await page.getByTestId('kitchen-site-date').fill('2026-10-26');
  const visit = await clickCommand(page, 'kitchen-site-save', 'site_visit');
  expect(visit.site_visit_count).toBe(1);
  await page.getByTestId('kitchen-installation-status-completed').click();
  await page.getByTestId('kitchen-installation-start').fill('2026-10-26');
  await page.getByTestId('kitchen-installation-complete').fill('2026-10-26');
  await clickCommand(page, 'kitchen-installation-save-next', 'move_stage');
  await expect(page).toHaveURL(new RegExp(`/stages/completed(?:\\?.*)?$`));
  await page.reload();
  await expect(page.getByText('Actual site visits: 1', { exact: true })).toBeVisible();
  const completed = await context.request.get(`/api/kitchen-projects/${project.id}`, { headers });
  expect(await completed.json()).toMatchObject({ stage: 'completed', site_visit_count: 1, installation: { status: 'Completed', start_date: '2026-10-26', completion_date: '2026-10-26' } });
  await page.screenshot({ path: info.outputPath('saved-work-and-site-visit.png') });
  await health.assertHealthy();
});

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
  expect(query.get('assignee')).toBe('unassigned');
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
