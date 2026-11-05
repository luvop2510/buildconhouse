import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

const image = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#987654"/></svg>')}`;
const glossy = { id: 'finish-glossy', sku: 'GLOSS', name: 'Crystal tile glossy', size: '600x600', finish: 'Glossy', price: 180, images: [image], specs: { rate_unit: 'pcs' } };
const matt = { id: 'finish-matt', sku: 'MATT', name: 'Crystal tile matt', size: '600x600', finish: 'Matt', price: 160, images: [image], specs: { rate_unit: 'pcs' }, variants: [{ ...glossy, image }] };

async function fixtures(page: any) {
  await mockSession(page, '/tiles/selection', false, { seedStorageOnce: true });
  await page.route('**/api/products?**', (route: any) => route.fulfill({ json: { items: [matt], total: 1 } }));
  await page.route('**/api/products/finish-matt', (route: any) => route.fulfill({ json: matt }));
  await page.route('**/api/products/finish-matt/size-variants', (route: any) => route.fulfill({ json: { available_sizes: [matt.size], product: matt } }));
  await page.route('**/api/products/finish-glossy/size-variants', (route: any) => route.fulfill({ json: { available_sizes: [glossy.size], product: { ...glossy, variants: [{ ...matt, image }] } } }));
  await page.route('**/api/quotations?**', (route: any) => route.fulfill({ json: [] }));
}

function rate(page: any) { return page.locator('[data-testid="tiles-rate-0"], [data-testid="tiles-offer-rate-0"], [data-testid="mobile-offerRate-0"]'); }
function finish(page: any) { return page.locator('[data-testid="tiles-finish-0"], [data-testid="mobile-tiles-finish-0"]'); }

