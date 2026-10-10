import { expect, test, type Page } from '@playwright/test';
import { mockSession } from './audit-fixtures';

const timestamp = '2026-10-10T06:00:00Z';
const saved = {
  id: 'rmb-one', customer_name: 'RDCL', customer_phone: '9909906652', floor_id: 'third-floor', status: 'draft', revision: 1,
  created_at: timestamp, updated_at: timestamp,
  charges: [{ id: 'charge1', description: 'TOTAL PURCHASE', amount_rmb: '172250.00', created_at: timestamp, updated_at: timestamp },
    { id: 'charge2', description: 'CHARGE', amount_rmb: '60288.00', created_at: timestamp, updated_at: timestamp }],
  deposits: [{ id: 'deposit1', description: 'Deposit by customer', currency: 'INR', amount: '2200000', rate: '15.12', amount_rmb: '145502.65', created_at: timestamp, updated_at: timestamp }],
  total_payable_rmb: '232538.00', total_received_rmb: '145502.65', balance_rmb: '87035.35',
};
async function fixture(page: Page, configured = true) {
  await mockSession(page, '/notebook/furniture-quotations', false);
  await page.addInitScript(() => localStorage.setItem('forge.active-floor', JSON.stringify('third-floor')));
  await page.route('**/api/furniture-quotations', route => {
    expect(route.request().headers()['x-floor-id']).toBe('third-floor');
    return route.fulfill({ json: { rows: [saved], next_cursor: null } });
  });
  await page.route('**/api/furniture-quotations/rmb-one', route => route.fulfill({ json: saved }));
  await page.route('**/api/whatsapp/configuration', route => route.fulfill({ json: { configured, template_configured: false } }));
  await page.goto('/notebook/furniture-quotations');
  await page.getByRole('button', { name: 'Open RDCL', exact: true }).click();
}

test('furniture RMB ledger converts INR and USD, saves exact rates, and locks finalized charges', async ({ page }, testInfo) => {
  await fixture(page);
  await expect(page.getByLabel('Customer name / quotation heading (RDCL)', { exact: true })).toHaveValue('RDCL');
  await expect(page.getByTestId('furniture-ledger-preview')).toContainText('87035.35');
  await page.getByRole('button', { name: 'Add customer deposit', exact: true }).click();
  await page.getByText('USD', { exact: true }).last().click();
  await page.getByLabel('Deposit 2 amount (USD)', { exact: true }).fill('100');
  await page.getByLabel('Rate: RMB per USD (multiply)', { exact: true }).fill('7.1');
  await expect(page.getByTestId('furniture-ledger-preview')).toContainText('86325.35');
  let body: any;
  await page.route('**/api/furniture-quotations/rmb-one', route => {
    body = route.request().postDataJSON();
    expect(route.request().headers()['x-floor-id']).toBe('third-floor');
    expect(body.expected_updated_at).toBe(timestamp);
    expect(body.deposits[1]).toMatchObject({ currency: 'USD', amount: '100', rate: '7.1' });
    return route.fulfill({ json: { ...saved, ...body, revision: 2, updated_at: '2026-10-10T07:00:00Z',
      deposits: [...saved.deposits, { ...body.deposits[1], id: 'deposit2', amount_rmb: '710.00', created_at: timestamp, updated_at: timestamp }],
      total_received_rmb: '146212.65', balance_rmb: '86325.35' } });
  });
  await page.getByRole('button', { name: 'Finalize and lock charges', exact: true }).click();
  await expect(page.getByText('Finalized charges are locked. Customer deposits can still be recorded.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Charge 1 RMB', { exact: true })).not.toBeEditable();
  await expect(page.getByLabel('Deposit 1 amount (INR)', { exact: true })).toBeEditable();
  expect(body.status).toBe('final');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('furniture-ledger.png'), fullPage: true });
});

test('direct furniture WhatsApp sends the PDF with editable message and refreshes real receipt', async ({ page }) => {
  await fixture(page);
  let sends = 0;
  await page.route('**/api/furniture-quotations/rmb-one/whatsapp-send', route => {
    sends++;
    const body = route.request().postDataJSON();
    expect(body.message).toBe('Hey RDCL, please review the attached quotation.');
    expect(body.expected_updated_at).toBe(timestamp);
    expect(body.idempotency_key).toMatch(/^[A-Za-z0-9_-]{16,100}$/);
    expect(route.request().headers()['x-floor-id']).toBe('third-floor');
    return route.fulfill({ json: { status: 'accepted', message_id: 'wamid.unit', idempotency_key: body.idempotency_key, updated_at: timestamp } });
  });
  await page.route('**/api/whatsapp/deliveries/rmb-one/*', route => route.fulfill({ json: { status: 'delivered', message_id: 'wamid.unit', updated_at: timestamp } }));
  await page.getByLabel('Accompanying WhatsApp message', { exact: true }).fill('Hey RDCL, please review the attached quotation.');
  await page.getByRole('button', { name: 'Send PDF to WhatsApp', exact: true }).click();
  await expect(page.getByText(/WhatsApp status: accepted/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send PDF to WhatsApp', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Refresh delivery status', exact: true }).click();
  await expect(page.getByText(/WhatsApp status: delivered/)).toBeVisible();
  expect(sends).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('unconfigured WhatsApp and unsaved edits do not claim a send', async ({ page }) => {
  await fixture(page, false);
  await expect(page.getByRole('button', { name: 'Send PDF to WhatsApp', exact: true })).toBeDisabled();
  await expect(page.getByText(/Direct WhatsApp sending needs a WhatsApp Business sender/)).toBeVisible();
  await page.getByLabel('Charge 1 RMB', { exact: true }).fill('172251');
  await expect(page.getByRole('button', { name: 'Download PDF', exact: true })).toBeDisabled();
  await expect(page.getByText('Save your changes before downloading or sending the PDF.', { exact: true })).toBeVisible();
});
