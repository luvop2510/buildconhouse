import { expect, test, type Locator, type Page } from '@playwright/test';
import { mockSession } from './audit-fixtures';
import { captureRuntimeHealth } from './runtime-health';

const longName = 'Synthetic customer with a long architectural project name';
const longToken = 'PROJECT_REFERENCE_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.repeat(4);
const timestamp = '2026-10-20T10:00:00Z';

/** Inspect the cells themselves: root clipping alone can hide broken columns. */
async function assertCellGeometry(scope: Locator) {
  const measurements = await scope.evaluate(element => {
    const errors: string[] = [];
    const rows = Array.from(element.querySelectorAll<HTMLElement>('[role="row"]'));
    for (const [rowIndex, row] of rows.entries()) {
      const cells = Array.from(row.children).filter((child): child is HTMLElement => child instanceof HTMLElement && ['cell', 'columnheader'].includes(child.getAttribute('role') || ''));
      const boxes = cells.map(cell => cell.getBoundingClientRect());
      const header = rows[0];
      if (rowIndex > 0 && cells.length === header.children.length) {
        for (const [index, cell] of cells.entries()) {
          const label = header.children[index].getBoundingClientRect(), body = cell.getBoundingClientRect();
          if (Math.abs(label.left - body.left) > 1 || Math.abs(label.width - body.width) > 1) errors.push(`row ${rowIndex} column ${index} differs from header`);
        }
      }
      for (let index = 0; index < cells.length; index++) {
        const cell = cells[index], box = boxes[index];
        if (!box.width || !box.height) continue;
        const next = boxes[index + 1];
        if (next && box.right > next.left + 1 && Math.min(box.bottom, next.bottom) > Math.max(box.top, next.top)) errors.push(`row ${rowIndex} cells ${index}/${index + 1} overlap`);
        const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent?.trim()) continue;
          const parent = node.parentElement!;
          const style = getComputedStyle(parent);
          // Explicit ellipsis is a deliberate readable preview, with the full
          // value available from the record. Unclipped text must stay in its cell.
          if (style.textOverflow === 'ellipsis' || style.overflow === 'hidden' || style.display === '-webkit-box') continue;
          const range = document.createRange(); range.selectNodeContents(node);
          for (const text of Array.from(range.getClientRects())) if (text.right > box.right + 1 || text.left < box.left - 1 || text.bottom > box.bottom + 1) errors.push(`row ${rowIndex} cell ${index} text exceeds bounds: ${node.textContent.slice(0, 35)}`);
        }
      }
    }
    return { rows: rows.length, cells: element.querySelectorAll('[role="cell"]').length, errors };
  });
  expect(measurements.errors).toEqual([]);
  expect(measurements.rows).toBeGreaterThan(0);
  return measurements;
}
async function keyboardScroll(page: Page, scroll: Locator) {
  const bounds = await scroll.evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth }));
  if (bounds.content <= bounds.width + 1) return;
  await scroll.focus();
  await expect(scroll).toBeFocused();
  await page.keyboard.press('End');
  await expect.poll(() => scroll.evaluate(element => element.scrollLeft + element.clientWidth >= element.scrollWidth - 2)).toBe(true);
}
async function fitsPage(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}
async function floor(page: Page, id: string) { await page.addInitScript(value => localStorage.setItem('forge.active-floor', JSON.stringify(value)), id); }

test('Sanitary analytics table keeps long product text within its revenue column', async ({ page }, info) => {
  const health = captureRuntimeHealth(page);
  await mockSession(page, '/sales-data/brands/layout-brand', false);
  await page.route('**/api/executive-analytics/brands/layout-brand?**', route => route.fulfill({ json: {
    brand: { name: 'Sanitary table layout' }, kpis: { revenue: 123456789, orders: 2, aov: 61728394 }, trend: [],
    products: [{ product_id: 'layout-product', name: longToken, revenue: 123456789 }], customers: [], salespeople: [], referrals: [],
  } }));
  await page.goto('/sales-data/brands/layout-brand');
  const product = page.getByTestId('brand-product-layout-product'); await expect(product).toBeVisible();
  if (page.viewportSize()!.width >= 768) {
    const section = page.getByTestId('brand-detail-products');
    await assertCellGeometry(section);
    await keyboardScroll(page, section.getByRole('table').locator('..'));
    await section.getByRole('table').locator('..').evaluate(element => { element.scrollLeft = 0; });
  }
  else {
    const texts = await product.locator(':scope > div').evaluateAll(elements => elements.map(element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right }; }));
    expect(texts[0].right).toBeLessThanOrEqual(texts[1].left + 1);
  }
  await fitsPage(page); await health.assertHealthy();
  await page.screenshot({ path: info.outputPath('sanitary-table.png') });
});

