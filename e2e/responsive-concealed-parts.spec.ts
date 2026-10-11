import { expect, test, type Page } from '@playwright/test';
import { mockSession } from './audit-fixtures';

async function concealedFixture(page: Page, customActions?: ("view" | "create" | "update")[], path = "/quotations/new") {
  await mockSession(page, path, false, customActions ? {
    staff: { id: 'conceal-viewer', email: 'viewer@example.test', full_name: 'Quote viewer', role: 'warehouse', active: true, custom_access: true, floor_ids: ['first-floor'], access_grants: [{ resource: 'quotations', actions: customActions, floor_id: 'first-floor' }] },
    grants: [{ resource: 'quotations', actions: customActions, floor_id: 'first-floor' }],
  } : {});
  const body = { id: 'body', sku: 'BODY-1', name: 'Concealed body', price: 400, mrp: 450, brand_id: 'brand', category_id: 'mixers', images: [] };
  const product = { id: 'trim', sku: 'TRIM-1', name: 'Wall mixer trim', price: 900, mrp: 1000, brand_id: 'brand', category_id: 'mixers', images: [], concealed_part: null as null | Record<string, unknown> };
  let savedRooms = ['Bathroom'];
  let saves = 0;
  let failSave = false;
  let savedItems: { product_id: string; qty: number; id: string; included_for_line_id?: string }[] = [];
  await page.route('**/api/categories**', route => route.fulfill({ json: [{ id: 'mixers', name: 'Mixers' }] }));
  await page.route('**/api/brands**', route => route.fulfill({ json: [{ id: 'brand', name: 'Fixture brand' }] }));
  await page.route('**/api/referrers', route => route.fulfill({ json: [] }));
  await page.route('**/api/quotations/recent?**', route => route.fulfill({ json: [] }));
  await page.route('**/api/customers', route => route.fulfill({ json: [{ id: 'client', name: 'Fixture customer' }] }));
  await page.route('**/api/products/families?**', route => route.fulfill({ json: { total: 1, items: [{ family_key: 'trim-family', family_name: product.name, brand_id: 'brand', category_id: 'mixers', min_price: product.price, sample_product_id: product.id, variants: [product] }] } }));
  await page.route('**/api/products?**', route => route.fulfill({ json: { total: 1, items: [body] } }));
  await page.route('**/api/products/trim', route => route.fulfill({ json: product }));
  await page.route('**/api/products/trim/alternates?**', route => route.fulfill({ json: { items: [] } }));
  await page.route('**/api/products/trim/complete-the-set?**', route => route.fulfill({ json: { items: [] } }));
  await page.route('**/api/products/trim/concealed-part', route => {
    expect(route.request().method()).toBe('PATCH');
    expect(route.request().headers()['x-floor-id']).toBe('first-floor');
    expect(route.request().postDataJSON()).toEqual({ product_id: 'body', sku: 'BODY-1', qty: 1 });
    saves++;
    if (failSave) return route.fulfill({ status: 422, json: { detail: 'Selected conceal part is no longer available for this SKU' } });
    product.concealed_part = { product_id: 'body', sku: body.sku, name: body.name, unit_price: body.price, mrp: body.mrp, qty: 1 };
    return route.fulfill({ json: product });
  });
  const mutations: string[] = [];
  let builderReads = 0;
  page.on('request', request => {
    const url = new URL(request.url());
    if (['/api/products/families', '/api/customers', '/api/brands', '/api/categories'].includes(url.pathname)) builderReads++;
  });
  await page.route(/\/api\/quotations(?:\/conceal-quote)?$/, route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: {
      id: 'conceal-quote', number: 'Q-CONCEAL', floor_id: 'first-floor', status: 'draft',
      customer_id: 'client', customer_name: 'Fixture customer', rooms: savedRooms,
      items: savedItems, subtotal: 900, grand_total: 900, created_at: '2026-10-11T00:00:00Z', updated_at: '2026-10-11T00:00:00Z',
    } });
    mutations.push(route.request().method());
    const payload = route.request().postDataJSON();
    savedItems = payload.items;
    savedRooms = payload.rooms;
    return route.fulfill({ json: { id: 'conceal-quote', number: 'Q-CONCEAL', updated_at: new Date().toISOString() } });
  });
  await page.goto(path);
  return { product, mutations: () => mutations, reads: () => builderReads, saves: () => saves, items: () => savedItems, reject: () => { failSave = true; } };
}

