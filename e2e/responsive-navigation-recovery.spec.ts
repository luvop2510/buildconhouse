import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

test('critical staff navigation survives browser back forward and a hard reload', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const pendingReads = new Set<import('@playwright/test').Request>();
  let lastReadActivity = Date.now();
  page.on('request', request => {
    if (request.method() === 'GET' && new URL(request.url()).pathname.startsWith('/api/')) {
      pendingReads.add(request);
      lastReadActivity = Date.now();
    }
  });
  const finishRead = (request: import('@playwright/test').Request) => {
    if (pendingReads.delete(request)) lastReadActivity = Date.now();
  };
  page.on('requestfinished', finishRead);
  page.on('requestfailed', finishRead);
  // Safari reports document-owned reads canceled by history/reload as access
  // control errors. Finish this probe's reads before changing its document.
  const settleReads = () => expect.poll(() => pendingReads.size === 0 && Date.now() - lastReadActivity >= 200,
    { message: 'Navigation probe API reads must finish before history or reload' }).toBe(true);
  await mockSession(page, '/customers', false, { seedStorageOnce: true });
  await page.route('**/api/products/families?**', route => route.fulfill({ json: { items: [], total: 0 } }));
  await page.goto('/customers');
  await expect(page.getByText('No customers yet', { exact: true })).toBeVisible();
  const catalog = page.getByTestId(page.viewportSize()!.width < 768 ? 'bottom-nav-catalog' : 'nav-catalog');
  await catalog.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/catalog$/);
  await expect(page.getByTestId('floor-switcher')).toBeVisible();
  await expect(page.getByText('No products on this floor yet', { exact: true })).toBeVisible();
  await settleReads();
  await page.goBack();
  await expect(page).toHaveURL(/\/customers$/);
  await expect(page.getByText('No customers yet', { exact: true })).toBeVisible();
  await settleReads();
  await page.goForward();
  await expect(page).toHaveURL(/\/catalog$/);
  await expect(page.getByText('No products on this floor yet', { exact: true })).toBeVisible();
  await settleReads();
  await page.reload();
  await expect(page).toHaveURL(/\/catalog$/);
  await expect(page.getByTestId('floor-switcher')).toHaveAccessibleName('Switch workspace. Current workspace: The Sanitary Bathroom');
  await expect(page.getByTestId('login-submit')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await expect(page.getByText('No products on this floor yet', { exact: true })).toBeVisible();
  await settleReads();
  expect(errors).toEqual([]);
});

test('critical customer quotation deep link recovers from an unavailable document after reload', async ({ page }) => {
  await mockSession(page, '/quotes/bookmarked', false, { seedStorageOnce: true });
  let available = false;
  await page.route('**/api/portal/quotations/bookmarked', route => route.fulfill(available ? { json: {
    id: 'bookmarked', number: 'Q-BOOKMARK', status: 'draft', customer_name: 'Audit Customer',
    items: [], subtotal: 0, grand_total: 0, created_at: '2026-10-01T00:00:00Z',
  } } : { status: 503, json: { detail: 'Document temporarily unavailable' } }));
  await page.goto('/quotes/bookmarked');
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  available = true;
  await page.reload();
  await expect(page).toHaveURL(/\/quotes\/bookmarked$/);
  await expect(page.getByText('Q-BOOKMARK', { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId('login-submit')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});
