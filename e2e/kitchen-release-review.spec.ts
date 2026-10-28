import { prepareKitchenFixtureTransition, uploadKitchenPdfInForm, kitchenIndiaToday } from './kitchen-pdf-fixtures';
import { projectControl, openProjectTool } from './kitchen-controls';
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
    project = await prepareKitchenFixtureTransition(context, project, target);
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
  await (await projectControl(page, id)).click();
  const response = await pending;
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

test('All nine stages open with a compact header and the task visible before expandable project details', async ({ page, context }, info) => {
  let project = await projectAt(context.request, 'lead');
  await seed(page);
  if (page.viewportSize()!.width < 768) await page.setViewportSize({ width: 320, height: 720 });
  for (const stage of ['lead', 'visit', 'cad', 'design', 'quotation', 'order', 'production', 'installation', 'completed']) {
    if (stage !== 'lead') {
      project = await prepareKitchenFixtureTransition(context.request, project, stage);
      const moved = await context.request.post(`/api/kitchen-projects/${project.id}/commands`, { headers, data: {
        expected_version: project.version, idempotency_key: randomUUID(), command: 'move_stage', payload: { target_stage: stage },
      } });
      expect(moved.ok(), await moved.text()).toBe(true);
      project = await moved.json();
    }
    await page.goto(`/kitchen/${project.id}/stages/${stage}`);
    await expect(page.getByTestId('kitchen-project-ready')).toBeAttached();
    const details = page.getByTestId('kitchen-project-details-toggle');
    await expect(details).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('kitchen-project-details')).toHaveCount(0);
    await expect(page.getByTestId('kitchen-stage-navigation')).toHaveCount(1);
    await expect(page.getByTestId('kitchen-project-stages').getByRole('link')).toHaveCount(9);
    await expect(page.getByTestId('kitchen-project-actions')).toBeVisible();
    const header = await page.getByTestId('kitchen-compact-header').boundingBox();
    expect(header!.height).toBeLessThanOrEqual(page.viewportSize()!.width < 768 ? 100 : 52);
    const heading = page.getByTestId('kitchen-compact-header').getByRole('heading');
    await expect(heading).toHaveText(stage === 'cad' ? 'CAD File' : stage[0].toUpperCase() + stage.slice(1));
    const titleFits = await heading.evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element);
      return range.getBoundingClientRect().width <= element.getBoundingClientRect().width + 1 && element.getBoundingClientRect().height <= parseFloat(getComputedStyle(element).lineHeight) + 1;
    });
    expect(titleFits, `${stage}: full title fits on one line`).toBe(true);
    for (const tab of await page.getByTestId('kitchen-project-stages').getByRole('link').all()) {
      expect(await tab.evaluate(element => {
        const text = element.firstElementChild!;
        const range = document.createRange(); range.selectNodeContents(text);
        return range.getBoundingClientRect().width <= text.getBoundingClientRect().width + 1 && text.getBoundingClientRect().height <= parseFloat(getComputedStyle(text).lineHeight) + 1;
      }), `${stage}: every stage label fits on one line`).toBe(true);
    }
    const task = await page.getByTestId('kitchen-current-task-region').boundingBox();
    expect(task!.y, `${stage}: the task follows compact stage navigation within the first viewport`).toBeLessThan(page.viewportSize()!.height);
    await page.screenshot({ path: info.outputPath(`compact-${stage}.png`) });
    await details.click();
    await expect(page.getByTestId('kitchen-project-details')).toContainText(project.customer.name);
    await expect(page.getByTestId('kitchen-project-details')).toContainText(project.reference);
    await expect(page.getByTestId('kitchen-project-actions')).toBeVisible();
    if (stage !== 'completed') await expect(page.getByTestId('kitchen-stage-navigation')).toBeVisible();
    await details.click();
    await expect(page.getByTestId('kitchen-project-details')).toHaveCount(0);
  }
});

