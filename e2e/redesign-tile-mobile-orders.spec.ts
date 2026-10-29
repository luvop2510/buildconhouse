import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

const order = { id: 'mobile-order', number: 'TCO-MOBILE', customer_name: 'Mobile Customer', customer_phone: '9000000000',
  order_date: '2026-10-01T10:00:00Z', waiting_days: 4, ageing_band: 'green', brands: [{ brand_name: 'Tile Brand' }],
  total_products: 3, total_boxes: 24, total_value: 48000, overall_status: 'Partially Dispatched', completion_percentage: 50 };

test('critical Tile Orders phone views stay on one compact row and records retain identity with paired quantities', async ({ page }, info) => {
  await mockSession(page, '/tiles/orders', false);
  await page.route('**/api/tile-orders/customer-orders?**', route => route.fulfill({ json: { orders: Array.from({ length: 12 }, (_, i) => ({ ...order, id: `mobile-${i}` })), page: 1, page_size: 30, total: 12, has_more: false } }));
  await page.goto('/tiles/orders');
  await expect(page.getByTestId('tile-orders-customer-mobile-0')).toBeVisible();
  if (page.viewportSize()!.width < 768) {
    const tabs = page.getByRole('tablist', { name: 'Tile order views' }).getByRole('tab');
    await expect(tabs).toHaveCount(6);
    const bounds = await tabs.evaluateAll(nodes => nodes.map(node => { const b = node.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; }));
    for (const tab of bounds) {
      expect(tab.y).toBeCloseTo(bounds[0].y, 0);
      expect(tab.height).toBeGreaterThanOrEqual(44);
    }
    const navigation = await page.getByTestId('tile-orders-tab').boundingBox();
    expect(navigation!.height).toBeLessThanOrEqual(56);
    await tabs.last().scrollIntoViewIfNeeded();
    await expect(tabs.last()).toBeInViewport();
    await tabs.first().scrollIntoViewIfNeeded();
    const card = page.getByTestId('tile-orders-customer-mobile-0');
    await expect(card.getByText(order.number, { exact: true })).toBeVisible();
    await expect(card.getByText('Tile Brand', { exact: true })).toBeVisible();
    const last = page.getByTestId('tile-orders-customer-mobile-11');
    await last.scrollIntoViewIfNeeded(); await expect(last).toBeInViewport();
    expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('tile-orders-mobile-page.png'), fullPage: true });
});

test('critical switching Tile Orders views cancels the abandoned request and keeps the selected view usable', async ({ page }) => {
  await mockSession(page, '/tiles/orders', false);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/tile-orders/customer-orders?**', async route => {
    await held;
    await route.fulfill({ json: { orders: [order], page: 1, has_more: false } }).catch(() => {});
  });
  await page.route('**/api/tile-orders/brands?**', route => route.fulfill({ json: { brands: [{ brand_id: 'brand', brand_name: 'Ready Brand', active_orders: 2, max_supplier_silent_days: 1 }], page: 1, has_more: false } }));
  try {
    const initial = page.waitForRequest('**/api/tile-orders/customer-orders?**');
    await page.goto('/tiles/orders'); await initial;
    const cancelled = page.waitForEvent('requestfailed', request => request.url().includes('/tile-orders/customer-orders?'));
    await page.getByTestId('tile-orders-tab-brands').click();
    await cancelled;
    await expect(page.getByText('Ready Brand', { exact: true })).toBeVisible();
    release();
    await expect(page.getByText('Mobile Customer', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Could not load orders', { exact: true })).toHaveCount(0);
  } finally { release(); }
});

for (const [path, testId, destination] of [
  ['/tiles/orders/missing', 'tile-order-back', '/tiles/orders'],
  ['/tiles/orders/brands/brand', 'tile-brand-queue-back', '/tiles/orders?tab=brands'],
  ['/tiles/orders/po/missing', 'tile-brand-release-back', '/tiles/orders?tab=brands'],
] as const) test(`critical Tile Orders Back works from a cold ${path} link`, async ({ page }) => {
  await mockSession(page, path);
  await page.goto(path);
  await page.getByTestId(testId).click();
  await expect(page).toHaveURL(new RegExp(`${destination.replace('?', '\\?')}$`));
  await expect(page.getByRole('heading', { name: 'Tile Orders', exact: true })).toBeVisible();
});

test('critical brand release paging stays bounded and retains its acknowledged page through failure and retry', async ({ page }) => {
  await mockSession(page, '/tiles/orders/brands/paged-brand', false);
  const { captureRuntimeHealth } = await import('./runtime-health');
  const health = captureRuntimeHealth(page);
  let reads = 0;
  let finishPage!: () => void;
  const pending = new Promise<void>(resolve => { finishPage = resolve; });
  await page.route('**/api/tile-orders/brands/paged-brand/orders?**', async route => {
    const requestedPage = Number(new URL(route.request().url()).searchParams.get('page'));
    reads += 1;
    if (requestedPage === 2 && reads === 2) {
      await pending;
      await route.fulfill({ status: 503, json: { detail: 'Second brand page unavailable; retry.' } });
      return;
    }
    await route.fulfill({ json: {
      kpi: { orders: 90, pending: 90, ready: 0, partially_dispatched: 0, completed: 0, boxes_remaining: 900, boxes_released: 0, oldest_pending_days: 4 },
      orders: Array.from({ length: 30 }, (_, i) => ({ po_id: `paged-${(requestedPage - 1) * 30 + i}`,
        po_number: `TPO-${(requestedPage - 1) * 30 + i}`, customer_name: `Brand customer ${(requestedPage - 1) * 30 + i}`,
        total_products: 1, total_boxes: 10, boxes_released: 0, boxes_remaining: 10, waiting_days: 4,
        ageing_band: 'green', overall_status: 'Pending' })),
      page: requestedPage, total: 90, has_more: requestedPage < 3,
    } });
  });
  try {
    await page.goto('/tiles/orders/brands/paged-brand');
    const rows = page.locator('[data-testid^="tile-brand-order-paged-"]');
    await expect(rows).toHaveCount(30);
    await page.getByTestId('tile-brand-queue-next').click();
    await expect.poll(() => reads).toBe(2);
    await expect(page.getByTestId('tile-brand-queue-next')).toBeDisabled();
    await expect(rows).toHaveCount(30);
    await expect(page.getByTestId('tile-brand-order-paged-0')).toHaveCount(1);
    finishPage();
    await expect(page.getByTestId('tile-brand-queue-retry')).toBeVisible();
    await expect(rows).toHaveCount(30);
    await expect(page.getByText('Page 1', { exact: true })).toBeVisible();
    await page.getByTestId('tile-brand-queue-retry').click();
    await expect(page.getByTestId('tile-brand-order-paged-30')).toHaveCount(1);
    await expect(page.getByTestId('tile-brand-order-paged-0')).toHaveCount(0);
    await expect(rows).toHaveCount(30);
    await expect(page.getByText('Page 2', { exact: true })).toBeVisible();
    await page.getByTestId('tile-brand-queue-next').click();
    await expect(page.getByTestId('tile-brand-order-paged-60')).toHaveCount(1);
    await expect(rows).toHaveCount(30);
    await expect(page.getByTestId('tile-brand-queue-next')).toBeDisabled();
    await page.getByTestId('tile-brand-queue-previous').click();
    await expect(page.getByTestId('tile-brand-order-paged-30')).toHaveCount(1);
    await expect(rows).toHaveCount(30);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await health.assertHealthy();
  } finally { finishPage(); }
});
