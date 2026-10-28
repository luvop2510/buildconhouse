import { expect, test, type Locator, type Page } from '@playwright/test';
import { floors, mockSession } from './audit-fixtures';

// These tests model visualViewport events; they do not open an OS keyboard.
async function keyboard(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    const viewport = new EventTarget();
    Object.assign(viewport, { width: 390, height: 844, offsetTop: 0, offsetLeft: 0, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    (window as any).keyboardScrollGeometry = (height: number, offsetTop: number) => {
      Object.assign(viewport, { height, offsetTop });
      viewport.dispatchEvent(new Event('resize'));
      viewport.dispatchEvent(new Event('scroll'));
    };
  });
}
async function resize(page: Page, height: number, top = 0) {
  await page.evaluate(({ height, top }) => (window as any).keyboardScrollGeometry(height, top), { height, top });
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--forge-visible-height'))).toBe(`${height}px`);
}
async function visibleInsideScroll(field: Locator) {
  await expect.poll(() => field.evaluate(element => {
    const box = element.getBoundingClientRect();
    const viewport = window.visualViewport!;
    let top = viewport.offsetTop, bottom = top + viewport.height;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (!/auto|scroll|hidden|clip/.test(getComputedStyle(parent).overflowY)) continue;
      const bounds = parent.getBoundingClientRect();
      top = Math.max(top, bounds.top + parent.clientTop);
      bottom = Math.min(bottom, bounds.top + parent.clientTop + parent.clientHeight);
    }
    return box.top >= top - 1 && box.bottom <= bottom + 1;
  }), { message: 'Focused field must fit the visual viewport AND every real clipping ancestor' }).toBe(true);
}
async function anchored(page: Page) {
  expect(await page.evaluate(() => ({ scroll: window.scrollY, fits: document.documentElement.scrollWidth <= innerWidth + 1 }))).toEqual({ scroll: 0, fits: true });
}

test('critical keyboard scroll: lower customer address retains focus and saves once without document pan', async ({ page }, info) => {
  await keyboard(page);
  await mockSession(page, '/customers/new', false);
  const writes: Record<string, unknown>[] = [];
  await page.route('**/api/referrers**', route => route.fulfill({ json: [] }));
  await page.route('**/api/customers', async route => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: [] });
    const payload = route.request().postDataJSON();
    writes.push(payload);
    return route.fulfill({ json: { id: 'keyboard-synthetic-customer', ...payload } });
  });
  await page.goto('/customers/new');
  await page.getByTestId('new-customer-name').fill('Synthetic keyboard customer');
  await page.getByRole('button', { name: 'Additional customer details', exact: true }).click();
  const address = page.getByTestId('new-customer-address');
  await address.fill('Lower field draft');
  const original = await address.elementHandle();
  await resize(page, 340, 40);
  await visibleInsideScroll(address);
  const beforeTyping = await address.boundingBox();
  await page.keyboard.type(' retained', { delay: 10 });
  await expect(address).toHaveValue('Lower field draft retained');
  await expect(address).toBeFocused();
  expect(await original!.evaluate(element => element === document.activeElement)).toBe(true);
  expect((await address.boundingBox())!.y).toBeCloseTo(beforeTyping!.y, 0);
  await visibleInsideScroll(address);
  await anchored(page);
  await page.screenshot({ path: info.outputPath('customer-lower-keyboard.png') });
  await resize(page, 844);
  await address.blur();
  await expect(page.getByRole('navigation', { name: 'Primary', exact: true })).toBeVisible();
  const saved = page.waitForResponse(response => response.url().endsWith('/api/customers') && response.request().method() === 'POST');
  await page.getByTestId('new-customer-save').click();
  expect((await saved).status()).toBe(200);
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ name: 'Synthetic keyboard customer', address: 'Lower field draft retained' });
});

