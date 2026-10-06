import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

const tileImage = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="200"><rect x="10" y="5" width="80" height="190" fill="#937458"/></svg>')}`;

for (const kind of ['customer', 'supplier'] as const) {
  test(`critical tile ${kind} purchases preserve current product photos and operational controls`, async ({ page }, info) => {
    const path = kind === 'customer' ? '/tiles/orders/image-order' : '/tiles/orders/po/image-po';
    await mockSession(page, path, false);
    const identity = { product_id: 'tile-one', image: tileImage, series: 'Natural Stone', finish: 'Matt', size: '600 × 1200', sku: 'T-101', quantity_unit: 'Box', current_location: 'Ready', overall_status: 'Ready' };
    if (kind === 'customer') {
      await page.route('**/api/tile-orders/customer-orders/image-order', route => route.fulfill({ json: {
        summary: { id: 'image-order', number: 'TO-101', customer_name: 'Tile photo customer', order_date: '2026-10-01T10:00:00Z', brand_count: 1, total_products: 2, total_boxes: 10, completion_percentage: 0, waiting_days: 4, ageing_band: 'green', overall_status: 'Ready' },
        suppliers: [{ purchase_order_id: 'image-po', supplier_name: 'Tile Supplier', brand_id: 'brand-one', brand_name: 'Tile Brand', overall_status: 'Ready', items: [
          { ...identity, po_item_id: 'tile-one', tile_name: 'Portrait floor tile', boxes_ordered: 10, boxes_ready: 6, boxes_godown: 0, boxes_dispatched: 0, boxes_pending: 4 },
          { ...identity, product_id: 'tile-two', image: null, po_item_id: 'tile-two', tile_name: 'Tile without photo', boxes_ordered: 1, boxes_ready: 0, boxes_godown: 0, boxes_dispatched: 0, boxes_pending: 1 },
        ] }],
      } }));
    } else {
      await page.route('**/api/tile-orders/purchase-orders/image-po', route => route.fulfill({ json: {
        id: 'image-po', number: 'PO-101', customer_name: 'Tile photo customer', supplier_name: 'Tile Supplier', brand_id: 'brand-one', brand_name: 'Tile Brand', overall_status: 'Ready', delivery_name: 'Tile photo customer', delivery_phone: '', delivery_address: '', delivery_city: '', items: [
          { ...identity, id: 'tile-one', name: 'Portrait floor tile', qty: 10, boxes_ready: 6, boxes_godown: 0, boxes_dispatched: 0, boxes_pending: 4 },
          { ...identity, product_id: 'tile-two', image: null, id: 'tile-two', name: 'Tile without photo', qty: 1, boxes_ready: 0, boxes_godown: 0, boxes_dispatched: 0, boxes_pending: 1 },
        ],
      } }));
    }
    await page.goto(path);
    const frame = page.getByTestId(`tile-${kind}-product-image-tile-one`);
    await expect(frame).toBeVisible();
    // Expo Image can retain the previous image while crossfading. Verify the
    // exact current product source so a stale image cannot satisfy this test.
    const currentImage = frame.locator(`img[src=${JSON.stringify(tileImage)}]`);
    await expect(currentImage).toHaveCount(1);
    await expect(currentImage).toBeVisible();
    await expect(currentImage).toHaveCSS('object-fit', 'contain');
    const bounds = await frame.boundingBox();
    expect(bounds!.width).toBe(96);
    expect(bounds!.height).toBe(60);
    const imageBounds = await currentImage.boundingBox();
    expect(imageBounds!.width).toBeCloseTo(bounds!.width, 0);
    expect(imageBounds!.height).toBeCloseTo(bounds!.height, 0);
    await expect(page.getByTestId(`tile-${kind}-product-image-tile-two`).locator('img')).toHaveCount(0);
    const control = page.getByTestId(kind === 'customer' ? 'tile-order-dispatch-released-tile-one' : 'tile-release-quantity-tile-one');
    await expect(control).toBeVisible();
    await expect(control).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`tile-${kind}-purchase-images-${page.viewportSize()!.width}.png`), animations: 'disabled' });
  });
}
