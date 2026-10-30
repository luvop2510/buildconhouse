import { referrerCode } from '../src/utils/referrer';
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
  await expect(sheet.getByText(/ARC-EXISTING-EXISTING/)).toBeVisible();
  await expect(sheet.getByText(/7 customers brought/)).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'No referrer', exact: true })).toBeVisible();
  const existing = sheet.getByRole('button', { name: 'Existing architect', exact: true });
  expect((await existing.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await sheet.getByRole('button', { name: 'Architect', exact: true }).click();
  await sheet.getByRole('textbox', { name: 'Designer / architect name (required)' }).fill('Pending architect');
  await expect(sheet.getByRole('button', { name: 'Add and select', exact: true })).toBeDisabled();
  await sheet.getByTestId('lead-interior-phone').fill('9909955755');
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
  await expect(sheet.getByRole('button', { name: 'All references', exact: true })).toBeVisible();
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
  await expect(card).toContainText('NTS · ARC-NTS-ARCHITEC');
  await expect(card).toContainText('NTS Studio');
  await expect(card).toContainText('12 customers brought to this floor');
});

const directoryReferences = [
  { id: 'saved-architect', type: 'architect', name: 'Aditi Architect', company: 'Lotus Architecture', customers_acquired: 4 },
  { id: 'saved-interior', type: 'interior_designer', name: 'Ishita Interiors', company: 'Willow Studio', customers_acquired: 9 },
] as const;

for (const selected of directoryReferences) {
  test(`critical existing ${selected.type} reference is available by default, searchable and selected without creation`, async ({ page }) => {
    await mockSession(page, '/customers/new', false);
    const reads: URL[] = [];
    let creates = 0;
    await page.route('**/api/referrers*', route => {
      if (route.request().method() === 'POST') {
        creates++;
        return route.fulfill({ status: 400, json: { detail: 'This test selects an existing reference.' } });
      }
      reads.push(new URL(route.request().url()));
      return route.fulfill({ json: directoryReferences });
    });
    await page.goto('/customers/new');
    await page.getByRole('button', { name: 'Additional customer details' }).click();
    const trigger = page.getByRole('button', { name: 'Referred By', exact: true, includeHidden: true });
    await trigger.click();
    const sheet = page.getByTestId('customer-referrer-sheet');
    await expect(sheet.getByRole('button', { name: 'All references', exact: true })).toBeVisible();
    for (const reference of directoryReferences) await expect(sheet.getByRole('button', { name: reference.name, exact: true })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Add and select', exact: true })).toHaveCount(0);
    const code = referrerCode(selected.id, selected.type, selected.name);
    const search = sheet.getByRole('textbox', { name: 'Search references', exact: true });
    for (const term of [selected.name.toLowerCase(), selected.company.toUpperCase(), code]) {
      await search.fill(term);
      await expect(sheet.getByRole('button', { name: selected.name, exact: true })).toBeVisible();
      for (const other of directoryReferences.filter(reference => reference.id !== selected.id)) {
        await expect(sheet.getByRole('button', { name: other.name, exact: true })).toHaveCount(0);
      }
    }
    await sheet.getByRole('button', { name: selected.name, exact: true }).click();
    await expect(sheet).toHaveCount(0);
    await expect(trigger).toContainText(selected.name);
    await expect(trigger).toContainText(selected.company);
    await expect(trigger).toContainText(code);
    await trigger.click();
    // The selected contact's actual type must not turn the next open into a category-only picker.
    for (const reference of directoryReferences) await expect(sheet.getByRole('button', { name: reference.name, exact: true })).toBeVisible();
    expect(reads.length).toBeGreaterThanOrEqual(2);
    expect(reads.every(url => !url.searchParams.has('type') && url.searchParams.get('include_counts') === 'true')).toBe(true);
    expect(creates).toBe(0);
    await sheet.getByRole('button', { name: 'No referrer', exact: true }).click();
    await expect(trigger).toHaveText('Select architect or interior designer');
  });
}

test('critical reference directory failure offers retry and preserves existing contact identity on selection', async ({ page }) => {
  await mockSession(page, '/customers/new', false);
  let reads = 0, creates = 0;
  await page.route('**/api/referrers*', route => {
    if (route.request().method() !== 'GET') {
      creates++;
      return route.fulfill({ status: 400, json: { detail: 'Creation is unexpected.' } });
    }
    reads++;
    return reads === 1
      ? route.fulfill({ status: 503, json: { detail: 'Synthetic unavailable directory' } })
      : route.fulfill({ json: directoryReferences });
  });
  await page.goto('/customers/new');
  await page.getByRole('button', { name: 'Additional customer details' }).click();
  const trigger = page.getByRole('button', { name: 'Referred By', exact: true, includeHidden: true });
  await trigger.click();
  const sheet = page.getByTestId('customer-referrer-sheet');
  await expect(sheet.getByText('Could not load architects and interior designers. Retry to load the reference directory.', { exact: true })).toBeVisible();
  await expect(sheet.getByText('No existing references in this category.', { exact: true })).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Retry references', exact: true }).click();
  for (const reference of directoryReferences) await expect(sheet.getByRole('button', { name: reference.name, exact: true })).toBeVisible();
  await sheet.getByRole('button', { name: 'Ishita Interiors', exact: true }).click();
  await expect(trigger).toContainText('INT-ISHITA-SAVED-IN');
  expect(reads).toBe(2);
  expect(creates).toBe(0);
});
