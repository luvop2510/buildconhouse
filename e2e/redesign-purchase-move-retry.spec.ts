import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

test('critical partial purchase movement retries its original command after a lost response', async ({ page }, info) => {
  await mockSession(page, '/purchase-orders/retry-po', false);
  const stages = ['po_final', 'order_in_company', 'company_billing', 'in_box', 'dispatched'].map(key => ({
    key, label: key === 'in_box' ? 'In Box' : key, count: 0, tone: { bg: '#eeeeee', fg: '#222222' },
  }));
  await page.route('**/api/purchases/stages', route => route.fulfill({ json: stages }));
  await page.route('**/api/purchases/retry-po/order-detail', route => route.fulfill({ json: {
    id: 'retry-po', number: 'PO-RETRY', customer_id: 'retry-buyer', customer_name: 'Movement Buyer',
    floor_id: 'first-floor', status: 'ordered', brand_name: 'Example Company',
    status_history: [], attachments: [], stage: 'order', remaining_qty_by_item: {},
    subtotal: 1000, grand_total: 1000, created_at: '2026-10-10T10:00:00Z', created_by_name: 'Audit Owner',
    items: [{ id: 'retry-item', product_id: 'retry-product', name: 'Warehouse mixer', sku: 'RETRY-MIXER',
      qty: 10, qty_received: 0, unit_cost: 100, stage: 'order_in_company' }], chalans: [],
  } }));
  const commands: Record<string, unknown>[] = [];
  await page.route('**/api/purchases/items/retry-item/move', route => {
    commands.push(route.request().postDataJSON());
    expect(route.request().headers()['x-floor-id']).toBe('first-floor');
    return route.fulfill(commands.length === 1
      ? { status: 504, json: { detail: 'Movement response lost. Retry the same command.' } }
      : { json: { po_id: 'retry-po', item_id: 'retry-item', new_item_id: 'split-child', split: true,
        qty_moved: 3, qty_remaining: 7, to_stage: 'in_box', idempotent: true } });
  });
  await page.goto('/purchase-orders/retry-po');
  await page.getByTestId('po-item-move-retry-item').click();
  await page.getByTestId('movement-qty').fill('3');
  await page.getByTestId('movement-stage-in_box').click();
  const submit = page.getByTestId('movement-move-submit');
  await submit.click();
  await expect.poll(() => commands.length).toBe(1);
  await expect(submit).toBeEnabled();
  await expect(page.getByTestId('movement-move-error')).toContainText('Movement response lost');
  await expect(page.getByTestId('movement-qty')).toHaveValue('3');
  await page.screenshot({ path: info.outputPath('partial-move-retry-draft.png') });
  await submit.click();
  await expect(submit).toHaveCount(0);
  expect(commands).toHaveLength(2);
  expect(commands[1]).toEqual(commands[0]);
  expect(commands[0]).toMatchObject({ stage: 'in_box', qty: 3 });
  expect(commands[0].idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
});
