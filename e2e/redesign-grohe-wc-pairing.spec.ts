import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

type QuoteLine = {
  id: string; product_id: string; sku: string; qty: number; mrp: number; unit_price: number;
  image: string; included_for_line_id?: string; included_part_role?: string;
};

test('critical GROHE WC groups a separately priced cover and keeps an independent cover on removal', async ({ page, baseURL }) => {
  await mockSession(page, '/quotations/new', false, { floorId: 'first-floor' });
  const photo = (sku: string) => new URL(`/grohe-test-photo/${sku}.svg`, baseURL).href;
  await page.route('**/grohe-test-photo/*.svg', route => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="white"/></svg>',
  }));
  const product = (sku: string, name: string, rate: number, specs: Record<string, unknown> = {}) => ({
    id: sku, sku, name, price: rate, mrp: rate, stock: 1, floor_id: 'first-floor',
    colour: 'White', finish: 'White', brand_id: 'grohe', category_id: 'wc',
    image: photo(sku), images: [photo(sku)], hero_image_url: photo(sku), specs,
  });
  const cover = product('39577001', 'Essence Soft-Close Seat Cover', 8730);
  const wc = product('105536SH00', 'Essence WC without Seat Cover', 36270, {
    default_included_parts: [{
      role: 'seat_cover', product_id: cover.id, sku: cover.sku, name: cover.name, qty: 1,
      mrp: cover.mrp, unit_price: cover.price, category_id: cover.category_id,
      finish: cover.finish, image: cover.image,
    }],
  });
  const included = product('103848SH00', 'Start Round WC with Seat Cover', 20000, { availability: 'Coming Soon' });
  const products = [wc, cover, included];
  let items: QuoteLine[] = [];
  let cancelled = 0;
  let updatedAt = new Date().toISOString();
  const savedQuotation = () => ({
    id: 'grohe-fixture', number: 'Q-GROHE', customer_id: 'customer', customer_name: 'GROHE fixture buyer',
    floor_id: 'first-floor', status: 'draft', rooms: ['Bathroom'], items, project_discount_pct: 10,
    updated_at: updatedAt,
  });
  await page.route('**/api/categories**', route => route.fulfill({ json: [{ id: 'wc', name: 'WC' }] }));
  await page.route('**/api/brands**', route => route.fulfill({ json: [{ id: 'grohe', name: 'GROHE' }] }));
  await page.route('**/api/customers**', route => route.fulfill({ json: [{ id: 'customer', name: 'GROHE fixture buyer' }] }));
  await page.route('**/api/quotations/recent?**', route => route.fulfill({ json: [] }));
  await page.route('**/api/products/families?**', route => route.fulfill({ json: {
    total: products.length,
    items: products.map(p => ({
      family_key: p.id, family_name: p.name, brand_id: p.brand_id, category_id: p.category_id,
      min_price: p.price, sample_product_id: p.id, sample_image: p.image, variants: [p],
    })),
  } }));
  await page.route(/\/api\/quotations\/grohe-fixture(?:\?.*)?$/, route => {
    if (route.request().method() === 'PATCH') {
      items = route.request().postDataJSON().items;
      updatedAt = new Date().toISOString();
    }
    return route.fulfill({ json: savedQuotation() });
  });
  await page.route(/\/api\/quotations\/grohe-fixture\/items\/[^/]+\/cancel$/, route => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2)!);
    expect(items.find(item => item.id === id)?.sku).toBe(wc.sku);
    items = items.filter(item => item.id !== id && item.included_for_line_id !== id);
    updatedAt = new Date().toISOString();
    cancelled++;
    return route.fulfill({ json: savedQuotation() });
  });

  await page.goto('/quotations/new?quotationId=grohe-fixture');
  await expect(page.getByTestId('quotation-workspace')).toBeVisible();
  const exitFullscreen = page.getByTestId('expand-quotation-workspace');
  if (await exitFullscreen.isVisible()) await exitFullscreen.click();
  const addFirst = page.getByTestId('mobile-add-first');
  if (await addFirst.isVisible()) await addFirst.click();
  const dialog = page.getByRole('dialog', { name: 'Add products', exact: true });
  const picker = (await dialog.isVisible()) ? dialog : page;
  await expect(picker.getByTestId(`product-card-${included.sku}`)).toContainText('Coming Soon');
  await picker.getByTestId(`add-${cover.sku}`).click();
  await picker.getByTestId(`add-${wc.sku}`).dblclick();
  await picker.getByTestId(`add-${included.sku}`).click();
  const back = picker.getByTestId('picker-view-quotation');
  if (await back.isVisible()) await back.click();
  const review = page.getByTestId('mobile-review-quotation');
  if (await review.isVisible()) await review.click();
  const tab = page.getByRole('tab', { name: /Quotation ·/ });
  if (await tab.isVisible()) await tab.click();

  await expect.poll(() => items.length).toBe(4);
  const parent = items.find(item => item.sku === wc.sku)!;
  const linked = items.find(item => item.included_for_line_id === parent.id)!;
  expect(linked).toMatchObject({ product_id: cover.id, qty: 1, mrp: 8730, unit_price: 8730, image: cover.image, included_part_role: 'seat_cover' });
  expect(items.find(item => item.sku === included.sku)).toMatchObject({ availability: 'Coming Soon' });
  const quantity = page.getByTestId(`qty-${parent.id}`);
  await quantity.fill('3');
  await quantity.press('Tab');
  await expect.poll(() => items.find(item => item.id === linked.id)?.qty).toBe(3);
  await expect(page.getByTestId(`wc-combination-${parent.id}`)).toContainText('Combined MRP ₹1,35,000.00');
  await expect(page.getByTestId(`wc-combination-${parent.id}`)).toContainText('Quoted total ₹1,21,500.00');

  const actions = page.getByTestId('builder-actions');
  if (await actions.isVisible()) await actions.click();
  await page.getByRole('button', { name: 'Preview quotation', exact: true }).click();
  const preview = page.getByTestId('quotation-preview-sheet');
  await expect(preview).toContainText('Linked seat cover');
  await expect(preview).toContainText(wc.sku);
  await expect(preview).toContainText(cover.sku);
  await expect(preview.getByTestId(`quotation-preview-photo-${linked.id}`).locator('img').first()).toHaveAttribute('src', cover.image);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('forge.builder.draft.v1.audit-owner.first-floor'))).toBeNull();
  await page.reload();
  await expect(page.getByTestId('quotation-workspace')).toBeVisible();
  if (await exitFullscreen.isVisible()) await exitFullscreen.click();
  if (await review.isVisible()) await review.click();
  if (await tab.isVisible()) await tab.click();
  await expect(quantity).toHaveValue('3');
  await page.getByTestId(`line-cancel-${parent.id}`).click();
  await page.getByTestId(`confirm-cancel-line-${parent.id}-confirm`).click();
  await expect.poll(() => cancelled).toBe(1);
  await expect(quantity).toHaveCount(0);
  expect(items.map(({ sku, qty }) => [sku, qty])).toEqual([[cover.sku, 1], [included.sku, 1]]);
});
