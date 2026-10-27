import { expect, test } from '@playwright/test';
import { floors, mockSession } from './audit-fixtures';

for (const account of ['owner', 'delegated'] as const) {
  test(`critical ${account} navigation works after login while unrelated role permissions are pending`, async ({ page }) => {
    const phone = page.viewportSize()!.width < 768;
    const grants = ['first-floor', 'ground-floor'].flatMap(floor_id => ['customers', 'followups'].map(resource => ({ floor_id, resource, actions: ['view'] })));
    const person = { id: `navigation-${account}`, full_name: 'Navigation Account', role: account === 'owner' ? 'owner' : 'worker', active: true, floor_ids: ['first-floor', 'ground-floor'], custom_access: account === 'delegated' };
    await mockSession(page, '/login', false, { signedIn: false, staff: person, grants });
    await page.route('**/api/auth/login', route => route.fulfill({ json: { access_token: 'fixture-only-staff', user: person } }));
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let matrixStarted = false;
    await page.route('**/api/settings/permission-matrix', async route => {
      matrixStarted = true;
      await held;
      await route.fulfill({ json: { modules: [], roles: [], matrix: { worker: { catalog: false } } } });
    });
    await page.route('**/api/customers?**', route => route.fulfill({ json: Array.from({ length: 45 }, (_, index) => ({
      id: `mobile-${index}`, name: `Navigation Customer ${index}`, phone: '9000000000',
    })) }));
    await page.route('**/api/followups/page?**', route => route.fulfill({ json: { items: [], page: 1, page_size: 100, has_more: false } }));
    try {
      await page.goto('/login');
      await page.getByTestId('login-email').fill('navigation@example.test');
      await page.getByTestId('login-password').fill('fixture-only-password');
      await page.getByTestId('login-submit').click();
      await expect(page).toHaveURL(account === 'owner' ? /\/dashboard$/ : /\/customers$/);
      await expect.poll(() => matrixStarted).toBe(true);
      const navigation = page.getByRole('navigation', { name: 'Primary', exact: true });
      await expect(navigation).toBeVisible();
      await expect(page.getByTestId('bottom-nav-loading')).toHaveCount(0);
      if (phone) {
        await page.getByRole('button', { name: 'More', exact: true }).click();
        await page.getByRole('dialog', { name: 'Workspace', exact: true }).getByRole('link', { name: 'Customers', exact: true }).click();
      } else await page.getByTestId('nav-customers').click();
      await expect(page).toHaveURL(/\/customers$/);
      const card = page.getByTestId('customer-mobile-0');
      await expect(card).toBeVisible();
      expect(await card.evaluate(element => {
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight + 200) {
            parent.scrollTop = 500;
            return parent.scrollTop;
          }
        }
        return 0;
      })).toBeGreaterThan(200);
      await expect(page.getByTestId('floor-switcher')).toBeInViewport();
      await page.getByTestId('floor-switcher').click();
      await page.getByRole('menuitem', { name: 'Ground Floor', exact: true }).click();
      await expect(page.getByTestId('floor-switcher')).toHaveAccessibleName('Switch workspace. Current workspace: Ground Floor');
      const followups = page.getByTestId(phone ? 'bottom-nav-followups' : 'nav-followups');
      await followups.click();
      await expect(page).toHaveURL(/\/followups$/);
      await expect(page.getByRole('heading', { name: 'Customers', exact: true })).toHaveCount(0);
      await expect(followups).toHaveAttribute('aria-current', 'page');
      if (account === 'delegated') await expect(page.getByTestId(phone ? 'bottom-nav-catalog' : 'nav-catalog')).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    } finally {
      release();
    }
  });
}

test('critical legacy navigation retains its applicable role matrix restrictions', async ({ page }) => {
  const phone = page.viewportSize()!.width < 768;
  await mockSession(page, '/customers', false, { staff: { id: 'legacy-navigation', full_name: 'Legacy Worker', role: 'worker', active: true, floor_ids: floors.map(floor => floor.id) } });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/settings/permission-matrix', async route => {
    await held;
    await route.fulfill({ json: { modules: [], roles: [], matrix: { worker: { catalog: false, quotations: false, followups: true } } } });
  });
  try {
    await page.goto('/customers');
    await expect(page.getByText('No customers yet', { exact: true })).toBeVisible();
    if (phone) {
      await expect(page.getByTestId('bottom-nav-loading')).toBeVisible();
      await expect(page.getByTestId(phone ? 'bottom-nav-catalog' : 'nav-catalog')).toHaveCount(0);
    } else await expect(page.getByTestId('nav-customers')).toBeVisible();
    release();
    await expect(page.getByTestId(phone ? 'bottom-nav-followups' : 'nav-followups')).toBeVisible();
    await expect(page.getByTestId(phone ? 'bottom-nav-catalog' : 'nav-catalog')).toHaveCount(0);
    await expect(page.getByTestId(phone ? 'bottom-nav-quotations' : 'nav-quotations')).toHaveCount(0);
  } finally {
    release();
  }
});

