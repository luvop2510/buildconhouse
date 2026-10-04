import { expect, test, type Page } from '@playwright/test';
import { mockSession } from './audit-fixtures';

async function quotationSession(page: Page) {
  await mockSession(page, '/quotations/new', false);
  await page.route('**/api/categories**', r => r.fulfill({ json: [{ id: 'basins', name: 'Basins' }] }));
  await page.route('**/api/brands**', r => r.fulfill({ json: [{ id: 'brand-one', name: 'Fixture brand' }] }));
  await page.route('**/api/quotations/recent?**', r => r.fulfill({ json: [] }));
  await page.route('**/api/products/families?**', r => r.fulfill({ json: { total: 12, items: Array.from({ length: 12 }, (_, index) => ({
    family_key: `basin-${index}`, family_name: `Basin ${index + 1}`, category_id: 'basins', brand_id: 'brand-one', min_price: 1600,
    variants: [{ id: `basin-${index}`, sku: `B-${index}`, name: `Basin ${index + 1}`, price: 1600, mrp: 1600, stock: 2, finish: 'White' }],
  })) } }));
}

test('critical tablet quotation picker shows at least five complete products and an accessible PDF action', async ({ page }, info) => {
  const width = page.viewportSize()!.width;
  test.skip(width < 768 || width > 1024, 'Tablet portrait and landscape regression');
  await quotationSession(page);
  await page.goto('/quotations/new');
  await page.getByTestId('mobile-add-first').click();
  const picker = page.getByRole('dialog', { name: 'Add products', exact: true });
  await expect(picker).toBeVisible();
  const cards = picker.locator('[data-testid^="product-card-"]');
  await expect(cards).toHaveCount(12);
  // Count whole cards inside the actual scrolling grid, not merely mounted
  // FlatList items (which may be partially clipped or below the viewport).
  await expect.poll(() => cards.evaluateAll(elements => elements.filter(element => {
    const box = element.getBoundingClientRect();
    if (box.width < 100 || box.height < 200 || box.left < 0 || box.right > innerWidth || box.bottom > innerHeight) return false;
    let parent = element.parentElement;
    while (parent) {
      const style = getComputedStyle(parent);
      if (/auto|scroll|hidden/.test(style.overflowY)) {
        const frame = parent.getBoundingClientRect();
        if (box.top < frame.top - 1 || box.bottom > frame.bottom + 1) return false;
      }
      parent = parent.parentElement;
    }
    return box.top >= 0;
  }).length)).toBeGreaterThanOrEqual(5);
  await page.screenshot({ path: info.outputPath('quotation-tablet-picker.png') });
  await picker.getByTestId('add-B-0').click();
  await picker.getByTestId('picker-view-quotation').click();
  await expect(page.getByRole('button', { name: 'Download quotation PDF', exact: true })).toBeVisible();
  await page.getByTestId('generate-quotation').click();
  await expect(page.getByTestId('quotation-pdf-options')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('critical iPad desktop browser downloads the quotation PDF with dimensions and its document floor', async ({ page }) => {
  await page.setViewportSize({ width: 834, height: 1112 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Safari/605.1.15' });
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' });
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 5 });
  });
  await mockSession(page, '/quotations/q-tablet', false);
  await page.route('**/api/quotations/q-tablet', r => r.fulfill({ json: {
    id: 'q-tablet', number: 'Q-TABLET', customer_name: 'Tablet Customer', status: 'ordered', floor_id: 'first-floor',
    items: [], rooms: [], subtotal: 1200, discount_total: 0, grand_total: 1200,
    created_at: '2026-10-01T10:00:00Z', created_by_name: 'Audit Owner',
  } }));
  await page.route('**/api/quotations/q-tablet/breakdown', r => r.fulfill({ json: { lines: [], totals: { subtotal: 1200, discount_total: 0, grand_total: 1200 }, project_discount_pct: 0, category_discounts: {} } }));
  await page.route('**/api/activity/quotation/q-tablet', r => r.fulfill({ json: [] }));
  await page.route('**/api/purchase-orders?quotation_id=q-tablet', r => r.fulfill({ json: [] }));
  await page.route('**/api/quotations/q-tablet/pdf?**', r => r.fulfill({
    contentType: 'application/pdf', headers: { 'Content-Disposition': 'attachment; filename="Tablet Customer.pdf"' }, body: '%PDF-1.4\n%%EOF',
  }));
  await page.goto('/quotations/q-tablet');
  await page.getByTestId('download-pdf').click();
  const request = page.waitForRequest('**/api/quotations/q-tablet/pdf?**');
  await page.getByTestId('detail-pdf-include-dimensions').click();
  const fetched = await request;
  expect(fetched.url()).toContain('include_dimensions=true');
  expect(fetched.headers()['x-floor-id']).toBe('first-floor');
  await expect(page.getByTestId('mobile-file-save')).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByTestId('mobile-file-download').click();
  expect((await download).suggestedFilename()).toBe('Tablet Customer.pdf');
});
