import { expect, test, type Page } from '@playwright/test';
import { mockSession } from './audit-fixtures';

async function reviewQuotation(page: Page) {
  const exitFullscreen = page.getByTestId("expand-quotation-workspace");
  if (await exitFullscreen.isVisible()) await exitFullscreen.click();
  const review = page.getByTestId('mobile-review-quotation');
  if (await review.isVisible()) await review.click();
  const quotationTab = page.getByRole('tab', { name: /Quotation ·/ });
  if (await quotationTab.isVisible()) await quotationTab.click();
}

async function orderedQuotation(page: Page, extraLines = 0) {
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
  document.items.splice(2, 0, ...Array.from({ length: extraLines }, (_, i) => ({
    id: `extra-${i}`, product_id: `extra-product-${i}`, sku: `EXTRA-${i}`, name: `Long quotation product ${i}`,
    room: 'Master Bath', category_id: 'basins', qty: 1, unit_price: 10, discount_pct: null,
  })));
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
  await reviewQuotation(page);
  await expect(page.getByTestId('line-drag-line-a')).toBeVisible();
  return () => document;
}

async function dragWithMouse(page: Page, source: string, target: string, after = false) {
  const before = await page.locator('[data-quotation-row]').evaluateAll(elements => elements.map(element => element.getAttribute('data-quotation-row')));
  const handle = page.getByTestId(`line-drag-${source}`);
  const destination = page.locator(`[data-quotation-row="${target}"]`);
  await handle.scrollIntoViewIfNeeded();
  const box = await handle.boundingBox();
  const targetBox = await destination.boundingBox();
  if (!box || !targetBox) throw new Error('Missing drag geometry');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, targetBox.y + (after ? targetBox.height * .75 : targetBox.height * .25), { steps: 16 });
  await expect.poll(() => page.locator('[data-quotation-row]').evaluateAll(elements => elements.map(element => element.getAttribute('data-quotation-row')))).not.toEqual(before);
  await page.mouse.up();
}

test('critical quotation drag rearranges categories, persists ordered items and keeps collapsed products on reload', async ({ page }) => {
  const getDocument = await orderedQuotation(page);
  await dragWithMouse(page, 'line-b', 'line-a');
  await expect.poll(() => getDocument().items.map(item => item.id)).toEqual(['line-b', 'line-a', 'line-c', 'line-hidden']);
  await page.reload();
  await expect(page.getByTestId('line-drag-line-b')).toBeAttached();
  await reviewQuotation(page);
  await expect(page.getByTestId('line-drag-line-b')).toBeVisible();
  const ids = await page.locator('[data-quotation-row]').evaluateAll(elements => elements.map(element => element.getAttribute('data-quotation-row')));
  expect(ids).toEqual(['hdr-Master Bath', 'line-b', 'line-a']);
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
  await expect(page.locator('[data-quotation-row]')).toHaveCount(3);
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


test('critical quotation products can be dragged from the bottom to the top of a room with auto-scroll', async ({ page }) => {
  const getDocument = await orderedQuotation(page, 12);
  // Begin on the final product and hold at the canvas edge as a salesperson
  // does when a longer quotation extends above the visible receipt.
  const handle = page.getByTestId('line-drag-extra-11');
  await handle.scrollIntoViewIfNeeded();
  const source = await handle.boundingBox();
  const canvas = await page.getByTestId('receipt-list').boundingBox();
  if (!source || !canvas) throw new Error('Missing scroll drag geometry');
  const x = source.x + source.width / 2;
  await page.mouse.move(x, Math.max(source.y, canvas.y) + 8);
  await page.mouse.down();
  await page.mouse.move(x, canvas.y + 12, { steps: 12 });
  await expect.poll(() => page.locator('[data-quotation-row]').nth(1).getAttribute('data-quotation-row')).toBe('extra-11');
  await page.mouse.up();
  await expect.poll(() => getDocument().items[0].id).toBe('extra-11');
  expect(getDocument().items[0].room).toBe('Master Bath');
  expect(getDocument().items).toHaveLength(16);
  await page.reload();
  await expect(page.getByTestId('line-drag-extra-11')).toBeAttached();
  await reviewQuotation(page);
  await expect(page.locator('[data-quotation-row]').nth(1)).toHaveAttribute('data-quotation-row', 'extra-11');
});

test('critical quotation room can move to the top without modifying products or changing the selection', async ({ page }) => {
  const getDocument = await orderedQuotation(page);
  await page.getByTestId('room-Kitchen').click();
  await expect(page.getByTestId('line-drag-line-c')).toBeVisible();
  await expect(page.getByTestId('line-drag-line-a')).toHaveCount(0);
  await page.getByTestId('room-actions-Kitchen').click();
  await page.getByTestId('room-top-Kitchen').click();
  await expect.poll(() => getDocument().rooms).toEqual(['Kitchen', 'Master Bath', 'Closed']);
  expect(getDocument().items.map(item => item.id)).toEqual(['line-a', 'line-b', 'line-c', 'line-hidden']);
  expect(getDocument().items.find(item => item.id === 'line-a')?.room).toBe('Master Bath');
  await page.reload();
  await expect(page.getByTestId('line-drag-line-c')).toBeAttached();
  await reviewQuotation(page);
  await expect(page.locator('[data-quotation-row]').first()).toHaveAttribute('data-quotation-row', 'hdr-Kitchen');
  await expect(page.getByText('Collapsed fixture', { exact: true })).toHaveCount(0);
});

test('critical quotation drag handles support keyboard ordering and a release directly over the target', async ({ page }) => {
  const getDocument = await orderedQuotation(page);
  const handle = page.getByTestId('line-drag-line-b');
  await handle.focus();
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => getDocument().items[0].id).toBe('line-b');
  await handle.focus();
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => getDocument().items[0].id).toBe('line-a');
  // Two tall cards cannot both fit in the receipt. Scroll so the previous
  // card's midpoint and the next handle are both inside the visible receipt.
  await page.getByTestId('receipt-list').evaluate(element => {
    const previous = element.querySelector<HTMLElement>('[data-quotation-row="line-a"]');
    if (previous) element.scrollTop = (previous.parentElement?.offsetTop || 0) + previous.offsetTop + previous.offsetHeight / 4;
    const next = element.querySelector<HTMLElement>('[data-testid="line-drag-line-b"]');
    if (next) element.scrollTop += Math.max(0, next.getBoundingClientRect().top - (element.getBoundingClientRect().bottom - 24));
  });
  const source = await handle.boundingBox();
  const target = await page.locator('[data-quotation-row="line-a"]').boundingBox();
  const canvas = await page.getByTestId('receipt-list').boundingBox();
  if (!source || !target || !canvas) throw new Error('Missing release geometry');
  const x = source.x + source.width / 2;
  const startY = (Math.max(source.y, canvas.y) + Math.min(source.y + source.height, canvas.y + canvas.height)) / 2;
  expect(Math.min(source.y + source.height, canvas.y + canvas.height) - Math.max(source.y, canvas.y)).toBeGreaterThan(0);
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid]')?.getAttribute('data-testid'), { x, y: startY })).toBe('line-drag-line-b');
  await page.mouse.move(x, startY);
  await page.mouse.down();
  // No preview wait before releasing: the final pointer location must commit.
  await page.mouse.move(x, Math.max(target.y + 8, canvas.y + 12));
  await page.mouse.up();
  await expect.poll(() => getDocument().items[0].id).toBe('line-b');
});

