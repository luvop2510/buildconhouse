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
  await page.route(/\/api\/furniture-quotations\/rmb-one(?:\?.*)?$/, route => {
    expect(route.request().method()).toBe('GET');
    expect(new URL(route.request().url()).searchParams.get('include_acquisition')).toBe('false');
    return route.fulfill({ json: saved });
  });
  await page.route('**/api/whatsapp/configuration', route => route.fulfill({ json: { configured, template_configured: false } }));
  await page.goto('/notebook/furniture-quotations');
  await page.getByRole('button', { name: 'Open RDCL', exact: true }).click();
}

test('furniture RNB ledger converts INR and USD, saves exact rates, and locks finalized charges', async ({ page }, testInfo) => {
  await fixture(page);
  await expect(page.getByLabel('Customer name / quotation heading (RDCL)', { exact: true })).toHaveValue('RDCL');
  await expect(page.getByTestId('furniture-ledger-preview')).toContainText('87035.35');
  const preview = await page.getByTestId('furniture-ledger-preview').boundingBox();
  await expect(page.getByText('Scroll horizontally to view all seven columns.', { exact: true })).toHaveCount(preview && preview.width < 1015 ? 1 : 0);
  await expect(page.getByTestId('furniture-summary')).toContainText('Balance RNB 87035.35');
  await expect(page.getByLabel('Accompanying WhatsApp message', { exact: true })).toHaveValue('Dear RDCL, please find your furniture quotation attached. Balance: RNB 87035.35.');
  await page.getByRole('button', { name: 'Add customer deposit', exact: true }).click();
  await page.getByText('USD', { exact: true }).last().click();
  await page.getByLabel('Deposit 2 amount (USD)', { exact: true }).fill('100');
  await page.getByLabel('Rate: RNB per USD (multiply)', { exact: true }).fill('7.1');
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
  await expect(page.getByLabel('Charge 1 RNB', { exact: true })).not.toBeEditable();
  await expect(page.getByLabel('Deposit 1 amount (INR)', { exact: true })).toBeEditable();
  expect(body.status).toBe('final');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('furniture-ledger.png'), fullPage: true });
});

test('saved RMB deposits display RNB throughout and retain the existing currency on save', async ({ page }) => {
  await fixture(page);
  const legacy = { ...saved, deposits: [{ ...saved.deposits[0], currency: 'RMB', amount: '100', rate: '1', amount_rmb: '100.00' }], total_received_rmb: '100.00', balance_rmb: '232438.00' };
  await page.route(/\/api\/furniture-quotations\/rmb-one(?:\?.*)?$/, route => route.fulfill({ json: legacy }));
  await page.getByRole('button', { name: 'Reload saved quotation', exact: true }).click();
  await expect(page.getByLabel('Deposit 1 amount (RNB)', { exact: true })).toHaveValue('100');
  await expect(page.getByLabel('RNB rate', { exact: true })).not.toBeEditable();
  await expect(page.getByText('RNB', { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId('furniture-ledger-preview')).toContainText('100 RNB');
  await expect(page.getByText(/\bRMB\b/)).toHaveCount(0);
  await page.getByLabel('Deposit 1 amount (RNB)', { exact: true }).fill('200');
  let persisted = false;
  await page.route('**/api/furniture-quotations/rmb-one', route => {
    const body = route.request().postDataJSON();
    expect(body.deposits[0]).toMatchObject({ currency: 'RMB', amount: '200', rate: '1' });
    persisted = true;
    return route.fulfill({ json: { ...legacy, ...body, total_received_rmb: '200.00', balance_rmb: '232338.00' } });
  });
  await page.getByRole('button', { name: 'Save quotation', exact: true }).click();
  await expect(page.getByTestId('furniture-summary')).toContainText('Balance RNB 232338.00');
  expect(persisted).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
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
  await page.getByLabel('Charge 1 RNB', { exact: true }).fill('172251');
  await expect(page.getByRole('button', { name: 'Download PDF', exact: true })).toBeDisabled();
  await expect(page.getByText('Save your changes before downloading or sending the PDF.', { exact: true })).toBeVisible();
});


test('furniture PDF file sharing works without a WhatsApp Business provider and exposes no link', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
    Object.defineProperty(navigator, 'share', { configurable: true, value: async (payload: ShareData) => {
      const file = payload.files?.[0];
      (window as unknown as { sharedPdf: unknown }).sharedPdf = {
        filename: file?.name, type: file?.type, content: await file?.text(), url: payload.url,
      };
    } });
  });
  await fixture(page, false);
  await page.route('**/api/furniture-quotations/rmb-one/pdf', route => {
    expect(route.request().headers()['x-floor-id']).toBe('third-floor');
    return route.fulfill({ contentType: 'application/pdf', body: '%PDF-1.4 furniture attachment' });
  });
  await page.getByTestId('share-furniture-quotation-pdf').click();
  await page.getByRole('button', { name: 'Save or share', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { sharedPdf: unknown }).sharedPdf)).toEqual({
    filename: 'RDCL.pdf', type: 'application/pdf', content: '%PDF-1.4 furniture attachment',
  });
  await expect(page.getByTestId('share-furniture-quotation-pdf')).toBeEnabled();
});

test('furniture quotations save the selected architect identity and show studio and customer count', async ({ page }) => {
  await fixture(page);
  await page.route('**/api/referrers?include_counts=true', route => {
    expect(route.request().headers()['x-floor-id']).toBe('third-floor');
    return route.fulfill({ json: [{ id: 'architect-nts', name: 'Nilesh', company: 'NTS Studio', type: 'architect', customers_acquired: 4 }] });
  });
  await page.route('**/api/furniture-quotations/rmb-one', route => {
    const body = route.request().postDataJSON();
    expect(body.referrer_id).toBe('architect-nts');
    expect(body).not.toHaveProperty('referrer_name');
    expect(body).not.toHaveProperty('referrer_type');
    return route.fulfill({ json: { ...saved, revision: 2, referrer_id: 'architect-nts',
      referrer_name: 'Nilesh', referrer_type: 'architect', referrer_company: 'NTS Studio', referrer_customers_acquired: 4 } });
  });
  await page.getByRole('button', { name: 'Referred By', exact: true }).click();
  await expect(page.getByTestId('customer-referrer-sheet')).toContainText('NTS Studio');
  await page.getByRole('button', { name: 'Nilesh', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Referred By', exact: true })).toContainText('ARC-ARCHITECT-NTS');
  await page.getByRole('button', { name: 'Save quotation', exact: true }).click();
  await expect(page.getByText('4 customers brought', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Referred By', exact: true })).toContainText('NTS Studio');
});
