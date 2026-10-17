import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

test('critical referrer picker: accessible choices and a delayed add preserve the newer selection', async ({ page }) => {
  await mockSession(page, '/customers/new', false);
  const partner = { id: 'existing-partner', name: 'Existing architect', type: 'architect', customers_acquired: 7, company: 'NTS' };
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let started = false;
  await page.route('**/api/referrers*', async route => {
    if (route.request().method() === 'POST') {
      started = true;
      await pending;
      return route.fulfill({ json: { id: 'new-partner', name: 'Pending architect', type: 'architect' } });
    }
    return route.fulfill({ json: [partner] });
  });
  await page.goto('/customers/new');
  await page.getByRole('button', { name: 'Additional customer details' }).click();
  // The reopened modal correctly hides its background from accessibility.
  // Retain the exact background control for the stale-response assertion;
  // actual focus/click actions below still require it to be visible.
  const trigger = page.getByRole('button', { name: 'Referred By', exact: true, includeHidden: true });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const sheet = page.getByTestId('customer-referrer-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText(/ARC-EXISTING-PARTNER/)).toBeVisible();
  await expect(sheet.getByText(/7 customers brought/)).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'No referrer', exact: true })).toBeVisible();
  const existing = sheet.getByRole('button', { name: 'Existing architect', exact: true });
  expect((await existing.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await sheet.getByRole('textbox', { name: 'Designer / architect name' }).fill('Pending architect');
  await sheet.getByRole('button', { name: 'Add and select', exact: true }).click();
  await expect.poll(() => started).toBe(true);
  // Choosing an existing result dismisses this attempt. Reopen the picker
  // before the already sent creation request returns.
  await existing.click();
  await expect(trigger).toContainText('Existing architect');
  await trigger.click();
  await expect(sheet).toBeVisible();
  const response = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/referrers');
  release();
  await (await response).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(sheet.getByRole('button', { name: 'Add and select', exact: true })).toBeVisible();
  await expect(trigger).toContainText('Existing architect');
  await page.screenshot({ path: test.info().outputPath('referrer-picker.png') });
  await sheet.getByRole('button', { name: 'No referrer', exact: true }).click();
  await expect(trigger).toHaveText('Select architect or interior designer');
});


test('customer detail retains architect NTS name, stable reference ID and floor acquisition count', async ({ page }) => {
  await mockSession(page, '/customers/referral-customer', false);
  await page.route('**/api/customers/referral-customer*', route => route.fulfill({ json: {
    id: 'referral-customer', name: 'Referral customer', floor_id: 'first-floor',
    phone: '9999999999', referrer_id: 'architect-nts', referrer_type: 'architect',
    referrer_name: 'NTS', referrer_company: 'NTS Studio', referrer_customers_acquired: 12,
  } }));
  await page.goto('/customers/referral-customer');
  const card = page.getByTestId('customer-referrer-detail');
  await expect(card).toBeVisible();
  await expect(card).toContainText('NTS · ARC-ARCHITECT-NTS');
  await expect(card).toContainText('NTS Studio');
  await expect(card).toContainText('12 customers brought to this floor');
});
