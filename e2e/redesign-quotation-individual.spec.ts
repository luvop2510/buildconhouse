import { expect, test, type Page } from '@playwright/test';
import { mockSession } from './audit-fixtures';

async function individualQuotation(page: Page) {
  await mockSession(page, '/quotations/new', false);
  let document: any = {
    id: 'q-individual', number: 'Q-INDIVIDUAL', customer_id: 'customer-one', customer_name: 'Individual customer', status: 'draft', floor_id: 'first-floor',
    rooms: ['Master Bath'], collapsed_rooms: [], updated_at: '2026-10-13T10:00:00Z',
    project_discount_pct: 5, category_discounts: {}, room_discounts: {},
    items: [
      { id: 'line-old', product_id: 'old', sku: 'OLD', name: 'Saved basin', room: 'Master Bath', area: 'Existing area', category_id: 'basins', qty: 2, unit_price: 100, discount_pct: 10 },
      { id: 'line-part', product_id: 'part', sku: 'PART', name: 'Included mounting', room: 'Master Bath', area: 'Existing area', category_id: 'basins', qty: 2, unit_price: 0, discount_pct: null, included_for_line_id: 'line-old', included_qty_per_parent: 1 },
    ],
  };
  await page.route('**/api/categories**', r => r.fulfill({ json: [{ id: 'basins', name: 'Basins' }] }));
  await page.route('**/api/brands**', r => r.fulfill({ json: [{ id: 'brand-one', name: 'Fixture brand', product_count: 2 }] }));
  await page.route('**/api/products/**', r => r.fulfill({ json: { total: 2, items: ['A', 'B'].map((sku, index) => ({
    family_key: sku, family_name: `Individual product ${sku}`, category_id: 'basins', brand_id: 'brand-one', min_price: (index + 1) * 100,
    variants: [{ id: `product-${sku}`, sku, name: `Individual product ${sku}`, price: (index + 1) * 100, mrp: (index + 1) * 100, stock: 2 }],
  })) } }));
  await page.route('**/api/customers**', r => r.fulfill({ json: [{ id: 'customer-one', name: 'Individual customer' }] }));
  await page.route('**/api/quotations/recent?**', r => r.fulfill({ json: [] }));
  await page.route(/\/api\/quotations\/q-individual(?:\?.*)?$/, async r => {
    if (r.request().method() === 'PATCH') document = { ...document, ...r.request().postDataJSON() };
    await r.fulfill({ json: document });
  });
  await page.goto('/quotations/new?quotationId=q-individual');
  await expect(page.getByTestId('line-drag-line-old')).toBeAttached();
  return () => document;
}

async function showLines(page: Page) {
  const review = page.getByTestId("mobile-review-quotation");
  if (await review.isVisible()) await review.click();
  const tab = page.getByRole('tab', { name: /Quotation ·/ });
  if (await tab.isVisible()) await tab.click();
  await expect(page.getByTestId('qty-line-old')).toBeVisible();
}

test('critical quotation has individual product editing without line multi-select or batch area assignment', async ({ page }) => {
  await individualQuotation(page);
  await showLines(page);
  await expect(page.getByTestId('quotation-area-grouping')).toHaveCount(0);
  await expect(page.locator('[data-testid^="area-select-"]')).toHaveCount(0);
  await expect(page.getByTestId('apply-area')).toHaveCount(0);
  await expect(page.getByTestId('line-area-line-old')).toHaveValue('Existing area');
});

test('critical saved quotation individual adds edits discounts autosave and reload preserve all lines and areas', async ({ page }) => {
  const saved = await individualQuotation(page);
  const addFirst = page.getByTestId('mobile-add-first');
  if (await addFirst.isVisible()) {
    await addFirst.click();
    const picker = page.getByRole('dialog', { name: 'Add products', exact: true });
    await expect(picker).toBeVisible();
    await picker.getByTestId('add-A').click();
    await picker.getByTestId('add-B').click();
    await picker.getByTestId('picker-view-quotation').click();
  } else {
    await page.getByTestId('add-A').click();
    await page.getByTestId('add-B').click();
  }
  await showLines(page);
  const quantity = page.getByTestId('qty-line-old');
  await quantity.fill('3');
  await quantity.press('Tab');
  const area = page.getByTestId('line-area-line-old');
  await area.fill('Revised area');
  await area.press('Tab');
  await page.getByTestId('disc-line-old').click();
  await page.getByTestId('line-disc-input').fill('20');
  await expect(page.getByTestId('line-disc-input')).toHaveValue('20');
  await page.getByTestId('apply-discount').click();
  await expect.poll(() => saved().items.length).toBe(4);
  await expect.poll(() => saved().items.find((line: any) => line.id === 'line-old')?.discount_pct).toBe(20);
  const parent = saved().items.find((line: any) => line.id === 'line-old');
  const part = saved().items.find((line: any) => line.id === 'line-part');
  expect(parent).toMatchObject({ qty: 3, area: 'Revised area', discount_pct: 20 });
  expect(part).toMatchObject({ qty: 3, area: 'Revised area', included_for_line_id: 'line-old' });
  // Product override 20% wins; the two individual additions inherit project 5%.
  expect(saved().items.reduce((sum: number, line: any) => sum + line.qty * line.unit_price, 0)).toBe(600);
  expect(saved().project_discount_pct).toBe(5);
  await expect(page.getByText('₹525.00', { exact: true }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('line-drag-line-old')).toBeAttached();
  await showLines(page);
  await expect(page.getByTestId('qty-line-old')).toHaveValue('3');
  await expect(page.getByTestId('line-area-line-old')).toHaveValue('Revised area');
  await expect(page.getByTestId('line-area-line-part')).toHaveValue('Revised area');
  await expect(page.getByTestId('line-area-line-part')).not.toBeEditable();
  expect(saved().items.map((line: any) => line.sku)).toEqual(['OLD', 'PART', 'A', 'B']);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});
