import { expect, test } from '@playwright/test';
import { floors, mockSession } from './audit-fixtures';

for (const kind of ['staff', 'customer'] as const) {
  test(`critical a newer ${kind} sign-in survives delayed startup identity hydration`, async ({ page }) => {
    await mockSession(page, '/login', false);
    let releaseIdentity!: () => void;
    let identityStarted!: () => void;
    let identityFinished!: () => void;
    const held = new Promise<void>(resolve => { releaseIdentity = resolve; });
    const started = new Promise<void>(resolve => { identityStarted = resolve; });
    const finished = new Promise<void>(resolve => { identityFinished = resolve; });
    await page.route('**/api/auth/me', async route => {
      identityStarted();
      await held;
      // The old fetch may have been cancelled by the newer login.
      try {
        await route.fulfill({ json: { id: 'old-owner', email: 'old@example.test', full_name: 'Old Owner', role: 'owner', active: true, floor_ids: floors.map(floor => floor.id) } }).catch(() => {});
      } finally { identityFinished(); }
    });
    const endpoint = kind === 'staff' ? 'login' : 'customer/login';
    await page.route(`**/api/auth/${endpoint}`, route => route.fulfill({ json: kind === 'staff'
      ? { access_token: 'fixture-only-staff', user: { id: 'new-owner', email: 'new@example.test', full_name: 'New Owner', role: 'owner', active: true, floor_ids: floors.map(floor => floor.id) } }
      : { access_token: 'fixture-only-customer', customer: { id: 'new-customer', email: 'new@example.test', name: 'New Customer', tier: 'retail', portal_enabled: true } }
    }));
    try {
      await page.goto('/login');
      await started;
      if (kind === 'customer') await page.getByRole('tab', { name: 'Customer portal' }).click();
      await page.getByTestId('login-email').fill('new@example.test');
      await page.getByTestId('login-password').fill('fixture-only-password');
      await page.getByTestId('login-submit').click();
      await expect(page).toHaveURL(kind === 'staff' ? /\/dashboard$/ : /\/home$/);
      releaseIdentity();
      await finished;
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      if (kind === 'staff') {
        await expect(page.getByRole('heading', { name: /^Good (morning|afternoon|evening), New\.$/ })).toBeVisible();
        await expect(page.getByRole('heading', { name: /^Good (morning|afternoon|evening), Old\.$/ })).toHaveCount(0);
      } else {
        await expect(page.getByText('New Customer', { exact: true }).first()).toBeVisible();
      }
      await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('forge.jwt.kind') || 'null'))).toBe(kind);
      await expect(page.getByTestId('login-submit')).toHaveCount(0);
      await expect(page).toHaveURL(kind === 'staff' ? /\/dashboard$/ : /\/home$/);
      await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('forge.jwt.kind') || 'null'))).toBe(kind);
    } finally {
      releaseIdentity();
    }
  });
}
