import { expect, test, type Locator, type Page } from '@playwright/test';
import { mockSession } from './audit-fixtures';
import { captureRuntimeHealth } from './runtime-health';

const item = { po_item_id: 'driver-item', tile_name: 'Ivory', sku: 'IVORY-MATT', finish: 'Matt', size: '600x600',
  boxes_ordered: 10, boxes_ready: 4, boxes_godown: 6, boxes_pending: 0, boxes_dispatched: 0, quantity_unit: 'Box', current_location: 'Godown', overall_status: 'Ready' };
const summary = { id: 'driver-order', number: 'TO-DRIVER', customer_name: 'Driver test customer', order_date: '2026-11-01',
  brand_count: 1, total_products: 1, total_boxes: 10, completion_percentage: 0, overall_status: 'Ready', waiting_days: 1, ageing_band: 'green' };
const group = { purchase_order_id: 'driver-po', brand_name: 'Tile brand', overall_status: 'Ready', items: [item] };
const ramesh = { name: 'Rameshbhai', mobile: '9876543210', vehicle_number: 'GJ-01-1000' };
const harsh = { name: 'Harsh', mobile: '9988776655', vehicle_number: 'MH-01-2300' };

async function openDispatch(page: Page, source: 'released' | 'godown') {
  await page.goto('/tiles/orders/driver-order');
  await page.getByTestId('tile-order-actions-driver-item').click();
  await page.getByTestId(`tile-order-dispatch-${source}-driver-item`).click();
}