test('Ground order table preserves aligned columns or operable compact records', async ({ page }, info) => {
  const health = captureRuntimeHealth(page);
  await mockSession(page, '/tiles/orders', false);
  await page.route('**/api/tile-orders/customer-orders?**', route => route.fulfill({ json: { orders: [{
    id: 'layout-order', number: longToken, customer_name: longName, customer_phone: '9000000000', brands: [{ brand_id: 'one', brand_name: longToken }],
    order_date: timestamp, brand_count: 1, total_products: 12, total_boxes: 12345, completion_percentage: 20, waiting_days: 11, ageing_band: 'green', overall_status: 'Partially Dispatched',
  }], total: 1, page: 1, page_size: 30, has_more: false } }));
  await page.goto('/tiles/orders');
  const table = page.getByTestId('tile-orders-customer-table'); await expect(table).toContainText(longName);
  if (await table.getByRole('cell').count()) {
    await assertCellGeometry(table);
    const scroll = page.getByTestId('tile-orders-customer-table-scroll');
    await keyboardScroll(page, scroll);
    await scroll.evaluate(element => { element.scrollLeft = 0; });
  }
  else await expect(page.getByTestId('tile-orders-customer-layout-order')).toBeVisible();
  await fitsPage(page); await health.assertHealthy();
  await page.screenshot({ path: info.outputPath('ground-table.png') });
});

test('Furniture seven-column ledger contains long descriptions and scrolls inside its frame', async ({ page }, info) => {
  const health = captureRuntimeHealth(page);
  await mockSession(page, '/notebook/furniture-quotations', false); await floor(page, 'third-floor');
  const saved = { id: 'layout-ledger', customer_name: longName, customer_phone: '9000000000', floor_id: 'third-floor', status: 'draft', revision: 1, created_at: timestamp, updated_at: timestamp,
    charges: [{ id: 'one', description: longToken, amount_rmb: '172250.00', created_at: timestamp, updated_at: timestamp }],
    deposits: [{ id: 'two', description: longName, currency: 'INR', amount: '2200000', rate: '15.12', amount_rmb: '145502.65', created_at: timestamp, updated_at: timestamp }],
    total_payable_rmb: '172250.00', total_received_rmb: '145502.65', balance_rmb: '26747.35' };
  await page.route('**/api/furniture-quotations', route => route.fulfill({ json: { rows: [saved], next_cursor: null } }));
  await page.route('**/api/furniture-quotations/layout-ledger', route => route.fulfill({ json: saved }));
  await page.route('**/api/whatsapp/configuration', route => route.fulfill({ json: { configured: false, template_configured: false } }));
  await page.goto('/notebook/furniture-quotations'); await page.getByRole('button', { name: `Open ${longName}`, exact: true }).click();
  const ledger = page.getByTestId('furniture-ledger-preview'); await expect(ledger).toContainText(longToken);
  await assertCellGeometry(ledger);
  await ledger.getByRole('columnheader').first().scrollIntoViewIfNeeded();
  const before = await ledger.evaluate(element => ({ scroll: element.scrollWidth, width: element.clientWidth }));
  if (before.scroll > before.width + 1) {
    await keyboardScroll(page, ledger);
    expect(await ledger.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
    await expect(ledger.getByRole('columnheader', { name: 'DATE', exact: true })).toBeInViewport();
  }
  await ledger.evaluate(element => { element.scrollLeft = 0; });
  await fitsPage(page); await health.assertHealthy();
  await page.screenshot({ path: info.outputPath('furniture-table.png') });
});

test('Kitchen compact list fits long customer and site values from retired table bookmarks', async ({ page }, info) => {
  const health = captureRuntimeHealth(page);
  await mockSession(page, '/kitchen/stages/lead', false); await floor(page, 'second-floor');
  const project = { id: 'layout-kitchen', reference: 'KIT-2026-0101', customer_id: 'layout-customer', customer: { id: 'layout-customer', name: longName, phone: '9000000000' },
    stage: 'lead', status: 'New', version: 1, lead: { status: 'New', site_location: longToken, budget: '123456789.00' }, assignments: {}, design_revision_count: 0, site_visit_count: 0, target_completion_date: '2026-12-31' };
  await page.route('**/api/kitchen-projects**', route => { const path = new URL(route.request().url()).pathname; return route.fulfill({ json: path.endsWith('/configuration') ? { version: 1, department_manager_user_ids: [] } : { rows: [project], total: 1, page: 1, limit: 25 } }); });
  await page.goto('/kitchen/stages/lead?view=table');
  const list = page.getByTestId('kitchen-compact-list');
  await expect(list).toContainText(longName);
  await expect(list).toContainText(longToken);
  await expect(page.getByTestId('kitchen-table')).toHaveCount(0);
  await fitsPage(page); await health.assertHealthy();
  await page.screenshot({ path: info.outputPath('kitchen-compact-list.png') });
});
