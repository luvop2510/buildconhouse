import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

// All data and writes are intercepted: these release checks never touch ERP
// records. A portrait source catches accidental sanitary-product cropping.
const image = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="200"><rect x="15" y="5" width="70" height="190" fill="#8B7253"/></svg>')}`;
const products = Array.from({ length: 8 }, (_, index) => ({
  id: `tile-${index}`, name: `Stone tile ${index + 1}`, sku: `T-${index + 1}`,
  brand_name: 'Tile Brand', size: '600 × 600', price: 100, images: [image],
}));

  for (const kind of ['selection', 'quotation'] as const) {
    test(`critical tablet tiles ${kind} keeps bounded images, editable fields and six visible choices`, async ({ page }, info) => {
      const viewport = page.viewportSize()!;
      test.skip(viewport.width < 768 || viewport.width >= 1366, 'Tablet layout check');
      await mockSession(page, `/tiles/${kind}`, false);
      const doc = {
        id: 'tile-doc', number: 'TQ-100', doc_type: `tiles_${kind}`, status: 'draft',
        customer_id: 'tile-customer', customer_name: 'Tile Customer', phone_snapshot: '9000000000', address_snapshot: 'Project site',
        subtotal: 1000, grand_total: 1000, transportation_fee: 0,
        items: [{ id: 'line-one', product_id: 'tile-0', sku: 'T-1', name: 'Stone tile 1', image, room: 'Bathroom', size: '600 × 600', rate_sqft: 50, rate_box: 100, qty: 10, quantity_unit: 'Box', net_amount: 1000 }],
      };
      const saves: any[] = [];
      await page.route(/\/api\/quotations\/tile-doc(?:\?.*)?$/, route => {
        if (route.request().method() === 'PATCH') saves.push(route.request().postDataJSON());
        return route.fulfill({ json: doc });
      });
      await page.route('**/api/products?**', route => route.fulfill({ json: { items: products, total: products.length } }));
      await page.route('**/api/products/tile-0/size-variants', route => route.fulfill({ json: { available_sizes: ['600 × 600'] } }));
      // Exercise the quotationId alias used by external order/payment entry
      // points, as well as a saved document rather than a new blank editor.
      await page.goto(`/tiles/${kind}?quotationId=tile-doc`);
      await expect(page.getByTestId('mobile-name-0')).toHaveValue('Stone tile 1');
      const thumb = page.getByTestId('mobile-thumb-0');
      // React Native publishes container layout separately from restored data.
      // Wait for the measured tablet layout, keeping the same image budget.
      await expect.poll(async () => (await thumb.boundingBox())?.width ?? Infinity).toBeLessThanOrEqual(160);
      const bounds = await thumb.boundingBox();
      expect(bounds!.width).toBeLessThanOrEqual(160);
      expect(bounds!.height).toBeLessThanOrEqual(100);
      expect((await page.getByTestId('mobile-row-0').boundingBox())!.height).toBeLessThan(kind === 'selection' ? 320 : 520);
      const area = await page.getByTestId('mobile-area-0').boundingBox();
      const size = await page.getByTestId('mobile-row-0').getByText('600 × 600', { exact: true }).boundingBox();
      expect(size!.x).toBeGreaterThan(area!.x + 100);
      await page.getByTestId('mobile-rateSqft-0').fill('55');
      await expect.poll(() => saves.length).toBeGreaterThan(0);
      expect(saves.at(-1).items[0]).toMatchObject({ product_id: 'tile-0', rate_sqft: 55 });
      await thumb.click();
      const cards = page.locator('[data-testid^="tiles-picker-card-"]');
      await expect(cards).toHaveCount(8);
      for (let index = 0; index < 6; index++) await expect(cards.nth(index)).toBeInViewport();
      const first = await cards.nth(0).boundingBox();
      const third = await cards.nth(2).boundingBox();
      expect(third!.y).toBe(first!.y);
      expect(first!.width).toBeLessThanOrEqual(240);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: info.outputPath(`tiles-${kind}-picker-${viewport.width}.png`), animations: 'disabled' });
    });
  }

  test(`critical tablet purchases shows entire product images and usable controls`, async ({ page }, info) => {
    const viewport = page.viewportSize()!;
    test.skip(viewport.width < 768 || viewport.width >= 1366, 'Tablet layout check');
    await mockSession(page, '/purchases', false);
    const item = {
      item_id: 'item-one', po_id: 'po-one', po_number: 'PO-100', product_id: 'sanitary-one', sku: 'S-100', name: 'Tall bathroom tap', image,
      customer_id: 'customer-one', customer_name: 'Customer One', brand_id: 'brand-one', brand_name: 'Bathroom Brand',
      stage: 'in_box', stage_label: 'In Box', stage_tone: { bg: '#eeeeee', fg: '#222222' },
      qty: 2, unit_cost: 100, last_moved_at: '2026-10-01T10:00:00Z', age_days: 3, blocked: false, sla_days: 7,
    };
    await page.route('**/api/purchases/items/page?**', route => route.fulfill({ json: { items: [item, { ...item, item_id: 'item-two' }], total: 2, next_skip: null, has_more: false, summaries: { sla_days: 7, blocked_count: 0, stage_counts: { in_box: 2 } } } }));
    await page.route('**/api/purchases/brands', route => route.fulfill({ json: { all: 2, brands: [] } }));
    await page.route('**/api/purchases/stages', route => route.fulfill({ json: [] }));
    await page.route('**/api/purchases/shortages?**', route => route.fulfill({ json: { items: [] } }));
    await page.goto('/purchases');
    const thumb = page.getByTestId('purchase-image-item-one');
    await expect(thumb).toBeVisible();
    const bounds = await thumb.boundingBox();
    expect(bounds!.width).toBeGreaterThan(180);
    expect(bounds!.height).toBe(120);
    await expect(thumb.locator('img')).toHaveCSS('object-fit', 'contain');
    const second = await page.getByTestId('purchase-image-item-two').boundingBox();
    expect(second!.x).toBeGreaterThan(bounds!.x);
    expect(second!.y).toBe(bounds!.y);
    await page.getByRole('button', { name: 'Actions for Tall bathroom tap', exact: true }).first().click();
    await expect(page.getByRole('button', { name: 'Movement history', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`purchases-tablet-${viewport.width}.png`), animations: 'disabled' });
  });
