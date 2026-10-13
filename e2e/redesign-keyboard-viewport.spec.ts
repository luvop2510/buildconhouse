import { expect, test, type Locator, type Page } from '@playwright/test';
import { floors, mockSession } from './audit-fixtures';

// Engine emulation does not open the operating system keyboard. Exercise the
// real viewport event/DOM layout behavior with its documented geometry instead.
async function keyboardFixture(page: Page) {
  await page.addInitScript(() => {
    const viewport = new EventTarget();
    Object.assign(viewport, { height: innerHeight, width: innerWidth, offsetTop: 0, offsetLeft: 0, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    (window as any).resizeKeyboard = (height: number, offsetTop = 0, scale = 1) => {
      Object.assign(viewport, { height, offsetTop, scale, width: innerWidth / scale });
      viewport.dispatchEvent(new Event('resize'));
      viewport.dispatchEvent(new Event('scroll'));
    };
  });
}

async function resizeKeyboard(page: Page, height: number, top = 0, scale = 1) {
  await page.evaluate(({ height, top, scale }) => (window as any).resizeKeyboard(height, top, scale), { height, top, scale });
  if (scale === 1) await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--forge-visible-height'))).toBe(`${height}px`);
}

async function inVisibleArea(input: Locator, height: number, top = 0) {
  await expect.poll(async () => {
    const box = await input.boundingBox();
    return !!box && box.y >= top && box.y + box.height <= top + height ? 'visible' : JSON.stringify(box);
  }).toBe('visible');
}

test('critical keyboard viewport: customer entries and save remain visible through keyboard and rotation', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await keyboardFixture(page);
  await mockSession(page, '/customers/new', false);
  await page.route('**/api/referrers**', route => route.fulfill({ json: [] }));
  await page.goto('/customers/new');
  await page.getByTestId('new-customer-name').fill('Keyboard customer');
  await page.getByRole('button', { name: 'Additional customer details' }).click();
  const address = page.getByTestId('new-customer-address');
  await address.fill('Visible while typing');
  await address.focus();
  await resizeKeyboard(page, 360, 40);
  await inVisibleArea(address, 360, 40);
  await inVisibleArea(page.getByTestId('new-customer-save'), 360, 40);
  await expect(address).toHaveValue('Visible while typing');
  await resizeKeyboard(page, 300, 60);
  await inVisibleArea(address, 300, 60);
  await resizeKeyboard(page, page.viewportSize()!.height);
  await expect(page.getByTestId('new-customer-name')).toHaveValue('Keyboard customer');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(errors).toEqual([]);
});

test('critical keyboard viewport: staff drawer scrolls focused lower fields and preserves Phone-only input', async ({ page }) => {
  await keyboardFixture(page);
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
  await expect(page.getByTestId('add-staff-mobile')).toHaveCount(0);
  await page.getByTestId('add-staff-phone').fill('9876543210');
  const role = page.getByTestId('add-staff-team-role');
  await role.fill('Ground Floor Sales');
  await role.focus();
  await resizeKeyboard(page, 320, 60);
  const panel = page.getByTestId('add-staff-sheet');
  await inVisibleArea(panel, 320, 60);
  await inVisibleArea(role, 320, 60);
  await expect(page.getByTestId('add-staff-phone')).toHaveValue('9876543210');
  await resizeKeyboard(page, 280, 0);
  await inVisibleArea(role, 280);
  await resizeKeyboard(page, 100, 10, 2);
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--forge-visible-height'))).toBe('280px');
  await resizeKeyboard(page, page.viewportSize()!.height);
  await panel.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByTestId('team-add-btn')).toBeFocused();
});

test('critical keyboard viewport: command search panel fits above the keyboard', async ({ page }) => {
  await keyboardFixture(page);
  await mockSession(page, '/customers', false);
  await page.goto('/customers');
  await expect(page.getByRole('heading', { name: 'Customers', exact: true })).toBeVisible();
  await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog', { name: 'Search workspace', exact: true });
  const input = dialog.getByRole('textbox', { name: 'Search commands, customers, quotations, and products', exact: true });
  await expect(input).toBeFocused();
  await resizeKeyboard(page, 300, 40);
  await inVisibleArea(dialog, 300, 40);
  await inVisibleArea(input, 300, 40);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