test('critical keyboard scroll: nested staff sheet keeps lower input mounted through resize and dismissal', async ({ page }, info) => {
  await keyboard(page);
  await mockSession(page, '/team', false);
  await page.route('**/api/team', route => route.fulfill({ json: [] }));
  await page.route('**/api/roles', route => route.fulfill({ json: [] }));
  await page.route('**/api/settings/floors', route => route.fulfill({ json: floors }));
  await page.route('**/api/settings/access-grants/resources', route => route.fulfill({ json: {
    resources: [{ key: 'followups', label: 'Follow-ups', description: 'Contact leads', actions: ['view'], floor_ids: floors.map(floor => floor.id) }],
    action_descriptions: { view: 'View leads' },
  } }));
  await page.goto('/team');
  await page.getByTestId('team-add-btn').click();
  await page.getByTestId('add-staff-phone').fill('9876543210');
  const role = page.getByTestId('add-staff-team-role');
  await role.fill('Synthetic sales');
  const original = await role.elementHandle();
  await resize(page, 300, 40);
  await visibleInsideScroll(role);
  await page.keyboard.type(' retained');
  await expect(role).toHaveValue('Synthetic sales retained');
  await expect(role).toBeFocused();
  expect(await original!.evaluate(element => element === document.activeElement)).toBe(true);
  await visibleInsideScroll(role);
  await anchored(page);
  await page.screenshot({ path: info.outputPath('nested-sheet-keyboard.png') });
  await resize(page, 844);
  await page.getByTestId('add-staff-sheet').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByTestId('add-staff-sheet')).toHaveCount(0);
  await expect(page.getByTestId('team-add-btn')).toBeFocused();
  await expect(page.getByRole('navigation', { name: 'Primary', exact: true })).toBeVisible();
  await anchored(page);
});

test('critical keyboard scroll: oversized Kitchen notes scroll internally while the form stays anchored', async ({ page }, info) => {
  await keyboard(page);
  await mockSession(page, '/kitchen/keyboard-project/stages/visit', false, { floorId: 'second-floor' });
  const design = { id: 'design-keyboard', number: 1, workflow_cycle: 1, response: 'Pending', shared_date: '2026-10-27', handoff_status: 'Not recorded', notes: 'Initial note' };
  let project = {
    id: 'keyboard-project', reference: 'KIT-KEYBOARD', project_reference: 'KIT-KEYBOARD', customer_id: 'keyboard-customer',
    customer: { id: 'keyboard-customer', name: 'Synthetic Kitchen keyboard customer', phone: '9900000001' },
    version: 1, workflow_cycle: 1, stage: 'visit', status: 'Pending', lifecycle_status: 'Active',
    lead: { status: 'Qualified', site_location: 'Synthetic site' }, visit: { status: 'Visited', notes: 'Initial note' },
    cad: { received: true, progress: 100, ready: true, status: 'Completed' }, assignments: {},
    design_revision_count: 0, site_visit_count: 0, permissions: { can_update: true, can_assign: true, can_approve_exceptions: true },
    design_versions: [design], quotation_versions: [], orders: [], approvals: [], blocked_transitions: [], activity: [], attachments: [],
  };
  const writes: any[] = [];
  await page.route('**/api/kitchen-projects**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') {
      const body = request.postDataJSON(); writes.push(body);
      expect(path).toBe('/api/kitchen-projects/keyboard-project/commands');
      expect(body.command).toBe('save_visit');
      project = { ...project, version: project.version + 1, visit: { ...project.visit, ...body.payload } };
      return route.fulfill({ json: project });
    }
    if (path.endsWith('/configuration')) return route.fulfill({ json: { version: 1, decision_contract: '2026-10-20', department_manager_user_ids: [], files: { max_bytes: 786432, allowed_types: ['application/pdf'] } } });
    return route.fulfill({ json: project });
  });
  await page.goto('/kitchen/keyboard-project/stages/visit');
  const notes = page.getByTestId('kitchen-visit-notes');
  await notes.click();
  const original = await notes.elementHandle();
  await resize(page, 360, 40);
  await visibleInsideScroll(notes);
  await page.keyboard.type('\n' + Array.from({ length: 24 }, (_, i) => `Long note ${i}`).join('\n'));
  const expected = 'Initial note\n' + Array.from({ length: 24 }, (_, i) => `Long note ${i}`).join('\n');
  await expect(notes).toHaveValue(expected);
  await expect(notes).toBeFocused();
  expect(await original!.evaluate(element => element === document.activeElement)).toBe(true);
  await visibleInsideScroll(notes);
  await expect.poll(() => notes.evaluate(element => element.clientHeight)).toBeLessThanOrEqual(170);
  const stable = await notes.boundingBox();
  await page.keyboard.type(' tail', { delay: 10 });
  await expect(notes).toHaveValue(expected + ' tail');
  expect((await notes.boundingBox())!.y).toBeCloseTo(stable!.y, 0);
  await expect.poll(() => notes.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await anchored(page);
  await page.screenshot({ path: info.outputPath('kitchen-long-notes-keyboard.png') });
  await resize(page, 844);
  await notes.blur();
  await expect(page.getByRole('navigation', { name: 'Primary', exact: true })).toBeVisible();
  await expect(page.getByTestId('kitchen-visit-autosave')).toHaveText('Details saved');
  expect(writes.at(-1)).toMatchObject({ command: 'save_visit', payload: { notes: expected + ' tail' } });
});