test('Kitchen stages use one editable or saved source without repeated summary boxes', async ({ page, context }, info) => {
  const project = await projectAt(context.request, 'lead');
  await seed(page);
  await page.goto(`/kitchen/${project.id}/stages/lead`);
  for (const stage of ['lead', 'visit', 'cad', 'design', 'quotation', 'order', 'production', 'installation', 'completed']) {
    await (await projectControl(page, 'kitchen-project-actions')).click();
    await page.getByRole('menuitem', { name: 'Stage history', exact: true }).click();
    await page.getByTestId('kitchen-workflow-sheet').getByTestId(`kitchen-stage-${stage}`).click();
    await expect(page.getByTestId('kitchen-save-status')).toHaveCount(1);
    await expect(page.getByTestId('kitchen-save-status').locator('[aria-live]')).toHaveCount(1);
    expect(await page.getByTestId('kitchen-save-status').evaluate(element => getComputedStyle(element).borderTopWidth)).toBe('0px');
    const task = page.getByTestId('kitchen-current-task-region');
    await expect(page.getByTestId(`kitchen-progress-${stage}`)).toHaveCount(0);
    await expect(task.getByTestId('kitchen-assignee')).toHaveCount(0);
    await expect(task.getByText(project.customer.name, { exact: true })).toHaveCount(0);
    const repeatedTitle = ({ lead: 'Lead details', visit: 'Showroom visit', cad: 'CAD progress', design: 'Design', quotation: 'Quotation', order: 'Order', production: 'Production', installation: 'Installation', completed: 'Completed project' } as Record<string, string>)[stage];
    await expect(task.getByRole('heading', { name: repeatedTitle, exact: true })).toHaveCount(0);
    if (stage === 'lead') {
      await expect(page.getByTestId('kitchen-lead-site_location')).toBeVisible();
      await expect(page.getByTestId('kitchen-lead-details')).toHaveCount(0);
    } else if (stage === 'design' || stage === 'quotation') {
      if (stage === 'design') {
        await expect(page.getByTestId('kitchen-design-edit-shared')).toHaveCount(0);
        await expect(page.getByTestId('kitchen-design-pdf-pick')).toHaveCount(0);
      } else {
        await expect(page.getByTestId('kitchen-quotation-shared-date')).toBeVisible();
        await expect(page.getByTestId('kitchen-quotation-shared-date')).toBeDisabled();
      }
      await expect(page.getByTestId(`kitchen-${stage}-details`)).toHaveCount(0);
      if (stage === 'quotation') await expect(page.getByTestId('kitchen-quotation-design-version')).toHaveCount(0);
    } else if (stage === 'order') {
      await expect(page.getByTestId('kitchen-order-details')).toHaveCount(0);
      await expect(page.getByTestId('kitchen-order-pending')).toHaveText('Status: Pending confirmation');
      await expect(page.getByTestId('kitchen-order-confirmed')).toHaveCount(1);
      await expect(page.getByTestId('kitchen-order-amount')).toHaveCount(1);
      await page.getByTestId('kitchen-order-pending').scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath('order-single-source.png') });
    } else if (stage === 'production' || stage === 'installation') {
      await expect(page.getByTestId(`kitchen-${stage}-details`)).toHaveCount(0);
      await expect(page.getByTestId(`kitchen-${stage}-notes`)).toHaveCount(1);
      await expect(page.getByTestId(`kitchen-${stage}-notes`)).toHaveJSProperty('readOnly', true);
      await expect(page.getByTestId(`kitchen-${stage}-start`)).toHaveCount(1);
      await expect(page.getByTestId(`kitchen-${stage}-complete`)).toHaveCount(1);
    } else if (stage === 'visit' || stage === 'cad') {
      await expect(page.getByTestId(`kitchen-${stage}-details`)).toHaveCount(0);
      await expect(page.getByTestId(`kitchen-${stage}-notes`)).toHaveCount(1);
      await expect(page.getByTestId(`kitchen-${stage}-notes`)).toHaveJSProperty('readOnly', true);
    } else {
      const details = page.getByTestId(`kitchen-${stage}-details`);
      await expect(details).toBeVisible();
      const fields = await details.evaluate(element => Array.from(element.children).map(field => ({
        border: getComputedStyle(field).borderTopWidth, text: field.textContent,
      })));
      expect(fields.length).toBeGreaterThanOrEqual(3);
      for (const field of fields) {
        expect(field.border, `${stage}: read-only records keep clear labels`).toBe('1px');
        expect(field.text).toContain(':');
      }
      if (stage === 'visit') await expect(page.getByTestId('kitchen-visit-notes')).toHaveCount(0);
      if (stage === 'cad') await expect(page.getByTestId('kitchen-cad-notes')).toHaveCount(0);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
});