test('critical quotation real touch drop persists product ordering after reload', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Real touch movement is available through Chromium CDP; WebKit and Firefox cover pointer and keyboard paths.');
  const getDocument = await orderedQuotation(page);
  const handle = page.getByTestId('line-drag-line-b');
  // Two tall cards cannot both fit in the receipt. Scroll so the previous
  // card's midpoint and the next handle are both inside the visible receipt.
  await page.getByTestId('receipt-list').evaluate(element => {
    const previous = element.querySelector<HTMLElement>('[data-quotation-row="line-a"]');
    if (previous) element.scrollTop = (previous.parentElement?.offsetTop || 0) + previous.offsetTop + previous.offsetHeight / 4;
  });
  const source = await handle.boundingBox();
  const target = await page.locator('[data-quotation-row="line-a"]').boundingBox();
  const canvas = await page.getByTestId('receipt-list').boundingBox();
  if (!source || !target || !canvas) throw new Error('Missing touch drop geometry');
  const x = source.x + source.width / 2;
  const startY = (Math.max(source.y, canvas.y) + Math.min(source.y + source.height, canvas.y + canvas.height)) / 2;
  const touch = await page.context().newCDPSession(page);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: startY }] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: Math.max(canvas.y + 12, target.y + 8) }] });
  await expect.poll(() => page.locator('[data-quotation-row]').nth(1).getAttribute('data-quotation-row')).toBe('line-b');
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touch.detach();
  await expect.poll(() => getDocument().items[0].id).toBe('line-b');
  await page.reload();
  await expect(page.getByTestId('line-drag-line-b')).toBeAttached();
  await reviewQuotation(page);
  await expect(page.locator('[data-quotation-row]').nth(1)).toHaveAttribute('data-quotation-row', 'line-b');
});


test('critical quotation a product can be moved to the next room without changing totals', async ({ page }) => {
  const getDocument = await orderedQuotation(page);
  await page.getByTestId('line-actions-line-a').click();
  await page.getByTestId('line-move-line-a').click();
  await expect.poll(() => getDocument().items.find(item => item.id === 'line-a')?.room).toBe('Kitchen');
  await expect(page.getByTestId('line-drag-line-a')).toHaveCount(0);
  await page.getByTestId('room-Kitchen').click();
  await expect(page.getByTestId('line-drag-line-a')).toBeVisible();
  expect(getDocument().items.reduce((sum, item) => sum + item.qty * item.unit_price, 0)).toBe(1000);
});