test('critical imported piece price, optimistic finish and back navigation', async ({ page }) => {
  await fixtures(page);
  let release: () => void = () => {};
  const waiting = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/products/finish-glossy', async route => { await waiting; await route.fulfill({ json: glossy }); });
  await page.goto('/tiles/quotation');
  await page.getByRole('button', { name: 'Select a product', exact: true }).first().click();
  await page.getByTestId('tiles-picker-card-finish-matt').click();
  await expect(rate(page)).toHaveValue('160');
  await expect(finish(page)).toContainText('Matt');
  await finish(page).click();
  await page.getByRole('button', { name: 'Glossy', exact: true }).click();
  await expect(finish(page)).toContainText('Glossy');
  await expect(page.getByText('Updating rate…')).toBeVisible();
  release();
  await expect(rate(page)).toHaveValue('180');
  await expect(page.getByText('Updating rate…')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.getByTestId('tiles-back').click();
  await expect(page).toHaveURL(/\/tiles(?:\?.*)?$/);
});

test('critical older selection corrects recorded piece unit without changing the rate', async ({ page }) => {
  await fixtures(page);
  const doc = { id: 'legacy', number: 'T-1', doc_type: 'tiles_selection', floor_id: 'ground-floor', status: 'draft', customer_name: 'Customer', updated_at: '2026-11-01T00:00:00Z', items: [{ id: 'line', product_id: matt.id, sku: matt.sku, name: matt.name, image, size: matt.size, rate_sqft: 160, offer_rate: 160, rate_box: 160, qty: 1, quantity_unit: 'Box', price_basis: 'sqft' }] };
  await page.route(/\/api\/quotations\/legacy(?:\?.*)?$/, route => route.fulfill({ json: doc }));
  await page.goto('/tiles/selection?id=legacy');
  await expect(rate(page)).toHaveValue('160');
  await expect(finish(page)).toHaveCount(0);
});

test('critical offer changes replace a manually entered total', async ({ page }) => {
  await fixtures(page);
  const doc = { id: 'price-edit', number: 'T-2', doc_type: 'tiles_quotation', floor_id: 'ground-floor', status: 'draft', customer_name: 'Customer', updated_at: '2026-11-01T00:00:00Z', items: [{ id: 'line', product_id: matt.id, sku: matt.sku, name: matt.name, image, size: matt.size, offer_rate: 160, rate_box: 160, unit_price: 160, qty: 2, quantity_unit: 'Pieces', price_basis: 'piece' }] };
  await page.route(/\/api\/quotations\/price-edit(?:\?.*)?$/, route => route.fulfill({ json: doc }));
  await page.goto('/tiles/quotation?id=price-edit');
  const total = page.locator('[data-testid="tiles-total-0"], [data-testid="mobile-total-0"]');
  const offer = page.locator('[data-testid="tiles-offer-rate-0"], [data-testid="mobile-offerRate-0"]');
  await expect(total).toHaveValue('320');
  await total.fill('999');
  await offer.fill('180');
  await expect(total).toHaveValue('360');
});

test('critical staff names are selectable for document attribution', async ({ page }) => {
  await fixtures(page);
  await page.route('**/api/quotations/staff-names', route => route.fulfill({ json: [{ id: 'one', full_name: 'First Staff' }, { id: 'two', full_name: 'Second Staff' }] }));
  await page.goto('/tiles/selection');
  await expect(page.getByLabel('Reference', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Choose attended by' }).click();
  await page.getByRole('button', { name: 'Second Staff' }).click();
  await expect(page.getByLabel('Attended by', { exact: true })).toHaveValue('Second Staff');
  await page.getByRole('button', { name: 'Choose prepared by' }).click();
  await page.getByRole('button', { name: 'First Staff' }).click();
  await expect(page.getByLabel('Prepared by', { exact: true })).toHaveValue('First Staff');
});

test('critical finish selection restores the previous value if loading fails', async ({ page }) => {
  await fixtures(page);
  await page.route('**/api/products/finish-glossy', route => route.fulfill({ status: 503, json: { detail: 'Finish unavailable' } }));
  await page.goto('/tiles/quotation');
  await page.getByRole('button', { name: 'Select a product', exact: true }).first().click();
  await page.getByTestId('tiles-picker-card-finish-matt').click();
  await expect(finish(page)).toContainText('Matt');
  await finish(page).click();
  await page.getByRole('button', { name: 'Glossy', exact: true }).click();
  await expect(finish(page)).toContainText('Matt');
  await expect(rate(page)).toHaveValue('160');
  await expect(page.getByText('Finish unavailable', { exact: true })).toBeVisible();
});

test('critical mobile selection scrolls down and back up over product fields', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await fixtures(page);
  const items = Array.from({ length: 8 }, (_, i) => ({ id: `line-${i}`, product_id: matt.id, sku: matt.sku, name: `Tile ${i + 1}`, image, size: matt.size, rate_sqft: 160, qty: 1, quantity_unit: 'Box' }));
  await page.route(/\/api\/quotations\/long-selection(?:\?.*)?$/, route => route.fulfill({ json: { id: 'long-selection', doc_type: 'tiles_selection', status: 'draft', customer_name: 'Customer', updated_at: '2026-11-01T00:00:00Z', items } }));
  await page.goto('/tiles/selection?id=long-selection');
  const scroll = page.getByTestId('tiles-mobile-editor-scroll');
  await expect(page.getByTestId('mobile-name-0')).toHaveValue('Tile 1');
  await page.getByTestId('mobile-name-0').hover();
  await page.mouse.wheel(0, 2000);
  await expect.poll(() => scroll.evaluate(node => node.scrollTop)).toBeGreaterThan(500);
  await page.getByTestId('mobile-name-4').hover();
  const before = await scroll.evaluate(node => node.scrollTop);
  await page.mouse.wheel(0, -1500);
  await expect.poll(() => scroll.evaluate(node => node.scrollTop)).toBeLessThan(before);
});

test('critical touch gestures scroll a long selection in both directions', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 700 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await fixtures(page);
  const items = Array.from({ length: 8 }, (_, i) => ({ id: `touch-${i}`, product_id: matt.id, sku: matt.sku, name: `Tile ${i + 1}`, image, size: matt.size, rate_sqft: 160, qty: 1, quantity_unit: 'Box' }));
  await page.route(/\/api\/quotations\/touch-selection(?:\?.*)?$/, route => route.fulfill({ json: { id: 'touch-selection', doc_type: 'tiles_selection', status: 'draft', customer_name: 'Customer', updated_at: '2026-11-01T00:00:00Z', items } }));
  await page.goto('/tiles/selection?id=touch-selection');
  const scroll = page.getByTestId('tiles-mobile-editor-scroll');
  await expect(page.getByTestId('mobile-name-0')).toHaveValue('Tile 1');
  const cdp = await context.newCDPSession(page);
  async function swipe(start: number, end: number) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 200, y: start }] });
    for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 200, y: start + (end - start) * i / 8 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  await swipe(450, 180);
  await expect.poll(() => scroll.evaluate(node => node.scrollTop)).toBeGreaterThan(100);
  const before = await scroll.evaluate(node => node.scrollTop);
  await swipe(180, 450);
  await expect.poll(() => scroll.evaluate(node => node.scrollTop)).toBeLessThan(before);
  await context.close();
});