test('Kitchen missing quotation PDF and order prerequisites retain entry across stage return actions', async ({ page, context }, info) => {
  const project = await projectAt(context.request, 'quotation');
  const health = captureRuntimeHealth(page);
  await seed(page);
  await page.goto(`/kitchen/${project.id}/stages/quotation`);
  await expect(page.getByTestId('kitchen-quotation-receive')).toBeDisabled();
  const date = page.getByTestId('kitchen-quotation-shared-date');
  await date.fill(kitchenIndiaToday());
  await expect(page.getByTestId('kitchen-quotation-design-version')).toHaveCount(0);
  await expect(page.getByTestId('kitchen-quotation-final-design')).toBeVisible();
  const returned = await clickCommand(page, 'kitchen-previous-stage', 'move_stage');
  expect(returned.stage).toBe('design');
  await clickCommand(page, 'kitchen-advance-quotation', 'move_stage');
  await expect(date).toHaveValue(kitchenIndiaToday());
  await expect(page.getByTestId('kitchen-quotation-design-version')).toHaveCount(0);
  const file = await uploadKitchenPdfInForm(page, 'kitchen-quotation-GI-pdf', 'recovery-quotation.pdf');
  await page.getByTestId(`kitchen-quotation-GI-pdf-${file.attachment.id}-final`).click();
  await page.getByTestId('kitchen-quotation-sent-yes').click();
  await page.getByTestId('kitchen-version-response-approved').click();
  await clickCommand(page, 'kitchen-quotation-receive', 'quotation_receive');
  await clickCommand(page, 'kitchen-advance-order', 'move_stage');
  await expect(page.getByTestId('kitchen-order-confirm')).toBeDisabled();
  await expect(page.getByTestId('kitchen-order-pending')).toHaveText('Status: Pending confirmation');
  await page.screenshot({ path: info.outputPath('order-pending-confirmation.png') });
  await clickCommand(page, 'kitchen-previous-stage', 'move_stage');
  await expect(page.getByTestId('kitchen-quotation-final-selection')).toContainText('GI');
  await expect(date).toHaveValue(kitchenIndiaToday());
  await (await projectControl(page, 'kitchen-project-actions')).click();
  await page.getByRole('menuitem', { name: 'Documents', exact: true }).click();
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
  await expect(page.getByTestId('kitchen-disclose-site-visit')).toHaveCount(0);
  await openProjectTool(page, 'site-visit');
  await expect(page.getByTestId('kitchen-site-save')).toBeDisabled();
  await expect(page.getByText('Choose whether this visit actually took place to enable recording.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Visit actually took place: Yes — actual visit', exact: true }).click();
  await page.getByTestId('kitchen-site-date').fill('2026-10-26');
  const visit = await clickCommand(page, 'kitchen-site-save', 'site_visit');
  expect(visit.site_visit_count).toBe(1);
  await page.getByTestId('kitchen-site-visits-sheet').getByRole('button', { name: 'Close', exact: true }).click();
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
  expect(query.has('assignee')).toBe(false);
  expect(query.get('attention')).not.toBe('next_action_overdue');
  expect(query.get('sort')).not.toBe('next_action');
  expect(query.get('date_field')).not.toBe('deadline');
  await expect(page.getByTestId(`kitchen-project-${project.id}`)).toBeVisible();
  await expect(page.getByTestId(`kitchen-project-${project.id}`)).not.toContainText('Unassigned');
  await expect(page.getByTestId(`kitchen-project-${project.id}`)).not.toContainText('next action');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('kitchen-queue-review.png'), fullPage: true });
  await expect(page.getByTestId('kitchen-filters-open')).toHaveCount(0);
  await expect(page.getByTestId('kitchen-filters')).toHaveCount(0);
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
