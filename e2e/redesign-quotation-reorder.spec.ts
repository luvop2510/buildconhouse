import { expect, test, type Page } from '@playwright/test';
import { mockSession } from './audit-fixtures';

async function orderedQuotation(page: Page) {
  await mockSession(page, '/quotations/new', false);
  let document = {
    id: 'q-reorder', number: 'Q-REORDER', customer_id: 'customer-reorder', customer_name: 'Reorder customer', status: 'draft', floor_id: 'first-floor',
    rooms: ['Master Bath', 'Kitchen', 'Closed'], collapsed_rooms: ['Closed'], updated_at: '2026-10-11T10:00:00Z',
    items: [
      { id: 'line-a', product_id: 'product-a', sku: 'A', name: 'Basin across Brand A', room: 'Master Bath', category_id: 'basins', qty: 1, unit_price: 100, discount_pct: null },
      { id: 'line-b', product_id: 'product-b', sku: 'B', name: 'Shower across Brand B', room: 'Master Bath', category_id: 'showers', qty: 1, unit_price: 200, discount_pct: null },
      { id: 'line-c', product_id: 'product-c', sku: 'C', name: 'Kitchen fixture', room: 'Kitchen', category_id: 'basins', qty: 1, unit_price: 300, discount_pct: null },
      { id: 'line-hidden', product_id: 'product-hidden', sku: 'H', name: 'Collapsed fixture', room: 'Closed', category_id: 'basins', qty: 1, unit_price: 400, discount_pct: null },
    ],
  };
  await page.route('**/api/categories**', r => r.fulfill({ json: [{ id: 'basins', name: 'Basins' }, { id: 'showers', name: 'Showers' }] }));
  await page.route('**/api/brands**', r => r.fulfill({ json: [] }));
  await page.route('**/api/products/**', r => r.fulfill({ json: { items: [], total: 0 } }));
  await page.route('**/api/customers**', r => r.fulfill({ json: [{ id: 'customer-reorder', name: 'Reorder customer' }] }));
  await page.route('**/api/quotations/recent?**', r => r.fulfill({ json: [] }));
  await page.route(/\/api\/quotations\/q-reorder(?:\?.*)?$/, async r => {
    if (r.request().method() === 'PATCH') document = { ...document, ...r.request().postDataJSON() };
    await r.fulfill({ json: document });
  });
  await page.goto('/quotations/new?quotationId=q-reorder');
  await expect(page.getByTestId('line-drag-line-a')).toBeAttached();
  const quotationTab = page.getByRole('tab', { name: /Quotation ·/ });
  if (await quotationTab.isVisible()) await quotationTab.click();
  await expect(page.getByTestId('line-drag-line-a')).toBeVisible();
  return () => document;
}

async function dragWithMouse(page: Page, source: string, target: string, after = false) {
  const handle = page.getByTestId(`line-drag-${source}`);
  const destination = page.locator(`[data-quotation-row="${target}"]`);
  await handle.scrollIntoViewIfNeeded();
  const box = await handle.boundingBox();
  const targetBox = await destination.boundingBox();
  if (!box || !targetBox) throw new Error('Missing drag geometry');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, targetBox.y + (after ? targetBox.height * .75 : targetBox.height * .25), { steps: 16 });
  await expect.poll(() => page.locator('[data-quotation-row]').evaluateAll(elements => elements.map(element => element.getAttribute('data-quotation-row')))).not.toEqual(['hdr-Master Bath', 'line-a', 'line-b', 'hdr-Kitchen', 'line-c', 'hdr-Closed']);
  await page.mouse.up();
}

test('critical quotation drag rearranges categories, persists ordered items and keeps collapsed products on reload', async ({ page }) => {
  const getDocument = await orderedQuotation(page);
  await dragWithMouse(page, 'line-b', 'line-a');
  await expect.poll(() => getDocument().items.map(item => item.id)).toEqual(['line-b', 'line-a', 'line-c', 'line-hidden']);
  await page.reload();
  await expect(page.getByTestId('line-drag-line-b')).toBeAttached();
  const quotationTab = page.getByRole('tab', { name: /Quotation ·/ });
  if (await quotationTab.isVisible()) await quotationTab.click();
  await expect(page.getByTestId('line-drag-line-b')).toBeVisible();
  const ids = await page.locator('[data-quotation-row]').evaluateAll(elements => elements.map(element => element.getAttribute('data-quotation-row')));
  expect(ids).toEqual(['hdr-Master Bath', 'line-b', 'line-a', 'hdr-Kitchen', 'line-c', 'hdr-Closed']);
  await expect(page.getByText('Collapsed fixture', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('critical quotation touch pointer reorder and Escape cancellation work without changing the total', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium CDP dispatches a real touch gesture; other engines cover mouse and keyboard ordering.');
  const getDocument = await orderedQuotation(page);
  const handle = page.getByTestId('line-drag-line-b');
  await handle.scrollIntoViewIfNeeded();
  const box = await handle.boundingBox();
  const targetBox = await page.locator('[data-quotation-row="line-a"]').boundingBox();
  const canvasBox = await page.getByTestId('receipt-list').boundingBox();
  if (!box || !targetBox || !canvasBox) throw new Error('Missing touch geometry');
  // Narrow rows can be taller than the canvas. Start on the visible handle and
  // drag to its upper edge, allowing the same auto-scroll a finger uses.
  const x = box.x + box.width / 2;
  const visibleTop = Math.max(box.y, canvasBox.y);
  const visibleBottom = Math.min(box.y + box.height, canvasBox.y + canvasBox.height);
  const startY = (visibleTop + visibleBottom) / 2;
  const destinationY = Math.max(canvasBox.y + 16, targetBox.y + 10);
  const touch = await page.context().newCDPSession(page);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: startY }] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: destinationY }] });
  await expect(page.locator('[data-quotation-row]')).toHaveCount(6);
  await expect.poll(() => page.locator('[data-quotation-row]').nth(1).getAttribute('data-quotation-row')).toBe('line-b');
  await page.keyboard.press('Escape');
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touch.detach();
  await expect(page.locator('[data-quotation-row]').nth(1)).toHaveAttribute('data-quotation-row', 'line-a');
  expect(getDocument().items.map(item => item.id)).toEqual(['line-a', 'line-b', 'line-c', 'line-hidden']);
  await page.getByTestId('line-actions-line-b').click();
  await page.getByTestId('line-move-up-line-b').click();
  await expect.poll(() => getDocument().items.map(item => item.id)).toEqual(['line-b', 'line-a', 'line-c', 'line-hidden']);
  expect(getDocument().items.reduce((sum, item) => sum + item.qty * item.unit_price, 0)).toBe(1000);
});
