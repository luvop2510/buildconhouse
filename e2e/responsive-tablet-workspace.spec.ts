import { expect, test, type Locator, type Page } from '@playwright/test';
import { mockSession } from './audit-fixtures';

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}

async function targetSize(control: Locator) {
  await expect(control).toBeVisible();
  const box = await control.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
}

test.beforeEach(async ({ context }) => {
  await context.route('**/*', route => new URL(route.request().url()).origin === 'http://127.0.0.1:8096'
    ? route.continue() : route.abort());
});

test('tablet and desktop left pane shows workspace and account names and persists keyboard collapse', async ({ page }) => {
  test.skip(page.viewportSize()!.width < 768, 'Phones retain bottom navigation.');
  await mockSession(page, '/tiles/orders', false);
  await page.route('**/api/tile-orders/customer-orders?**', route => route.fulfill({ json: { orders: [], has_more: false } }));
  await page.goto('/tiles/orders');
  const nav = page.getByRole('navigation', { name: 'Primary', exact: true });
  const toggle = page.getByTestId('admin-sidebar-collapse-toggle');
  await expect(toggle).toHaveAccessibleName('Collapse sidebar');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(nav.getByText('Audit Owner', { exact: true })).toBeVisible();
  await expect(nav.getByText('Owner', { exact: true })).toBeVisible();
  await expect(nav.getByText('Daily work', { exact: true })).toBeVisible();
  await expect(nav.getByTestId('nav-orders')).toContainText('Tile Orders');
  await expect(nav.getByTestId('nav-orders')).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(nav.getByTestId('nav-tiles')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await targetSize(toggle);
  await toggle.focus();
  await page.keyboard.press('Space');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(nav.getByText('Audit Owner', { exact: true })).toHaveCount(0);
  await targetSize(toggle);
  await page.reload();
  await expect(toggle).toHaveAccessibleName('Expand sidebar');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(nav.getByText('Audit Owner', { exact: true })).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await noOverflow(page);
});

test('tile orders reflow with usable pane width and retain tablet brands and waiting information', async ({ page }, info) => {
  await mockSession(page, '/tiles/orders', false);
  await page.route('**/api/tile-orders/customer-orders?**', route => route.fulfill({ json: { orders: [{
    id: 'responsive-order', number: 'TCO-RESPONSIVE', customer_name: 'Customer with a long project and company name',
    customer_phone: '9000000000', order_date: '2026-10-01T12:00:00Z', waiting_days: 4, ageing_band: 'amber',
    brands: [{ brand_name: 'Example Tile Brand' }], total_products: 3, total_boxes: 24, total_value: 48000,
    overall_status: 'Partially Dispatched', completion_percentage: 50,
  }], page: 1, has_more: false } }));
  await page.goto('/tiles/orders');
  const width = page.viewportSize()!.width;
  if (width === 768) {
    const customerQueue = await page.getByTestId('tile-orders-tab-customer').boundingBox();
    const releaseQueue = await page.getByTestId('tile-orders-tab-brands').boundingBox();
    expect(releaseQueue!.y).toBeCloseTo(customerQueue!.y, 0);
    expect(releaseQueue!.x).toBeGreaterThan(customerQueue!.x);
  }
  const table = page.getByTestId('tile-orders-customer-table');
  const record = page.getByTestId('tile-orders-customer-responsive-order');
  await expect(record).toBeVisible();
  await expect(record.getByText('Customer with a long project and company name', { exact: true })).toBeVisible();
  if (width < 1280) {
    await expect(table).not.toHaveAttribute('role', 'table');
    await expect(record.getByText('ORDER NO.', { exact: true })).toBeVisible();
    if (width >= 768) {
      await expect(record.getByText('BRANDS', { exact: true })).toBeVisible();
      await expect(record.getByText('WAITING', { exact: true })).toBeVisible();
    }
  } else {
    await expect(table).toHaveRole('table');
  }
  const search = page.getByTestId('tile-orders-customer-search');
  await expect(search).toBeVisible();
  await targetSize(page.getByTestId('tile-orders-customer-status-all'));
  if (width === 1024) {
    await page.getByTestId('admin-sidebar-collapse-toggle').click();
    await expect(table).toHaveRole('table');
    await page.getByTestId('admin-sidebar-collapse-toggle').click();
    await expect(table).not.toHaveAttribute('role', 'table');
    await expect(record.getByText('BRANDS', { exact: true })).toBeVisible();
  }
  await noOverflow(page);
  await page.screenshot({ path: info.outputPath(`tile-orders-${width}.png`), animations: 'disabled' });
});

test('tile order detail keeps movement actions and tablet fulfilment counters reachable', async ({ page }, info) => {
  await mockSession(page, '/tiles/orders/tablet-order', false);
  await page.route('**/api/tile-orders/customer-orders/tablet-order', route => route.fulfill({ json: {
    summary: { id: 'tablet-order', number: 'TO-RESPONSIVE', customer_name: 'Tablet customer',
      order_date: '2026-10-01T12:00:00Z', brand_count: 1, total_products: 1, total_boxes: 10,
      completion_percentage: 0, waiting_days: 4, ageing_band: 'amber', overall_status: 'Partially Dispatched' },
    suppliers: [{ purchase_order_id: 'tablet-po', supplier_name: 'Tile supplier', brand_id: 'brand-one',
      brand_name: 'Example Tile Brand with an unusually long manufacturing company name', overall_status: 'Ready', items: [{ po_item_id: 'tablet-line',
        tile_name: 'Wall tile with a detailed product description', series: null, finish: 'Matt',
        size: '600 × 600', sku: 'T-101', boxes_ordered: 10, boxes_ready: 6, boxes_godown: 2,
        boxes_dispatched: 0, boxes_pending: 4, quantity_unit: 'Box', current_location: 'Supplier', overall_status: 'Ready' }] }],
  } }));
  await page.goto('/tiles/orders/tablet-order');
  const group = page.getByTestId('tile-order-brand-tablet-po');
  for (const key of ['move-godown', 'dispatch-released', 'dispatch-godown']) {
    await targetSize(page.getByTestId(`tile-order-${key}-tablet-line`));
  }
  if (page.viewportSize()!.width >= 768 && page.viewportSize()!.width < 1280) {
    await expect(group.getByText('RELEASED', { exact: true })).toBeVisible();
    await expect(group.getByText('GODOWN', { exact: true })).toBeVisible();
    await expect(group.getByText('DISPATCHED', { exact: true })).toBeVisible();
  }
  await page.getByTestId('tile-order-move-godown-tablet-line').click();
  await expect(page.getByRole('dialog', { name: 'Move to Godown', exact: true })).toBeVisible();
  await noOverflow(page);
  await page.screenshot({ path: info.outputPath(`tile-movement-${page.viewportSize()!.width}.png`), animations: 'disabled' });
});

test('customer reset removes previous local draft blobs once and preserves new drafts and preferences', async ({ page }) => {
  await mockSession(page, '/tiles/orders', false);
  await page.addInitScript(() => {
    if (sessionStorage.getItem('fixture-reset-seeded')) return;
    sessionStorage.setItem('fixture-reset-seeded', 'true');
    localStorage.setItem('forge.builder.draft.v1.keys', JSON.stringify(JSON.stringify(['forge.builder.draft.v1.audit-owner.first-floor'])));
    localStorage.setItem('forge.builder.draft.v1.audit-owner.first-floor', JSON.stringify('Previous customer phone'));
    localStorage.setItem('forge.builder.draft.v1.orphan.ground-floor', JSON.stringify('Orphan customer address'));
    localStorage.setItem('forge.builder.snapshot.v4', JSON.stringify('Legacy customer draft'));
    localStorage.setItem('forge.favourites.v1', JSON.stringify(['fixture-product']));
    localStorage.setItem('forge.admin.sidebar.collapsed.v1', JSON.stringify(false));
  });
  await page.route('**/api/tile-orders/customer-orders?**', route => route.fulfill({ json: { orders: [], has_more: false } }));
  await page.goto('/tiles/orders');
  await expect(page.getByRole('heading', { name: 'Tile Orders', exact: true })).toBeVisible();
  const afterReset = await page.evaluate(() => ({
    previousKeys: Object.keys(localStorage).filter(key => key.startsWith('forge.builder.draft.v1.') || key === 'forge.builder.snapshot.v4'),
    marker: JSON.parse(localStorage.getItem('forge.builder.customerResetEpoch.v1') || 'null'),
    favourites: JSON.parse(localStorage.getItem('forge.favourites.v1') || 'null'),
    collapsed: JSON.parse(localStorage.getItem('forge.admin.sidebar.collapsed.v1') || 'null'),
  }));
  expect(afterReset).toEqual({ previousKeys: [], marker: 'customer-reset-20261010', favourites: ['fixture-product'], collapsed: false });
  await page.evaluate(() => localStorage.setItem('forge.builder.draft.v1.audit-owner.first-floor', JSON.stringify('New post-reset quotation')));
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Tile Orders', exact: true })).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('forge.builder.draft.v1.audit-owner.first-floor') || 'null'))).toBe('New post-reset quotation');
});
