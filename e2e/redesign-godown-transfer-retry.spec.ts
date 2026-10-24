import { expect, test, type Page } from '@playwright/test';
import { mockSession } from './audit-fixtures';

async function fixture(page: Page) {
  await mockSession(page, '/godown-stock', false);
  const lot = { id: 'retry-stock', product_id: 'godown:retry-stock', sku: 'RETRY-1', name: 'Retry basin',
    qty_received: 5, available_qty: 5, transferable_qty: 5, unit_price: 100, stock_value: 500 };
  const reads: string[] = [];
  await page.route('**/api/godown-stock?**', route => {
    reads.push(route.request().headers()['x-floor-id']);
    return route.fulfill({ json: { lots: [lot], brands: [], total_available_qty: 5, total_stock_value: 500, unpriced_lot_count: 0 } });
  });
  await page.route('**/api/customers', route => {
    expect(route.request().headers()['x-floor-id']).toBe('first-floor');
    return route.fulfill({ json: [{ id: 'recipient', name: 'Transfer recipient' }] });
  });
  await page.route('**/api/godown-stock/retry-stock/po-final-matches', route => {
    expect(route.request().headers()['x-floor-id']).toBe('first-floor');
    return route.fulfill({ json: { matches: [] } });
  });
  return { reads };
}

test('critical uncertain stock transfer retains its original command through close and reopen', async ({ page }, info) => {
  await fixture(page);
  const commands: Record<string, unknown>[] = [];
  await page.route('**/api/godown-stock/retry-stock/customer-transfers', route => {
    expect(route.request().headers()['x-floor-id']).toBe('first-floor');
    commands.push(route.request().postDataJSON());
    return route.fulfill(commands.length === 1 ? { status: 504, json: { detail: 'Transfer response was lost' } }
      : { json: { id: 'confirmed', idempotent: true, recipient_customer_name: 'Transfer recipient' } });
  });
  await page.goto('/godown-stock');
  const open = page.getByRole('button', { name: 'Transfer Retry basin to a customer', exact: true });
  await open.click();
  await page.getByTestId('godown-recipient-recipient').click();
  await page.getByTestId('godown-transfer-qty').fill('2');
  await page.getByRole('textbox', { name: 'Transfer reason', exact: true }).fill('Reviewed warehouse transfer');
  await page.getByTestId('godown-customer-transfer-submit').click();
  await expect(page.getByTestId('godown-transfer-error')).toContainText('Transfer response was lost');
  await expect(page.getByTestId('godown-transfer-qty')).not.toBeEditable();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByTestId('godown-customer-transfer-submit')).toHaveCount(0);
  await open.click();
  await expect(page.getByTestId('godown-transfer-qty')).toHaveValue('2');
  await expect(page.getByTestId('godown-transfer-qty')).not.toBeEditable();
  await expect(page.getByTestId('godown-transfer-error')).toContainText('previous transfer has not been confirmed');
  await page.screenshot({ path: info.outputPath('uncertain-transfer-recovery.png'), fullPage: true });
  await page.getByTestId('godown-customer-transfer-submit').click();
  await expect(page.getByTestId('godown-customer-transfer-submit')).toHaveCount(0);
  expect(commands).toHaveLength(2);
  expect(commands[1]).toEqual(commands[0]);
  expect(commands[0].idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
});

test('critical retrying transfer recipients retains the entered customer and quantity', async ({ page }) => {
  await fixture(page);
  let reads = 0;
  await page.route('**/api/customers', route => {
    reads += 1;
    return route.fulfill(reads === 1 ? { status: 503, json: { detail: 'Recipient service unavailable' } } : { json: [] });
  });
  await page.goto('/godown-stock');
  await page.getByRole('button', { name: 'Transfer Retry basin to a customer', exact: true }).click();
  await page.getByRole('tab', { name: 'New customer', exact: true }).click();
  await page.getByRole('textbox', { name: 'New customer name', exact: true }).fill('Reviewed recipient');
  await page.getByTestId('godown-transfer-qty').fill('3');
  await page.getByRole('button', { name: 'Retry transfer recipients', exact: true }).click();
  await expect(page.getByTestId('godown-customer-transfer-submit')).toBeEnabled();
  await expect(page.getByRole('textbox', { name: 'New customer name', exact: true })).toHaveValue('Reviewed recipient');
  await expect(page.getByTestId('godown-transfer-qty')).toHaveValue('3');
  expect(reads).toBe(2);
});

test('critical a rejected transfer retry can be corrected without changing its command key', async ({ page }) => {
  await fixture(page);
  const commands: Record<string, unknown>[] = [];
  await page.route('**/api/godown-stock/retry-stock/customer-transfers', route => {
    commands.push(route.request().postDataJSON());
    return route.fulfill(commands.length === 1 ? { status: 504, json: { detail: 'Transfer response lost' } }
      : commands.length === 2 ? { status: 422, json: { detail: 'Review transfer quantity' } }
        : { json: { id: 'corrected', recipient_customer_name: 'Transfer recipient' } });
  });
  await page.goto('/godown-stock');
  await page.getByRole('button', { name: 'Transfer Retry basin to a customer', exact: true }).click();
  await page.getByTestId('godown-recipient-recipient').click();
  await page.getByTestId('godown-customer-transfer-submit').click();
  await expect(page.getByTestId('godown-transfer-qty')).not.toBeEditable();
  await page.getByTestId('godown-customer-transfer-submit').click();
  await expect(page.getByTestId('godown-transfer-error')).toContainText('Review transfer quantity');
  await expect(page.getByTestId('godown-transfer-qty')).toBeEditable();
  await page.getByTestId('godown-transfer-qty').fill('1');
  await page.getByTestId('godown-customer-transfer-submit').click();
  await expect(page.getByTestId('godown-customer-transfer-submit')).toHaveCount(0);
  expect(commands).toHaveLength(3);
  expect(commands[0].idempotency_key).toBe(commands[1].idempotency_key);
  expect(commands[0].idempotency_key).toBe(commands[2].idempotency_key);
  expect(commands[2].qty).toBe(1);
});