async function fixtureVisualViewport(page: Page) {
  // A real browser lays out and scrolls the sheet under synthetic keyboard
  // geometry. Running a desktop browser profile cannot open a phone keyboard.
  await page.addInitScript(initial => {
    const viewport = Object.assign(new EventTarget(), initial, { offsetTop: 0, offsetLeft: 0, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    window.addEventListener('dispatch-keyboard-geometry', event => {
      Object.assign(viewport, (event as CustomEvent).detail);
      viewport.dispatchEvent(new Event('resize'));
      viewport.dispatchEvent(new Event('scroll'));
    });
  }, page.viewportSize()!);
}

async function resizeVisualViewport(page: Page, height: number, offsetTop = 0) {
  await page.evaluate(detail => {
    window.dispatchEvent(new CustomEvent('dispatch-keyboard-geometry', { detail }));
  }, { height, offsetTop });
}

async function expectInsideKeyboardViewport(field: Locator) {
  await expect.poll(() => field.evaluate(element => {
    const viewport = window.visualViewport!;
    const box = element.getBoundingClientRect();
    let top = viewport.offsetTop;
    let bottom = top + viewport.height;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (!/auto|scroll|hidden|clip/.test(getComputedStyle(parent).overflowY)) continue;
      const bounds = parent.getBoundingClientRect();
      top = Math.max(top, bounds.top + parent.clientTop);
      bottom = Math.min(bottom, bounds.top + parent.clientTop + parent.clientHeight);
    }
    return box.height > 0 && box.top >= top - 1 && box.bottom <= bottom + 1;
  })).toBe(true);
}

for (const source of ['released', 'godown'] as const) test(`critical saved driver autofills editable details for dispatch from ${source}`, async ({ page }, info) => {
  await mockSession(page, '/tiles/orders/driver-order', false);
  const health = captureRuntimeHealth(page);
  await page.route('**/api/tile-orders/customer-orders/driver-order', route => route.fulfill({ json: { summary, suppliers: [group] } }));
  await page.route('**/api/tile-orders/drivers?**', route => {
    expect(route.request().headers()['x-floor-id']).toBe('ground-floor');
    return route.fulfill({ json: { drivers: [ramesh] } });
  });
  let body: any;
  await page.route(`**/api/tile-orders/purchase-orders/driver-po/dispatch-from-${source}`, route => {
    body = route.request().postDataJSON();
    return route.fulfill({ status: 409, json: { detail: 'Refresh quantities and retry.' } });
  });
  await openDispatch(page, source);
  await page.getByTestId('tile-dispatch-driver-search').fill('Ramesh');
  const option = page.getByRole('option', { name: 'Use driver Rameshbhai, 9876543210' });
  await expect(option).toBeVisible();
  expect((await option.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await option.click();
  await expect(page.getByTestId('tile-dispatch-driver-name')).toHaveValue('Rameshbhai');
  await expect(page.getByTestId('tile-dispatch-driver-mobile')).toHaveValue('987-654-32-10');
  await expect(page.getByTestId('tile-dispatch-vehicle-number')).toHaveValue('GJ-01-1000');
  await expect(page.getByTestId('tile-dispatch-receiver-name')).toHaveValue('');
  await expect(page.getByTestId('tile-dispatch-reference-number')).toHaveValue('');
  await page.getByTestId('tile-dispatch-vehicle-number').fill('GJ-01-2000');
  await page.getByTestId('tile-dispatch-receiver-name').fill('This trip receiver');
  await page.getByRole('button', { name: 'Confirm Dispatch', exact: true }).click();
  await expect.poll(() => body?.driver_mobile).toBe('9876543210');
  expect(body).toMatchObject({ driver_name: 'Rameshbhai', vehicle_number: 'GJ-01-2000', receiver_name: 'This trip receiver', items: [{ po_item_id: 'driver-item', qty: source === 'released' ? 4 : 6 }] });
  await expect(page.getByText('Refresh quantities and retry.', { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId('tile-dispatch-vehicle-number')).toHaveValue('GJ-01-2000');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath(`driver-${source}.png`), fullPage: true });
  await health.assertHealthy();
});

test('critical Godown dispatch searches from one character and supports keyboard selection', async ({ page }) => {
  await mockSession(page, '/tiles/orders/driver-order', false);
  const health = captureRuntimeHealth(page);
  await page.route('**/api/tile-orders/customer-orders/driver-order', route => route.fulfill({ json: { summary, suppliers: [group] } }));
  const responses: Record<string, typeof ramesh[]> = { h: [ramesh, harsh], ha: [harsh], '987': [ramesh], gj: [ramesh], z: [] };
  const requests: string[] = [];
  await page.route('**/api/tile-orders/drivers?**', route => {
    const search = new URL(route.request().url()).searchParams.get('search') ?? '';
    requests.push(search);
    return route.fulfill({ json: { drivers: responses[search] ?? [] } });
  });
  await openDispatch(page, 'godown');
  const search = page.getByRole('combobox', { name: /search saved driver/i });
  const list = page.getByRole('listbox');
  const receiver = page.getByTestId('tile-dispatch-receiver-name');
  await receiver.fill('Trip receiver');

  await search.fill('H');
  await expect(search).toHaveValue('H');
  await expect(list.getByRole('option')).toHaveCount(2);
  await expect(search).toHaveAttribute('aria-expanded', 'true');
  await search.fill('H ');
  await expect(list.getByRole('option')).toHaveCount(2);
  await search.press('Escape');
  await expect(search).toBeFocused();
  await expect(search).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('dialog', { name: 'Dispatch from Godown' })).toBeVisible();
  await search.fill('Ha');
  await expect(list.getByRole('option')).toHaveCount(1);
  await expect(list.getByRole('option')).toHaveAccessibleName(/Harsh/);
  await search.fill('987');
  await expect(list.getByRole('option')).toHaveAccessibleName(/Rameshbhai/);
  await search.fill('Z');
  await expect(page.getByText('No saved drivers match.', { exact: true })).toBeVisible();
  await search.fill('GJ');
  const option = list.getByRole('option', { name: /Rameshbhai/ });
  await expect(option).toBeVisible();
  await expect(search).toHaveAttribute('aria-controls', await list.getAttribute('id') ?? 'missing-list-id');
  await search.press('ArrowDown');
  await expect(search).toBeFocused();
  await expect(search).toHaveAttribute('aria-activedescendant', await option.getAttribute('id') ?? 'missing-option-id');
  await expect(option).toHaveAttribute('aria-selected', 'true');
  await search.press('Enter');
  await expect(search).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('tile-dispatch-driver-name')).toHaveValue('Rameshbhai');
  await expect(page.getByTestId('tile-dispatch-driver-mobile')).toHaveValue('987-654-32-10');
  await expect(page.getByTestId('tile-dispatch-vehicle-number')).toHaveValue('GJ-01-1000');
  await expect(receiver).toHaveValue('Trip receiver');
  expect(requests).toEqual(['h', 'ha', '987', 'z', 'gj']);
  await health.assertHealthy();
});

test('critical Godown dispatch exposes the active field and suggestions while the keyboard covers the sheet', async ({ page, hasTouch }, info) => {
  test.skip(!hasTouch, 'Software keyboard and touch-browser viewport geometry');
  const { width, height: fullHeight } = page.viewportSize()!;
  const keyboardHeight = Math.min(305, Math.round(fullHeight * 0.62));
  await fixtureVisualViewport(page);
  await mockSession(page, '/tiles/orders/driver-order', false);
  const health = captureRuntimeHealth(page);
  await page.route('**/api/tile-orders/customer-orders/driver-order', route => route.fulfill({ json: { summary, suppliers: [group] } }));
  await page.route('**/api/tile-orders/drivers?**', route => {
    expect(new URL(route.request().url()).searchParams.get('search')).toBe('h');
    return route.fulfill({ json: { drivers: [harsh, ramesh] } });
  });
  await openDispatch(page, 'godown');
  const sheet = page.getByRole('dialog', { name: 'Dispatch from Godown' });
  const confirm = sheet.getByRole('button', { name: 'Confirm Dispatch', exact: true });
  const cancel = sheet.getByRole('button', { name: 'Cancel', exact: true });
  const driverName = page.getByTestId('tile-dispatch-driver-name');
  await expect(confirm).toBeVisible();
  await driverName.focus();
  await expect(confirm).toBeVisible();
  await resizeVisualViewport(page, keyboardHeight, 48);
  await expect(confirm).toBeHidden();
  await expect(cancel).toBeHidden();
  await expectInsideKeyboardViewport(driverName);
  const field = await driverName.elementHandle();
  const namePosition = (await driverName.boundingBox())!.y;
  await page.keyboard.type('Visible while typing');
  await expect(driverName).toHaveValue('Visible while typing');
  expect(await field!.evaluate(node => node === document.activeElement)).toBe(true);
  expect((await driverName.boundingBox())!.y).toBeCloseTo(namePosition, 0);
  await expectInsideKeyboardViewport(driverName);

  const search = sheet.getByRole('combobox', { name: /search saved driver/i });
  await search.fill('H');
  const option = sheet.getByRole('option', { name: /Harsh/ });
  await expectInsideKeyboardViewport(search);
  await expectInsideKeyboardViewport(option);
  expect((await option.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: info.outputPath('godown-keyboard-open.png'), clip: { x: 0, y: 48, width, height: keyboardHeight } });
  await option.tap();
  await expect(driverName).toHaveValue('Harsh');

  const mobile = page.getByTestId('tile-dispatch-driver-mobile');
  await mobile.focus();
  await resizeVisualViewport(page, keyboardHeight - 25, 45);
  await expectInsideKeyboardViewport(mobile);
  expect(await mobile.evaluate(node => node.matches('input[type="tel"],input[inputmode="tel"],input[inputmode="numeric"]'))).toBe(true);
  await expect(mobile).toHaveValue('9988776655');
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await resizeVisualViewport(page, fullHeight);
  await expect(confirm).toBeVisible();
  await expect(cancel).toBeVisible();
  await expectInsideKeyboardViewport(confirm);
  await expect(mobile).toHaveValue('9988776655');
  await expect(page.getByTestId('tile-dispatch-vehicle-number')).toHaveValue('MH-01-2300');
  await page.screenshot({ path: info.outputPath('godown-keyboard-dismissed.png') });
  await cancel.click();
  await expect(sheet).toBeHidden();
  await health.assertHealthy();
});

test('critical dispatch-board creation reuses a driver without copying trip fields', async ({ page }) => {
  await mockSession(page, '/tiles/orders?tab=dispatch-list', false);
  const health = captureRuntimeHealth(page);
  await page.route('**/api/tile-orders/dispatches?**', route => route.fulfill({ json: { rows: [], page: 1, total: 0, has_more: false } }));
  await page.route('**/api/tile-orders/customer-orders?**', route => route.fulfill({ json: { orders: [{ ...summary, brands: [{ brand_name: 'Tile brand' }] }], page: 1, total: 1, has_more: false } }));
  await page.route('**/api/tile-orders/customer-orders/driver-order', route => route.fulfill({ json: { summary, suppliers: [group] } }));
  await page.route('**/api/tile-orders/drivers?**', route => route.fulfill({ json: { drivers: [ramesh] } }));
  await page.goto('/tiles/orders?tab=dispatch-list');
  await page.getByTestId('tile-orders-create-dispatch').click();
  await page.getByTestId('tile-create-dispatch-order-driver-order').click();
  await page.getByTestId('tile-create-dispatch-group-driver-po').click();
  await page.getByTestId('tile-create-dispatch-driver-search').fill('9876');
  await page.getByRole('option', { name: 'Use driver Rameshbhai, 9876543210' }).click();
  await expect(page.getByTestId('tile-create-dispatch-driver-name')).toHaveValue('Rameshbhai');
  await expect(page.getByTestId('tile-create-dispatch-driver-mobile')).toHaveValue('987-654-32-10');
  await expect(page.getByTestId('tile-create-dispatch-vehicle-number')).toHaveValue('GJ-01-1000');
  await expect(page.getByTestId('tile-create-dispatch-receiver-name')).toHaveValue('');
  await expect(page.getByTestId('tile-create-dispatch-reference-number')).toHaveValue('');
  await health.assertHealthy();
});

test('critical Godown shows persisted quantities with their correct variants and units', async ({ page }, info) => {
  await mockSession(page, '/tiles/orders?tab=inventory', false);
  const health = captureRuntimeHealth(page);
  const rows = [
    { id: 'box-lot', customer: 'Godown customer', name: 'Ivory', brand: 'Tile brand', product: 'IVORY-MATT', size: '600x600', finish: 'Matt', quantity: 4, quantity_unit: 'Box', arrival_date: '2026-11-01' },
    { id: 'piece-lot', customer: 'Godown customer', name: 'Ivory', brand: 'Tile brand', product: 'IVORY-GLOSSY', size: '1200x2400', finish: 'Glossy', quantity: 5, quantity_unit: 'Pieces', arrival_date: '2026-11-01' },
  ];
  await page.route('**/api/tile-orders/inventory?**', route => route.fulfill({ json: { rows, page: 1, page_size: 30, total: 2, has_more: false } }));
  await page.goto('/tiles/orders?tab=inventory');
  for (let refresh = 0; refresh < 2; refresh++) {
    const table = page.getByTestId('tile-orders-inventory-table');
    await expect(table.getByText('4 boxes', { exact: true })).toBeVisible();
    await expect(table.getByText('5 pieces', { exact: true })).toBeVisible();
    await expect(table.getByText('Ivory · Matt', { exact: true })).toBeVisible();
    await expect(table.getByText('Ivory · Glossy', { exact: true })).toBeVisible();
    if (refresh === 0) await page.reload();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('godown-quantities.png'), fullPage: true });
  await health.assertHealthy();
});
