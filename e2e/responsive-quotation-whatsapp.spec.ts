import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

const draft = {
  id: 'wa-quotation', floor_id: 'first-floor', phone: '919909906652', customer_name: 'Mira Shah',
  filename: 'Mira Shah.pdf', expected_updated_at: '2026-10-01T10:00:00Z',
  include_dimensions: false, direct_send_configured: true,
};

async function installFileSharing(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
    Object.defineProperty(navigator, 'share', { configurable: true, value: async (payload: ShareData) => {
      const file = payload.files?.[0];
      (window as unknown as { sharedPdf: unknown }).sharedPdf = {
        filename: file?.name, type: file?.type, content: await file?.text(), url: payload.url,
      };
    } });
  });
}

async function mockQuotationDetail(page: import('@playwright/test').Page, id: string) {
  await page.route(new RegExp(`/api/quotations/${id}(?:\\?.*)?$`), route => route.fulfill({ json: {
    id, number: 'Q-WA', customer_name: 'Mira Shah', status: 'draft', floor_id: 'first-floor',
    items: [{ id: 'line', sku: 'B-1', name: 'Basin', qty: 1, unit_price: 200, discount_pct: 0, room: 'Bathroom' }], rooms: ['Bathroom'],
    subtotal: 200, discount_total: 0, grand_total: 200, created_at: '2026-10-01T10:00:00Z', created_by_name: 'Audit Owner',
  } }));
  await page.route(`**/api/quotations/${id}/breakdown`, route => route.fulfill({ json: { lines: [], totals: { subtotal: 200, discount_total: 0, grand_total: 200 }, project_discount_pct: 0, category_discounts: {} } }));
  await page.route(`**/api/activity/quotation/${id}`, route => route.fulfill({ json: [] }));
  await page.route(`**/api/purchase-orders?quotation_id=${id}`, route => route.fulfill({ json: [] }));
}