async function openPicker(page: Page) {
  await expect(page.getByTestId('quotation-details-toggle')).toBeVisible();
  const open = page.getByTestId('mobile-add-first');
  if (await open.isVisible()) await open.click();
  const dialog = page.getByRole('dialog', { name: 'Add products', exact: true });
  const picker = await dialog.isVisible() ? dialog : page;
  await expect(picker.getByTestId('product-card-TRIM-1')).toBeVisible();
  return picker;
}

async function reviewQuotation(page: Page) {
  await expect(page.getByTestId('quotation-details-toggle')).toBeVisible();
  const back = page.getByTestId('picker-view-quotation');
  if (await back.isVisible()) await back.click();
  const quotationTab = page.getByRole('tab', { name: /Quotation/ });
  if (await quotationTab.isVisible()) await quotationTab.click();
}

test('critical concealed choice persists and every later addition includes its quantity-linked part', async ({ page }) => {
  const fixture = await concealedFixture(page);
  const picker = await openPicker(page);
  await picker.getByRole('button', { name: 'View Wall mixer trim', exact: true }).click();
  await page.getByTestId('pm-conceal-sku').fill('BODY');
  await page.getByTestId('pm-conceal-option-BODY-1').click();
  await page.getByTestId('pm-qty-plus').click();
  await page.getByTestId('pm-add-close').click();
  await expect(page.getByTestId('pm-add-close')).not.toBeVisible();
  expect(fixture.saves()).toBe(1);
  // The existing card is patched without a reload; quick-add reuses the link.
  await picker.getByTestId('add-TRIM-1').click();
  await reviewQuotation(page);
  const qty = page.locator('[data-testid^="qty-trim-"]');
  await expect(qty).toHaveValue('3');
  await expect(page.getByText('Concealed body', { exact: true })).toBeVisible();
  await qty.fill('5');
  await qty.press('Tab');
  await page.getByTestId('quotation-details-toggle').click();
  await page.getByTestId('compact-hdr-customer').click();
  await page.getByTestId('customer-option-client').click();
  await expect.poll(() => fixture.items().map(item => [item.product_id, item.qty])).toEqual([['trim', 5], ['body', 5]]);
  expect(fixture.items()[1].included_for_line_id).toBe(fixture.items()[0].id);
  expect(fixture.saves()).toBe(1);
  await page.goto('/quotations/new?quotationId=conceal-quote');
  await reviewQuotation(page);
  await expect(qty).toHaveValue('5');
  await qty.fill('6');
  await qty.press('Tab');
  await expect.poll(() => fixture.items().map(item => [item.product_id, item.qty])).toEqual([['trim', 6], ['body', 6]]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('critical rejected concealed persistence keeps the selection and adds no incomplete product', async ({ page }) => {
  const fixture = await concealedFixture(page);
  fixture.reject();
  const picker = await openPicker(page);
  await picker.getByRole('button', { name: 'View Wall mixer trim', exact: true }).click();
  await page.getByTestId('pm-conceal-sku').fill('BODY');
  await page.getByTestId('pm-conceal-option-BODY-1').click();
  await page.getByTestId('pm-add-close').click();
  await expect(page.getByText('Selected conceal part is no longer available for this SKU', { exact: true })).toBeVisible();
  await expect(page.getByTestId('pm-conceal-sku')).toHaveValue('BODY-1');
  await expect(page.getByTestId('pm-add-close')).toBeEnabled();
  expect(fixture.saves()).toBe(1);
  expect(fixture.product.concealed_part).toBeNull();
  expect(fixture.items()).toEqual([]);
});

test('critical quotation view-only access blocks both builder modes before loading business dependencies', async ({ page }) => {
  const fixture = await concealedFixture(page, ['view']);
  await expect(page.getByTestId('quotation-builder-access-denied')).toContainText("You don't have access to create quotations.");
  expect(fixture.reads()).toBe(0);
  await page.goto('/quotations/new?quotationId=conceal-quote');
  await expect(page.getByTestId('quotation-builder-access-denied')).toContainText("You don't have access to edit this quotation.");
  expect(fixture.reads()).toBe(0);
  expect(fixture.mutations()).toEqual([]);
});

test('critical quotation create-only access recovers locally and submits once without denied updates', async ({ page }) => {
  const fixture = await concealedFixture(page, ['view', 'create']);
  const picker = await openPicker(page);
  await picker.getByRole('button', { name: 'View Wall mixer trim', exact: true }).click();
  await expect(page.getByTestId('pm-quotation-conceal')).toBeVisible();
  await expect(page.getByTestId('product-modal-edit')).toHaveCount(0);
  await expect(page.getByTestId('pm-godown-action')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close product details', exact: true }).click();
  await picker.getByTestId('add-TRIM-1').click();
  await reviewQuotation(page);
  await page.getByTestId('quotation-details-toggle').click();
  await page.getByTestId('compact-hdr-customer').click();
  await expect(page.getByTestId('open-create-customer')).toHaveCount(0);
  await expect(page.getByTestId('open-ground-floor-customers')).toHaveCount(0);
  await page.getByTestId('customer-option-client').click();
  await expect.poll(() => page.evaluate(() => {
    const raw = localStorage.getItem('forge.builder.draft.v1.conceal-viewer.first-floor');
    return raw ? raw.includes('TRIM-1') : false;
  })).toBe(true);
  // Reload after the local write exercises recovery beyond the server-save debounce.
  await page.reload();
  await expect(page.getByTestId('draft-recovery')).toBeVisible();
  await page.getByRole('button', { name: 'Restore draft', exact: true }).click();
  await expect(page.getByTestId('draft-recovery')).not.toBeVisible();
  await expect(page.locator('[data-testid^="qty-trim-"]')).toHaveValue('1');
  expect(fixture.mutations()).toEqual([]);
  await page.getByRole('button', { name: 'Finish and review quotation', exact: true }).click();
  await expect(page).toHaveURL(/\/quotations\/conceal-quote$/);
  expect(fixture.mutations()).toEqual(['POST']);
  await page.goto('/quotations/new?quotationId=conceal-quote');
  await expect(page.getByTestId('quotation-builder-access-denied')).toBeVisible();
  expect(fixture.mutations()).toEqual(['POST']);
});

test('critical quotation update-only access edits existing records without exposing new quotation or referrer creation', async ({ page }) => {
  const fixture = await concealedFixture(page, ['view', 'update']);
  await expect(page.getByTestId('quotation-builder-access-denied')).toBeVisible();
  expect(fixture.reads()).toBe(0);
  await page.goto('/quotations/new?quotationId=conceal-quote');
  await expect(page.getByTestId('quotation-builder-access-denied')).toHaveCount(0);
  const picker = await openPicker(page);
  await picker.getByTestId('add-TRIM-1').click();
  await reviewQuotation(page);
  await expect.poll(() => fixture.mutations()).toEqual(['PATCH']);
  await expect(page.getByTestId('rail-new-quote')).toHaveCount(0);
  await page.getByTestId('quotation-details-toggle').click();
  await page.getByTestId('compact-hdr-referrer').click();
  await expect(page.getByTestId('referrer-switcher-sheet')).toBeVisible();
  await expect(page.getByTestId('referrer-add-new')).toHaveCount(0);
  expect(fixture.items()[0].product_id).toBe('trim');
});

// The catalog's saved representative SKU must survive family-card adaptation.
// Reloading the picker catches a missing field that same-screen UI patching masks.
test('critical a concealed part saved in the catalog is included after loading a fresh builder', async ({ page }) => {
  const fixture = await concealedFixture(page);
  fixture.product.concealed_part = { product_id: 'body', sku: 'BODY-1', name: 'Concealed body', unit_price: 400, mrp: 450, qty: 1 };
  await page.reload();
  const picker = await openPicker(page);
  await picker.getByTestId('add-TRIM-1').click();
  await reviewQuotation(page);
  await expect(page.locator('[data-testid^="qty-trim-"]')).toHaveValue('1');
  await expect(page.getByText('Concealed body', { exact: true })).toBeVisible();
  expect(fixture.saves()).toBe(0);
});
