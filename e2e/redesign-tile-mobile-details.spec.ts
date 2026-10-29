import { expect, test, type Page } from '@playwright/test';
import { mockSession } from './audit-fixtures';

async function order(page: Page) {
  await mockSession(page, '/tiles/orders/mobile-detail', false);
  await page.route('**/api/tile-orders/customer-orders/mobile-detail', route => route.fulfill({ json: {
    summary: { id: 'mobile-detail', number: 'TO-101', customer_name: 'Mobile order customer', order_date: '2026-10-01T10:00:00Z', brand_count: 1, total_products: 12, total_boxes: 120, completion_percentage: 0, waiting_days: 4, ageing_band: 'green', overall_status: 'Ready' },
    suppliers: [{ purchase_order_id: 'mobile-po', supplier_name: 'Tile Supplier', brand_id: 'brand-one', brand_name: 'Tile Brand', overall_status: 'Ready', items: Array.from({ length: 12 }, (_, index) => ({
      po_item_id: `line-${index}`, tile_name: `Premium floor tile ${index}`, series: 'Natural Stone', finish: 'Matt', size: '600 × 1200', sku: `SKU-${index}`, quantity_unit: 'Box', current_location: 'Ready', overall_status: 'Ready', boxes_ordered: 10, boxes_ready: 6, boxes_godown: 2, boxes_dispatched: 1, boxes_pending: 1,
    })) }],
  } }));
  await page.route('**/api/tile-orders/customer-orders/mobile-detail/timeline', route => route.fulfill({ json: {
    events: Array.from({ length: 30 }, (_, index) => ({ id: `event-${index}`, summary: `Material movement ${index}`, created_at: '2026-10-01T10:00:00Z', actor_name: 'Warehouse operator', event_type: 'material.released' })),
  } }));
  await page.goto('/tiles/orders/mobile-detail');
  await expect(page.getByTestId('tile-order-detail-screen')).toBeVisible();
}

async function scrollOwner(element: import('@playwright/test').Locator, amount: number) {
  return element.evaluate((node, amount) => {
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      if (/auto|scroll/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight + 10) {
        parent.scrollTop = amount;
        return { top: parent.scrollTop, height: parent.clientHeight, scrollHeight: parent.scrollHeight };
      }
    }
    return null;
  }, amount);
}

test('critical tile order timeline scrolls through its final event and closes without moving the order page', async ({ page }, info) => {
  await order(page);
  const actions = page.getByTestId('tile-order-actions');
  expect((await actions.boundingBox())!.width).toBeLessThan(200);
  await expect(page.getByTestId('tile-order-view-timeline')).toBeHidden();
  await actions.click();
  for (const action of ['timeline', 'register', 'dispatches']) await expect(page.getByTestId(`tile-order-view-${action}`)).toBeVisible();
  await page.getByTestId('tile-order-view-timeline').click();
  const sheet = page.getByTestId('tile-order-timeline-sheet');
  await expect(sheet).toBeVisible();
  const first = page.getByTestId('tile-order-timeline-event-0');
  const before = (await first.boundingBox())!;
  const scroll = await scrollOwner(first, 99999);
  expect(scroll, 'A timeline longer than the dialog needs a bounded scroll owner').not.toBeNull();
  expect(scroll!.top).toBeGreaterThan(300);
  await expect(page.getByTestId('tile-order-timeline-event-29')).toBeInViewport();
  expect((await first.boundingBox())!.y).toBeLessThan(before.y - 300);
  await sheet.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId('tile-order-actions')).toBeInViewport();
  expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
  await page.screenshot({ path: info.outputPath('tile-order-page.png') });
});

test('critical tile order phone metrics and product quantities stay grouped and the last product scrolls into view', async ({ page }, info) => {
  await order(page);
  const width = page.viewportSize()!.width;
  const summary = page.getByTestId('tile-order-summary');
  const summaryToggle = summary.getByRole('button', { name: 'Order summary', exact: true });
  await expect(summaryToggle).toHaveAttribute('aria-expanded', 'false');
  await summaryToggle.click();
  const products = summary.getByText('Products', { exact: true });
  const value = products.locator('..').getByText('12', { exact: true });
  const pb = (await products.boundingBox())!, vb = (await value.boundingBox())!;
  expect(Math.abs(pb.x - vb.x)).toBeLessThan(2);
  if (width < 768) {
    const metricCells = ['Products', 'Units ordered', 'Complete', 'Brands', 'Waiting'];
    const cells = await Promise.all(metricCells.map(async label => (await summary.getByText(label, { exact: true }).locator('..').boundingBox())!));
    expect(cells[0].y).toBeCloseTo(cells[1].y, 0);
    if (width >= 375) {
      expect(cells[2].y).toBeCloseTo(cells[0].y, 0);
      expect(cells[3].y).toBeGreaterThan(cells[0].y);
      expect(cells[0].x).toBeCloseTo(cells[3].x, 0);
    }
  }
  const group = page.getByTestId('tile-order-brand-mobile-po');
  const action = page.getByTestId('tile-order-actions-line-11');
  const scroll = await scrollOwner(action, 99999);
  expect(scroll!.top).toBeGreaterThan(300);
  await expect(action).toBeInViewport();
  const firstAction = page.getByTestId('tile-order-actions-line-0');
  await firstAction.scrollIntoViewIfNeeded();
  if (width < 768) {
    const field = group.getByText('ORDERED', { exact: true }).first().locator('..');
    const label = (await field.getByText('ORDERED', { exact: true }).boundingBox())!;
    const number = (await field.getByText('10 boxes', { exact: true }).boundingBox())!;
    const alignment = await field.getByText('10 boxes', { exact: true }).evaluate(node => getComputedStyle(node).textAlign);
    expect(alignment).toBe('left');
    expect(Math.abs(number.x - label.x)).toBeLessThan(2);
    for (const metric of ['RELEASED', 'GODOWN', 'DISPATCHED', 'REMAINING']) await expect(group.getByText(metric, { exact: true }).first()).toBeVisible();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('tile-order-product.png') });
});
