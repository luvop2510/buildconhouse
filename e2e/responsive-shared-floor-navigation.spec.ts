import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

test('a bookmarked department notebook synchronizes its floor before loading records', async ({ page }) => {
  await mockSession(page, '/notebook/furniture', false);
  await page.addInitScript(() => localStorage.setItem('forge.active-floor', JSON.stringify('second-floor')));
  const reads: string[] = [];
  await page.route('**/api/followups/notebook/**', route => {
    reads.push(route.request().headers()['x-floor-id']);
    return route.fulfill({ json: { rows: [], next_cursor: null } });
  });
  await page.goto('/notebook/furniture');
  await expect(page).toHaveURL(/\/notebook\/furniture$/);
  await expect(page.getByRole('heading', { name: 'Furniture Floor Walk-ins', exact: true })).toBeVisible();
  await expect(page.getByTestId('floor-switcher')).toHaveAccessibleName('Switch workspace. Current workspace: Furniture Floor');
  await expect.poll(() => reads.length).toBeGreaterThan(0);
  expect(reads.every(floor => floor === 'third-floor')).toBe(true);
});

for (const [floor, path] of [['second-floor', '/notebook/kitchen'], ['third-floor', '/notebook/furniture'], ['ground-floor', '/tiles']] as const) {
  test(`${floor} exposes shared Purchases and completed customers while RNB remains furniture-only`, async ({ page }) => {
    await mockSession(page, path, false);
    await page.addInitScript(id => localStorage.setItem('forge.active-floor', JSON.stringify(id)), floor);
    await page.route('**/api/followups/notebook/**', route => route.fulfill({ json: { rows: [], next_cursor: null } }));
    await page.route('**/api/purchases/**', route => {
      expect(route.request().headers()['x-floor-id']).toBe(floor);
      const pathname = new URL(route.request().url()).pathname;
      const json = pathname.endsWith('/items/page') ? { items: [], total: 0, next_skip: null, has_more: false, summaries: { blocked_count: 0, sla_days: 7, stage_counts: {} } }
        : pathname.endsWith('/brands') ? { brands: [], all: 0 } : [];
      return route.fulfill({ json });
    });
    await page.goto(path);
    await expect(page.getByRole('link', { name: floor === 'ground-floor' ? 'Quotations' : 'Walk-ins', exact: true })).toBeVisible();
    const sidebarPurchases = page.getByRole('link', { name: 'Purchases', exact: true });
    if (await sidebarPurchases.isVisible()) {
      await expect(page.getByRole('link', { name: 'RNB quotations', exact: true })).toHaveCount(floor === 'third-floor' ? 1 : 0);
      await sidebarPurchases.click();
    } else {
      await expect(page.getByRole('link', { name: 'RNB quotations', exact: true })).toHaveCount(floor === 'third-floor' ? 1 : 0);
      await page.getByRole('button', { name: 'More', exact: true }).click();
      await page.getByRole('link', { name: 'Purchases', exact: true }).click();
    }
    await expect(page).toHaveURL(/\/purchases$/);
    await page.getByTestId('view-customers').click();
    await page.getByRole('button', { name: 'Open 100 percent complete customers', exact: true }).click();
    await expect(page).toHaveURL(/\/purchases-completed$/);
    await expect(page.getByText(/100% Customers/, { exact: false }).first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}
