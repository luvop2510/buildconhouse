import { expect, test, type Page } from '@playwright/test';
import { mockSession } from './audit-fixtures';
import { captureRuntimeHealth } from './runtime-health';

const date = '2026-10-01T10:00:00Z';
const order = { id: 'compact-order', number: 'TCO-COMPACT', customer_name: 'Compact Customer', customer_phone: '9000000000',
  order_date: date, waiting_days: 4, ageing_band: 'green', brands: [{ brand_name: 'Compact Tile Brand' }],
  total_products: 3, total_boxes: 24, total_value: 48000, overall_status: 'Partially Dispatched', completion_percentage: 50 };

async function queues(page: Page) {
  await mockSession(page, '/tiles/orders', false);
  const responses: Record<string, unknown> = {
    'customer-orders': { orders: Array.from({ length: 12 }, (_, index) => ({ ...order, id: `compact-${index}`, customer_name: `Compact Customer ${index}` })) },
    brands: { brands: [{ brand_id: 'compact-brand', brand_name: 'Compact Tile Brand', active_orders: 3, max_supplier_silent_days: 4 }] },
    history: { rows: [{ id: 'completed', customer: 'Completed Customer', order_number: 'TCO-COMPLETE', brands: ['Compact Tile Brand'],
      products: [], completion_date: date, final_amount: 48000, delivery_status: 'Delivered', chalan_references: [], dispatch_references: [] }] },
    inventory: { rows: [{ id: 'stock', customer: 'Stock Customer', name: 'Compact Stock Tile', brand: 'Compact Tile Brand', product: 'STOCK-SKU', size: '600 × 600', arrival_date: date }] },
    dispatches: { rows: [{ dispatch_id: 'dispatch', dispatch_number: 'TD-COMPACT', dispatch_date: date, customer_name: 'Dispatch Customer',
      customer_order_id: 'compact-order', brand_name: 'Compact Tile Brand', tile_name: 'Compact Dispatch Tile', sku: 'DISPATCH-SKU', boxes: 12,
      quantity_unit: 'Box', source: 'Released', chalan_id: 'chalan', chalan_number: 'TC-COMPACT', status: 'Dispatched' }] },
    movements: { rows: [{ id: 'movement', movement_type: 'release', created_at: date, customer_order_id: 'compact-order',
      customer_name: 'Movement Customer', brand_name: 'Compact Tile Brand', tile_name: 'Compact Movement Tile', sku: 'MOVEMENT-SKU', boxes: 8,
      quantity_unit: 'Box', source: 'Supplier', destination: 'Released', performed_by_name: 'Warehouse operator' }] },
  };
  for (const [endpoint, response] of Object.entries(responses)) await page.route(`**/api/tile-orders/${endpoint}?**`, route => route.fulfill({
    json: { ...response as object, page: 1, page_size: 30, has_more: false, next_page: null, total: endpoint === 'customer-orders' ? 12 : 1 },
  }));
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
}

