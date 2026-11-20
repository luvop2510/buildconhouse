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
  await expect(page.getByText('No matching customers. Keep typing to create a new customer.', { exact: true })).toBeVisible();
  expect(creates).toBe(0);
  await customerName(page).blur();
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

test('tile draft waits for confirmation before associating a cross-floor customer', async ({ page }) => {
  await mockSession(page, '/tiles/quotation', false);
  const source = { id: 'sanitary-contact', floor_id: 'first-floor', name: 'Confirmed profile', phone: '9888801234' };
  await page.route('**/api/customer-search/candidates?**', route => {
    expect(new URL(route.request().url()).searchParams.get('name')).toBe('Typed contact name');
    return route.fulfill({ json: [source] });
  });
  const customerWrites: Record<string, unknown>[] = [];
  await page.route('**/api/customers**', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: [] });
    expect(route.request().method()).toBe('POST');
    customerWrites.push(route.request().postDataJSON());
    expect(route.request().headers()['x-floor-id']).toBe('ground-floor');
    return route.fulfill({ json: { ...source, id: 'linked-ground-contact', floor_id: 'ground-floor' } });
  });
  const quotationWrites: Record<string, unknown>[] = [];
  const updatedAt = '2026-10-27T03:00:00Z';
  await page.route('**/api/quotations', route => {
    quotationWrites.push(route.request().postDataJSON());
    return route.fulfill({ json: { id: 'linked-draft', number: 'TQ-LINKED', updated_at: updatedAt } });
  });
  await page.route('**/api/quotations/linked-draft', route => route.fulfill({ json: { updated_at: updatedAt, grand_total: 0 } }));
  await page.goto('/tiles/quotation');
  await address(page).fill('Quotation project address');
  await customerName(page).fill('Typed contact name');
  await customerName(page).blur();
  const picker = page.getByRole('dialog', { name: 'Check for an existing customer' });
  await expect(picker).toBeVisible();
  expect(customerWrites).toHaveLength(0);
  expect(quotationWrites).toHaveLength(0);
  await picker.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(picker).toBeHidden();
  await page.getByRole('button', { name: 'Review customer', exact: true }).click();
  await picker.getByRole('button', { name: 'Use Confirmed profile', exact: true }).click();
  await expect(page).toHaveURL(/id=linked-draft/);
  await expect(customerName(page)).toHaveValue('Confirmed profile');
  expect(customerWrites).toHaveLength(1);
  expect(customerWrites[0]).toMatchObject({ identity_source_customer_id: source.id, identity_source_floor_id: source.floor_id, client_draft_id: expect.any(String) });
  expect(quotationWrites).toHaveLength(1);
  expect(quotationWrites[0]).toMatchObject({ customer_id: 'linked-ground-contact', phone_snapshot: source.phone, address_snapshot: 'Quotation project address' });
});