test('quotation sends PDF directly with current contact and editable message without exposing a link', async ({ page }) => {
  await mockSession(page, '/quotations/wa-quotation', false);
  await mockQuotationDetail(page, 'wa-quotation');
  let prepared = 0, sends = 0;
  await page.route('**/api/quotations/wa-quotation/whatsapp-draft**', route => {
    expect(route.request().headers()['x-floor-id']).toBe('first-floor');
    expect(route.request().method()).toBe('POST'); prepared++;
    return route.fulfill({ json: draft });
  });
  await page.route('**/api/quotations/wa-quotation/whatsapp-send', route => {
    sends++;
    const body = route.request().postDataJSON();
    expect(route.request().headers()['x-floor-id']).toBe('first-floor');
    expect(body.message).toBe('Hey Mira, please review Basin & Shower #2.');
    expect(body.expected_updated_at).toBe(draft.expected_updated_at);
    expect(body.idempotency_key).toMatch(/^quotation_/);
    expect(body).not.toHaveProperty('url');
    return route.fulfill({ json: { status: 'accepted' } });
  });
  await page.route('**/api/whatsapp/deliveries/wa-quotation/**', route => route.fulfill({ json: { status: 'delivered' } }));
  await page.goto('/quotations/wa-quotation');
  await page.getByTestId('quotation-whatsapp-draft').click();
  await expect(page.getByTestId('quotation-whatsapp-sheet')).toBeVisible();
  await expect(page.getByTestId('quotation-whatsapp-message')).toHaveValue('Hey Mira Shah, here is your quotation.');
  await expect(page.getByText('Mira Shah · +919909906652')).toBeVisible();
  await expect(page.getByRole('button', { name: /link|draft/i })).toHaveCount(0);
  await page.getByTestId('quotation-whatsapp-message').fill('Hey Mira, please review Basin & Shower #2.');
  await page.getByTestId('send-quotation-pdf-whatsapp').click();
  await expect(page.getByText('PDF submitted to WhatsApp')).toBeVisible();
  await expect(page.getByTestId('send-quotation-pdf-whatsapp')).toBeDisabled();
  await page.getByTestId('refresh-quotation-pdf-status').click();
  await expect(page.getByText('PDF delivery: delivered')).toBeVisible();
  expect(prepared).toBe(1); expect(sends).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('PDF attachment sharing stays available without WhatsApp provider or customer phone', async ({ page }) => {
  await mockSession(page, '/quotations/no-phone', false);
  await installFileSharing(page);
  await mockQuotationDetail(page, 'no-phone');
  await page.route('**/api/quotations/no-phone/whatsapp-draft**', route => route.fulfill({ json: {
    ...draft, id: 'no-phone', phone: null, direct_send_configured: false,
  } }));
  await page.route('**/api/quotations/no-phone/pdf?**', route => {
    expect(route.request().headers()['x-floor-id']).toBe('first-floor');
    return route.fulfill({ contentType: 'application/pdf', body: '%PDF-1.4 actual attachment' });
  });
  await page.goto('/quotations/no-phone');
  await page.getByTestId('quotation-whatsapp-draft').click();
  await expect(page.getByTestId('send-quotation-pdf-whatsapp')).toHaveCount(0);
  await page.getByTestId('share-quotation-pdf-file').click();
  await expect(page.getByTestId('mobile-file-save')).toBeVisible();
  await page.getByRole('button', { name: 'Save or share', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { sharedPdf: unknown }).sharedPdf)).toEqual({
    filename: 'Mira Shah.pdf', type: 'application/pdf', content: '%PDF-1.4 actual attachment',
  });
  await expect(page.getByTestId('mobile-file-save')).not.toBeVisible();
});

for (const kind of ['sanitary', 'tiles_selection', 'tiles_quotation'] as const) {
  test(`${kind} quotation builder shares the PDF attachment with document floor on every viewport`, async ({ page }) => {
    const tiles = kind !== 'sanitary';
    const path = tiles ? `/tiles/${kind === 'tiles_selection' ? 'selection' : 'quotation'}` : '/quotations/new';
    const floorId = tiles ? 'ground-floor' : 'first-floor';
    await mockSession(page, path, false);
    await installFileSharing(page);
    const image = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#8b7253"/></svg>')}`;
    const savedDocument = {
      id: 'builder-wa', number: 'Q-BUILDER-WA', doc_type: tiles ? kind : 'standard', floor_id: floorId,
      customer_id: 'client', customer_name: 'Mira Shah', phone_snapshot: '9000000000', address_snapshot: 'Project site',
      status: 'draft', rooms: ['Bathroom'], subtotal: 1000, grand_total: 1000, transportation_fee: 0,
      items: [{ id: 'line', product_id: 'p1', sku: 'P-1', name: 'Fixture product', image, room: 'Bathroom',
        size: '600 × 600', unit_price: 100, rate_sqft: 50, rate_box: 100, qty: 10, quantity_unit: 'Box', net_amount: 1000 }],
      updated_at: '2026-10-01T10:00:00Z',
    };
    await page.route('**/api/customers', route => route.fulfill({ json: [{ id: 'client', name: 'Mira Shah', phone: '9909906652' }] }));
    await page.route('**/api/categories**', route => route.fulfill({ json: [] }));
    await page.route('**/api/brands**', route => route.fulfill({ json: [] }));
    await page.route('**/api/quotations/recent?**', route => route.fulfill({ json: [] }));
    await page.route('**/api/products/families?**', route => route.fulfill({ json: { total: 0, items: [] } }));
    await page.route('**/api/products/p1/size-variants', route => route.fulfill({ json: { available_sizes: ['600 × 600'] } }));
    await page.route(/\/api\/quotations\/builder-wa(?:\?.*)?$/, route => {
      if (route.request().method() === 'PATCH') expect(route.request().postDataJSON().status).not.toBe('sent');
      return route.fulfill({ json: savedDocument });
    });
    await page.route('**/api/quotations/builder-wa/whatsapp-draft**', route => {
      expect(route.request().method()).toBe('POST');
      expect(route.request().headers()['x-floor-id']).toBe(floorId);
      return route.fulfill({ json: { ...draft, id: 'builder-wa', floor_id: floorId, direct_send_configured: false } });
    });
    await page.route('**/api/quotations/builder-wa/pdf?**', route => {
      expect(route.request().headers()['x-floor-id']).toBe(floorId);
      return route.fulfill({ contentType: 'application/pdf', body: '%PDF-1.4 builder attachment' });
    });
    await page.goto(`${path}?quotationId=builder-wa`);
    if (!tiles) {
      await expect(page.getByTestId('quotation-workspace')).toBeVisible();
      const expand = page.getByTestId('expand-quotation-workspace');
      if (await expand.isVisible()) await expand.click();
    }
    const action = page.getByRole('button', { name: tiles ? 'Share PDF' : 'Share quotation PDF', exact: true });
    await expect(action).toBeEnabled({ timeout: 20_000 });
    await action.click();
    await expect(page.getByTestId('quotation-whatsapp-sheet')).toBeVisible();
    await expect(page.getByTestId('send-quotation-pdf-whatsapp')).toHaveCount(0);
    await page.getByTestId('share-quotation-pdf-file').click();
    await page.getByRole('button', { name: 'Save or share', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { sharedPdf: unknown }).sharedPdf)).toEqual({
      filename: 'Mira Shah.pdf', type: 'application/pdf', content: '%PDF-1.4 builder attachment',
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}