test('critical all six tile stages keep compact navigation, visible records and Excel actions', async ({ page }, info) => {
  await queues(page);
  const health = captureRuntimeHealth(page);
  await page.goto('/tiles/orders?tab=material-register');
  await expect(page.getByTestId('tile-orders-tab-material-register')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('tile-orders-tab-material-register')).toBeInViewport({ ratio: 1 });
  for (const [stage, table, content] of [
    ['customer', 'customer', 'Compact Customer 0'], ['brands', 'brands', 'Compact Tile Brand'],
    ['dispatch-list', 'dispatch', 'Compact Dispatch Tile'], ['inventory', 'inventory', 'Compact Stock Tile'],
    ['history', 'history', 'Completed Customer'], ['material-register', 'movement', 'Compact Movement Tile'],
  ]) {
    const tab = page.getByTestId(`tile-orders-tab-${stage}`);
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    const body = page.getByTestId(`tile-orders-${table}-table`);
    await expect(body).toContainText(content);
    const navigation = page.getByRole('tablist', { name: 'Tile order views' });
    const bounds = (await navigation.boundingBox())!;
    expect(bounds.height).toBeLessThanOrEqual(64);
    expect((await tab.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(page.getByRole('button', { name: /Excel|Export/i }).first()).toBeVisible();
    await noOverflow(page);
  }
  await health.assertHealthy();
  await page.screenshot({ path: info.outputPath('six-stage-workspace.png'), animations: 'disabled' });
});

test('critical tile customer search and filters survive phone to tablet rotation without overflow', async ({ page }, info) => {
  await queues(page);
  const health = captureRuntimeHealth(page);
  await page.goto('/tiles/orders');
  await expect(page.getByTestId('tile-orders-customer-compact-0')).toBeVisible();
  const initialWidth = page.viewportSize()!.width;
  if (initialWidth < 768) {
    const filters = page.getByTestId('tile-table-filters-toggle');
    await expect(filters).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('tile-orders-customer-status-all')).toBeHidden();
    const record = (await page.getByTestId('tile-orders-customer-compact-0').boundingBox())!;
    expect(record.height).toBeLessThanOrEqual(initialWidth < 375 ? 190 : 150);
    if (initialWidth >= 375) await expect(page.getByTestId('tile-orders-customer-compact-2')).toBeInViewport();
    await filters.click();
    await expect(filters).toHaveAttribute('aria-expanded', 'true');
  } else if (initialWidth < 1366) {
    expect((await page.getByTestId('tile-orders-customer-compact-0').boundingBox())!.height).toBeLessThanOrEqual(150);
  }
  const pending = page.getByTestId('tile-orders-customer-status-pending');
  await pending.click();
  await expect(pending).toHaveAttribute('aria-pressed', 'true');
  const search = page.getByTestId('tile-orders-customer-search');
  await search.fill('Compact');
  const nodeIdentity = await search.evaluate(node => { node.setAttribute('data-rotation-probe', 'same-field'); return node.getAttribute('data-rotation-probe'); });
  await page.setViewportSize({ width: initialWidth < 768 ? 834 : 390, height: initialWidth < 768 ? 1112 : 844 });
  await expect(search).toHaveValue('Compact');
  await expect(search).toHaveAttribute('data-rotation-probe', nodeIdentity!);
  await expect(page.getByTestId('tile-orders-tab-customer')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('tile-orders-customer-compact-0')).toBeVisible();
  await noOverflow(page);
  await health.assertHealthy();
  await page.screenshot({ path: info.outputPath('rotated-tile-workspace.png'), animations: 'disabled' });
});

test('critical tile stage loading and retry give feedback without hiding navigation', async ({ page }) => {
  await queues(page);
  const health = captureRuntimeHealth(page);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let fail = true;
  await page.route('**/api/tile-orders/brands?**', async route => {
    await pending;
    await route.fulfill(fail ? { status: 503, json: { detail: 'Release queue temporarily unavailable' } } : {
      json: { brands: [{ brand_id: 'retry-brand', brand_name: 'Recovered Tile Brand', active_orders: 2, max_supplier_silent_days: 1 }], page: 1, has_more: false },
    });
  });
  try {
    await page.goto('/tiles/orders');
    await page.getByTestId('tile-orders-tab-brands').click();
    await expect(page.getByTestId('tile-orders-loading')).toBeVisible();
    await expect(page.getByTestId('tile-orders-tab-customer')).toBeVisible();
    await expect(page.getByTestId('tile-orders-tab-brands')).toHaveAttribute('aria-selected', 'true');
    release();
    await expect(page.getByText('Release queue temporarily unavailable', { exact: true }).first()).toBeVisible();
    fail = false;
    await page.getByTestId('tile-orders-retry').click();
    await expect(page.getByTestId('tile-orders-brands-table')).toContainText('Recovered Tile Brand');
    await expect(page.getByTestId('tile-orders-loading')).toHaveCount(0);
    await noOverflow(page);
    await health.assertHealthy();
  } finally { release(); }
});

test('critical tile Excel exports every filtered page once with visible progress and a device download', async ({ page }) => {
  await queues(page);
  const health = captureRuntimeHealth(page);
  const exportReads: number[] = [];
  await page.route('**/api/tile-orders/customer-orders?**', route => {
    const params = new URL(route.request().url()).searchParams;
    const pageNumber = Number(params.get('page') || 1);
    const pageSize = Number(params.get('page_size') || 30);
    const start = (pageNumber - 1) * pageSize;
    if (pageSize === 100) exportReads.push(pageNumber);
    return route.fulfill({ json: {
      orders: Array.from({ length: Math.min(pageSize, 105 - start) }, (_, index) => ({ ...order, id: `export-${start + index}`, customer_name: `Export Customer ${start + index}` })),
      page: pageNumber, page_size: pageSize, total: 105, has_more: start + pageSize < 105, next_page: start + pageSize < 105 ? pageNumber + 1 : null,
    } });
  });
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let exports = 0;
  let rows: string[][] = [];
  await page.route('**/api/exports/page.xlsx', async route => {
    exports += 1;
    expect(route.request().headers()['x-floor-id']).toBe('ground-floor');
    rows = route.request().postDataJSON().sections[0].rows;
    await pending;
    await route.fulfill({ contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: 'PK-synthetic-transport-workbook' });
  });
  try {
    await page.goto('/tiles/orders');
    await expect(page.getByTestId('tile-orders-customer-export-0')).toBeVisible();
    const button = page.getByTestId('tile-orders-customer-export');
    await button.evaluate(node => { (node as HTMLElement).click(); (node as HTMLElement).click(); });
    await expect.poll(() => exports).toBe(1);
    await expect(button).toHaveAttribute('aria-busy', 'true');
    await expect(button).toBeDisabled();
    await expect(page.getByRole('status')).toContainText('Creating Excel file');
    expect(exportReads).toEqual([1, 2]);
    expect(rows.length).toBe(106);
    expect(rows.at(-1)![0]).toBe('Export Customer 104');
    const download = page.waitForEvent('download');
    release();
    if (await page.evaluate(() => /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
      await page.getByTestId('mobile-file-download').click();
    }
    expect((await download).suggestedFilename()).toBe('tile-orders-customer.xlsx');
    await expect(button).toBeEnabled();
    await expect(button).toHaveAccessibleName('Export Excel');
    await health.assertHealthy();
  } finally { release(); }
});
