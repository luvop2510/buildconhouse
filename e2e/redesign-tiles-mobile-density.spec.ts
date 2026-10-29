import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

const image = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#987654"/></svg>')}`;
const product = { id: 'compact-tile', name: 'Natural stone floor tile', sku: 'NAT-600', brand_name: 'Tile Brand', size: '600 × 600', price: 100, images: [image] };

for (const width of [320, 390]) for (const kind of ['selection', 'quotation'] as const) {
  test(`critical tiles ${kind} keeps compact readable product rows on ${width}px phones`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 });
    const path = `/tiles/${kind}?id=compact-document`;
    await mockSession(page, path, false);
    let document: any = {
      id: 'compact-document', number: 'T-COMPACT', doc_type: `tiles_${kind}`, floor_id: 'ground-floor', status: 'draft',
      customer_id: 'compact-customer', customer_name: 'Tile Customer', address_snapshot: 'Project site',
      subtotal: 1000, grand_total: 1000, transportation_fee: 0, updated_at: '2026-10-30T00:00:00Z',
      items: [{ id: 'compact-line', product_id: product.id, name: product.name, sku: product.sku, image, room: 'Bathroom', size: product.size, rate_sqft: 50, rate_box: 100, qty: 10, quantity_unit: 'Box', net_amount: 1000 }],
    };
    const saves: any[] = [];
    await page.route(/\/api\/quotations\/compact-document(?:\?.*)?$/, route => {
      if (route.request().method() === 'PATCH') {
        saves.push(route.request().postDataJSON());
        document = { ...document, ...saves.at(-1), updated_at: '2026-10-30T00:01:00Z' };
      }
      return route.fulfill({ json: document });
    });
    await page.route('**/api/products/compact-tile/size-variants', route => route.fulfill({ json: { available_sizes: [product.size] } }));
    await page.route('**/api/products?**', route => route.fulfill({ json: { items: [product], total: 1 } }));
    await page.goto(path);
    const row = page.getByTestId('mobile-row-0');
    const name = page.getByTestId('mobile-name-0');
    await expect(name).toHaveValue(product.name);
    const rowBounds = (await row.boundingBox())!;
    console.log(`Tile density ${kind} ${width}px: ${Math.round(rowBounds.height)}px row`);
    const thumb = page.getByTestId('mobile-thumb-0');
    await expect.poll(async () => (await thumb.boundingBox())?.width ?? Infinity).toBeLessThanOrEqual(96);
    await expect(name).toHaveAccessibleName('Product name for item 1');
    await expect(name).toHaveCSS('font-size', '16px');
    expect(rowBounds.height).toBeLessThan(kind === 'selection' ? width === 320 ? 460 : 360 : width === 320 ? 900 : 680);
    const rate = page.getByTestId('mobile-rateSqft-0');
    if (width === 390) {
      const size = await row.getByText(product.size, { exact: true }).boundingBox();
      const rateBounds = await rate.boundingBox();
      expect(rateBounds!.x).toBeGreaterThan(size!.x + 80);
    }
    await rate.fill('55');
    await expect.poll(() => saves.at(-1)?.items?.[0]?.rate_sqft).toBe(55);
    expect(saves.at(-1).items[0].product_id).toBe(product.id);
    await thumb.click();
    const search = page.getByRole('textbox', { name: 'Search tile catalog', exact: true });
    await expect(search).toBeVisible();
    await expect(search).toHaveCSS('font-size', '16px');
    const card = page.getByTestId('tiles-picker-card-compact-tile');
    await expect(card).toBeVisible();
    const cardImage = (await card.locator('img').boundingBox())!;
    expect(cardImage.width).toBeLessThanOrEqual(96);
    await page.getByRole('button', { name: 'Close catalog', exact: true }).click();
    await expect(rate).toHaveValue('55');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`tiles-${kind}-${width}-compact.png`) });
  });
}
