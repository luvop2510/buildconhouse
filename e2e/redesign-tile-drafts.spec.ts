import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

const image = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#987654"/></svg>')}`;
const product = { id: 'draft-tile', sku: 'DRAFT-01', name: 'Draft floor tile', price: 100, images: [image], size: '600 × 600', specs: { sqft_per_box: 10 } };
const customerName = (page: any) => page.locator('[data-testid="tiles-customer-name"], [data-testid="mobile-customer-name"]');
const address = (page: any) => page.locator('[data-testid="tiles-meta-ADDRESS"], [data-testid="mobile-address"]');
const lineName = (page: any) => page.locator('[data-testid="tiles-product-0-name"], [data-testid="mobile-name-0"]');
async function draftSnapshot(page: any) {
  return page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('forge.builder.draft.v1.tiles.')).map(key => {
    try { return JSON.parse(JSON.parse(localStorage.getItem(key)!)); } catch { return null; }
  }).filter(Boolean));
}
async function catalog(page: any) {
  await page.route('**/api/products?**', (route: any) => route.fulfill({ json: { items: [product], total: 1 } }));
  await page.route('**/api/products/draft-tile', (route: any) => route.fulfill({ json: product }));
  await page.route('**/api/products/draft-tile/size-variants', (route: any) => route.fulfill({ json: { available_sizes: [product.size] } }));
}

test('critical incomplete tile selection preserves product photo and address after reload with one direct quotation action', async ({ page }, info) => {
  await mockSession(page, '/tiles/selection', false, { seedStorageOnce: true });
  await catalog(page);
  let creates = 0;
  await page.route('**/api/quotations', route => { creates++; return route.fulfill({ status: 503, json: { detail: 'No remote writes expected without a name' } }); });
  await page.goto('/tiles/selection');
  await expect(customerName(page)).toBeVisible();
  await address(page).fill('Draft project address');
  await page.getByRole('button', { name: 'Select a product', exact: true }).first().click();
  await page.getByTestId('tiles-picker-card-draft-tile').click();
  await expect(lineName(page)).toHaveValue(product.name);
  await expect.poll(async () => (await draftSnapshot(page)).some((draft: any) => draft.header.address === 'Draft project address' && draft.rows[0].image === image)).toBe(true);
  await page.reload();
  await expect(lineName(page)).toHaveValue(product.name);
  await expect(address(page)).toHaveValue('Draft project address');
  await expect(customerName(page)).toHaveValue('');
  await expect(page.getByRole('button', { name: /submit|approve|print/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Move to Quotation', exact: true })).toHaveCount(1);
  expect(creates).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('recovered-selection.png'), animations: 'disabled' });
});

test('critical tile quotation auto saves without address and survives reload with one remote document', async ({ page }, info) => {
  await mockSession(page, '/tiles/quotation', false, { seedStorageOnce: true });
  await catalog(page);
  let saved: any = null, creates = 0;
  await page.route('**/api/customers', route => route.request().method() === 'POST'
    ? route.fulfill({ json: { id: 'draft-customer', name: route.request().postDataJSON().name } })
    : route.fulfill({ json: [] }));
  await page.route('**/api/quotations', route => {
    creates++;
    saved = { ...route.request().postDataJSON(), id: 'saved-draft', number: 'TQ-DRAFT', customer_name: 'Automatic draft customer', floor_id: 'ground-floor', status: 'draft', updated_at: '2026-10-27T03:00:00Z' };
    return route.fulfill({ json: saved });
  });
  await page.route(/\/api\/quotations\/saved-draft(?:\?.*)?$/, route => {
    if (route.request().method() === 'PATCH') saved = { ...saved, ...route.request().postDataJSON(), updated_at: '2026-10-27T03:01:00Z' };
    return route.fulfill({ json: saved });
  });
  await page.goto('/tiles/quotation?productId=draft-tile');
  await expect(lineName(page)).toHaveValue(product.name);
  await customerName(page).fill('Automatic draft customer');
  await expect.poll(() => creates).toBe(1);
  await expect(page).toHaveURL(/id=saved-draft/);
  await expect.poll(() => saved?.items?.[0]?.product_id).toBe('draft-tile');
  expect(saved.address_snapshot).toBeNull();
  await page.reload();
  await expect(customerName(page)).toHaveValue('Automatic draft customer');
  await expect(lineName(page)).toHaveValue(product.name);
  expect(creates).toBe(1);
  expect(saved.items[0].image).toBe(image);
  await expect(page.getByRole('button', { name: /submit|approve|print/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Place Order', exact: true })).toHaveCount(1);
  await page.screenshot({ path: info.outputPath('saved-quotation.png'), animations: 'disabled' });
});
