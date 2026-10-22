import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

test('critical customer edit action opens the editor and saves without opening the parent card', async ({ page }) => {
  await mockSession(page, '/customers', false);
  let customer = { id: 'desktop-edit', name: 'Desktop customer', phone: '9999999999', email: '', tier: 'retail', portal_enabled: false, purchase_completion_status: 'active' };
  await page.route(/\/api\/customers(?:\?|$)/, route => route.fulfill({ json: [customer] }));
  await page.route('**/api/customers/desktop-edit', async route => {
    if (route.request().method() === 'PATCH') customer = { ...customer, ...route.request().postDataJSON() };
    await route.fulfill({ json: customer });
  });
  await page.goto('/customers');
  await page.getByTestId('edit-customer-desktop-edit').click();
  await expect(page).toHaveURL(/\/customers\/desktop-edit\/edit$/);
  await expect(page.getByTestId('edit-customer-name')).toHaveValue('Desktop customer');
  await page.getByTestId('edit-customer-name').fill('Updated desktop customer');
  const save = page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().endsWith('/api/customers/desktop-edit'));
  await page.getByTestId('edit-customer-save').click();
  expect((await save).ok()).toBe(true);
  await expect(page).toHaveURL(/\/customers\/desktop-edit\/edit$/);
  await expect(page.getByTestId('edit-customer-name')).toHaveValue('Updated desktop customer');
  await page.screenshot({ path: test.info().outputPath('customer-edit.png') });
  await page.goto('/customers');
  await page.getByTestId('edit-customer-desktop-edit').press('Enter');
  await expect(page).toHaveURL(/\/customers\/desktop-edit\/edit$/);
  await expect(page.getByTestId('edit-customer-name')).toHaveValue('Updated desktop customer');
});
