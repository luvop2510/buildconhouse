import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';
import { captureRuntimeHealth } from './runtime-health';

test('critical quotation Excel persists the current quotation and downloads on desktop and phone', async ({ page }) => {
  const health = captureRuntimeHealth(page);
  await mockSession(page, '/quotations/new', false);
  const customer = { id: 'excel-customer', name: 'Excel buyer' };
  let document = { id: 'excel-quote', customer_id: customer.id, customer_name: customer.name,
    number: 'Q-EXCEL', floor_id: 'first-floor', status: 'draft', rooms: ['Master Bath'],
    items: [{ id: 'line', product_id: 'basin', name: 'Basin', sku: 'BASIN', qty: 1, unit_price: 100, room: 'Master Bath' }],
    created_at: '2026-10-26T10:00:00Z', updated_at: '2026-10-26T10:00:00Z' };
  await page.route('**/api/customers**', route => route.fulfill({ json: [customer] }));
  await page.route('**/api/categories**', route => route.fulfill({ json: [] }));
  await page.route('**/api/brands**', route => route.fulfill({ json: [] }));
  await page.route('**/api/catalog/facets**', route => route.fulfill({ json: { sizes: [] } }));
  await page.route('**/api/products/families?**', route => route.fulfill({ json: { total: 0, items: [] } }));
  await page.route('**/api/quotations/recent?**', route => route.fulfill({ json: [] }));
  let saved = false, exported = false;
  await page.route(/\/api\/quotations\/excel-quote(?:\?.*)?$/, route => {
    if (route.request().method() === 'PATCH') { saved = true; document = { ...document, ...route.request().postDataJSON() }; }
    return route.fulfill({ json: document });
  });
  await page.route('**/api/quotations/excel-quote/xlsx', route => {
    expect(saved).toBe(true);
    expect(route.request().headers()['x-floor-id']).toBe('first-floor');
    exported = true;
    return route.fulfill({ contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: 'PK-test-workbook' });
  });
  await page.goto('/quotations/new?quotationId=excel-quote');
  await expect(page.getByTestId('quotation-workspace')).toBeVisible();
  const expand = page.getByTestId('expand-quotation-workspace');
  if (await expand.isVisible()) await expand.click();
  const quotationTab = page.getByTestId('builder-tab-quotation');
  if (await quotationTab.isVisible()) await quotationTab.click();
  await page.getByTestId('qty-line').fill('2');
  await page.getByTestId('qty-line').blur();
  const download = page.waitForEvent('download');
  if (await page.getByTestId('builder-actions').isVisible()) {
    await page.getByTestId('builder-actions').click();
    await page.getByRole('button', { name: 'Download quotation Excel', exact: true }).click();
  } else await page.getByTestId('generate-quotation-excel').click();
  await expect.poll(() => exported).toBe(true);
  const mobileSave = page.getByTestId('mobile-file-download');
  if (await mobileSave.count()) await mobileSave.click();
  expect((await download).suggestedFilename()).toBe('Excel buyer Quotation.xlsx');
  expect(document.items[0].qty).toBe(2);
  await health.assertHealthy();
});
