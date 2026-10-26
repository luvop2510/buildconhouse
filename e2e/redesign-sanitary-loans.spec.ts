import { expect, test, type Page } from '@playwright/test';
import { mockSession } from './audit-fixtures';

async function loanOrder(page: Page, item: Record<string, unknown>) {
  const stages = ['po_final', 'order_in_company', 'company_billing', 'in_box', 'dispatched'].map(key => ({
    key, label: key === 'in_box' ? 'In Box' : key, count: 0, tone: { bg: '#eee', fg: '#222' },
  }));
  await page.route('**/api/purchases/stages', route => route.fulfill({ json: stages }));
  await page.route('**/api/purchases/loan-po/order-detail', route => route.fulfill({ json: {
    id: 'loan-po', number: 'PO-LOAN', customer_id: 'buyer', customer_name: 'Buyer',
    floor_id: 'first-floor', status: 'ordered', brand_name: 'Example Company',
    status_history: [], attachments: [], stage: 'order', remaining_qty_by_item: {},
    subtotal: 8400, grand_total: 8400, created_at: '2026-10-10T10:00:00Z', created_by_name: 'Audit Owner',
    items: [{ id: 'loan-item', product_id: 'basin', name: 'Basin', sku: 'BASIN',
      qty_received: 84, unit_cost: 100, stage: 'in_box', ...item }], chalans: [],
  } }));
  await page.goto('/purchase-orders/loan-po');
  await page.getByTestId('po-item-move-loan-item').click();
}

test('critical lending four units leaves eighty units available for dispatch', async ({ page }) => {
  await mockSession(page, '/purchase-orders/loan-po', false);
  const commands: Record<string, unknown>[] = [];
  await page.route('**/api/purchases/items/loan-item/move', route => {
    commands.push(route.request().postDataJSON());
    expect(route.request().headers()['x-floor-id']).toBe('first-floor');
    return route.fulfill({ json: { split: true, qty_moved: 80, qty_remaining: 4, to_stage: 'dispatched' } });
  });
  await loanOrder(page, { qty: 84, loaned_qty: 4 });
  await expect(page.getByTestId('movement-qty')).toHaveValue('80');
  await page.getByTestId('movement-stage-dispatched').click();
  await page.getByTestId('movement-move-submit').click();
  await expect(page.getByTestId('movement-move-submit')).toHaveCount(0);
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({ qty: 80, stage: 'dispatched' });
});

test('critical replacement has one return action and safely retries a lost return response', async ({ page }, info) => {
  await mockSession(page, '/purchase-orders/loan-po', false);
  let returns = 0;
  await page.route('**/api/purchases/items/loan-item/return-loans', route => {
    expect(route.request().headers()['x-floor-id']).toBe('first-floor');
    returns += 1;
    return route.fulfill(returns === 1
      ? { status: 504, json: { detail: 'Return response was lost; retry the same return' } }
      : { json: { item_id: 'loan-item', returned: [{ transfer_id: 'loan', status: 'returned', idempotent: true }] } });
  });
  await loanOrder(page, { qty: 4, qty_received: 4, loan_replenishment_promised_qty: 4,
    loan_replenishment_for_customer_name: 'Lending Customer', loan_replenishment_status: 'awaiting_return' });
  const submit = page.getByTestId('movement-move-submit');
  await expect(submit).toHaveAccessibleName('Return to Lending Customer');
  await expect(page.getByTestId('movement-stage-dispatched')).toHaveCount(0);
  await expect(page.getByTestId('movement-godown-submit')).toHaveCount(0);
  await expect(page.getByTestId('movement-qty')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('reserved-return-only.png') });
  await submit.click();
  await expect(page.getByTestId('movement-move-error')).toContainText('Return response was lost');
  await submit.click();
  await expect(submit).toHaveCount(0);
  expect(returns).toBe(2);
});