test('critical pending stock transfer cannot be dismissed or submitted twice', async ({ page }) => {
  await fixture(page);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let writes = 0;
  await page.route('**/api/godown-stock/retry-stock/customer-transfers', async route => {
    writes += 1;
    await pending;
    return route.fulfill({ json: { id: 'confirmed', recipient_customer_name: 'Transfer recipient' } });
  });
  await page.goto('/godown-stock');
  await page.getByRole('button', { name: 'Transfer Retry basin to a customer', exact: true }).click();
  await page.getByTestId('godown-recipient-recipient').click();
  await page.getByTestId('godown-customer-transfer-submit').evaluate(button => { (button as HTMLElement).click(); (button as HTMLElement).click(); });
  await expect.poll(() => writes).toBe(1);
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('godown-customer-transfer-submit')).toBeVisible();
  await expect(page.getByTestId('godown-transfer-qty')).not.toBeEditable();
  release();
  await expect(page.getByTestId('godown-customer-transfer-submit')).toHaveCount(0);
  expect(writes).toBe(1);
});

test('critical a committed transfer conflict is reviewed before starting another transfer', async ({ page }, info) => {
  await fixture(page);
  const commands: Record<string, unknown>[] = [];
  await page.route('**/api/godown-stock/retry-stock/customer-transfers', route => {
    commands.push(route.request().postDataJSON());
    return route.fulfill(commands.length === 1 ? { status: 409, json: { detail: {
      code: 'godown_transfer_already_recorded', message: 'A transfer is already recorded', transfer: {
        id: 'original-receipt', stock_id: 'retry-stock', floor_id: 'first-floor', qty: 2,
        recipient_customer_name: 'Original recipient', created_at: '2026-10-25T00:00:00Z',
      },
    } } } : { json: { id: 'next-receipt', recipient_customer_name: 'Transfer recipient' } });
  });
  await page.goto('/godown-stock');
  const open = page.getByRole('button', { name: 'Transfer Retry basin to a customer', exact: true });
  await open.click(); await page.getByTestId('godown-recipient-recipient').click();
  await page.getByTestId('godown-customer-transfer-submit').click();
  await expect(page.getByTestId('godown-recorded-transfer')).toContainText('2 units to Original recipient');
  await expect(page.getByTestId('godown-customer-transfer-submit')).toHaveCount(0);
  await expect(page.getByTestId('godown-transfer-qty')).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await open.click();
  await expect(page.getByTestId('godown-recorded-transfer')).toContainText('original-receipt');
  await page.screenshot({ path: info.outputPath('recorded-transfer-review.png'), fullPage: true });
  await page.getByRole('button', { name: 'Acknowledge recorded stock transfer', exact: true }).click();
  await expect(page.getByTestId('godown-recorded-transfer')).toHaveCount(0);
  await open.click(); await page.getByTestId('godown-recipient-recipient').click();
  await page.getByTestId('godown-customer-transfer-submit').click();
  await expect(page.getByTestId('godown-customer-transfer-submit')).toHaveCount(0);
  expect(commands).toHaveLength(2);
  expect(commands[1].idempotency_key).not.toBe(commands[0].idempotency_key);
});

test('critical removed customer history resolves a transfer without recreating the customer', async ({ page }, info) => {
  await fixture(page);
  let writes = 0;
  await page.route('**/api/godown-stock/retry-stock/customer-transfers', route => {
    writes += 1;
    return route.fulfill({ status: 410, json: { detail: {
      code: 'godown_transfer_record_removed', message: 'This transfer was completed, but its customer history has been removed.',
      transfer: { id: 'removed-history-receipt', stock_id: 'retry-stock', floor_id: 'first-floor', qty: 2,
        recipient_customer_name: 'Customer record removed', history_removed: true, status: 'completed' },
    } } });
  });
  await page.goto('/godown-stock');
  await page.getByRole('button', { name: 'Transfer Retry basin to a customer', exact: true }).click();
  await page.getByTestId('godown-recipient-recipient').click();
  await page.getByTestId('godown-customer-transfer-submit').click();
  await expect(page.getByTestId('godown-recorded-transfer')).toContainText('2 units to Customer record removed');
  await expect(page.getByTestId('godown-transfer-error')).toContainText('customer history has been removed');
  await expect(page.getByTestId('godown-customer-transfer-submit')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('removed-transfer-history.png'), fullPage: true });
  await page.getByRole('button', { name: 'Acknowledge recorded stock transfer', exact: true }).click();
  await expect(page.getByTestId('godown-recorded-transfer')).toHaveCount(0);
  expect(writes).toBe(1);
});
