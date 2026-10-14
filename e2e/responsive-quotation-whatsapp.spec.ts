import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

const draft = {
  phone: '919909906652', customer_name: 'Mira Shah', pdf_path: `/api/quotations/shared-pdf/${'a'.repeat(43)}`,
  filename: 'Mira Shah.pdf', expires_at: '2099-10-11T00:00:00Z', expires_in: 86400,
};

test('quotation WhatsApp draft uses current contact and editable message without marking sent', async ({ page }) => {
  await mockSession(page, '/quotations/wa-quotation', false);
  await page.addInitScript(() => {
    const original = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.href.startsWith('https://wa.me/')) {
        (window as unknown as { whatsappDraftUrl: string }).whatsappDraftUrl = this.href;
      } else original.call(this);
    };
  });
  let quotationMutations = 0;
  await page.route(/\/api\/quotations\/wa-quotation(?:\?.*)?$/, async route => {
    if (route.request().method() !== 'GET') quotationMutations++;
    await route.fulfill({ json: {
      id: 'wa-quotation', number: 'Q-WA', customer_name: 'Mira Shah', status: 'draft', floor_id: 'first-floor',
      items: [{ id: 'line', sku: 'B-1', name: 'Basin', qty: 1, unit_price: 200, discount_pct: 0, room: 'Bathroom' }], rooms: ['Bathroom'],
      subtotal: 200, discount_total: 0, grand_total: 200, created_at: '2026-10-01T10:00:00Z', created_by_name: 'Audit Owner',
    } });
  });
  await page.route('**/api/quotations/wa-quotation/breakdown', route => route.fulfill({ json: { lines: [], totals: { subtotal: 200, discount_total: 0, grand_total: 200 }, project_discount_pct: 0, category_discounts: {} } }));
  await page.route('**/api/activity/quotation/wa-quotation', route => route.fulfill({ json: [] }));
  await page.route('**/api/purchase-orders?quotation_id=wa-quotation', route => route.fulfill({ json: [] }));
  let prepared = 0;
  let revoked = 0;
  await page.route('**/api/quotations/wa-quotation/whatsapp-draft**', route => {
    expect(route.request().headers()['x-floor-id']).toBe('first-floor');
    if (route.request().method() === 'DELETE') { revoked++; return route.fulfill({ json: { revoked: true } }); }
    expect(route.request().method()).toBe('POST'); prepared++;
    return route.fulfill({ json: draft });
  });
  await page.goto('/quotations/wa-quotation');
  await expect(page.getByRole('button', { name: /mark.*sent/i })).toHaveCount(0);
  await page.getByTestId('quotation-whatsapp-draft').click();
  await expect(page.getByTestId('quotation-whatsapp-sheet')).toBeVisible();
  await expect(page.getByTestId('quotation-whatsapp-message')).toHaveValue('Hey Mira Shah, here is your quotation.');
  await expect(page.getByText('Mira Shah · +919909906652')).toBeVisible();
  await page.getByTestId('quotation-whatsapp-message').fill('Hey Mira, please review Basin & Shower #2.');
  await page.getByTestId('open-quotation-whatsapp').click();
  const opened = new URL(await page.evaluate(() => (window as unknown as { whatsappDraftUrl: string }).whatsappDraftUrl));
  expect(opened.pathname).toBe('/919909906652');
  expect(opened.searchParams.get('text')).toContain('Hey Mira, please review Basin & Shower #2.\n\n');
  expect(opened.searchParams.get('text')).toContain(draft.pdf_path);
  expect(quotationMutations).toBe(0);
  expect(prepared).toBe(1);
  await page.getByTestId('revoke-quotation-whatsapp').click();
  await expect(page.getByTestId('quotation-whatsapp-sheet')).not.toBeVisible();
  expect(revoked).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('quotation WhatsApp draft reports missing contact without opening a chat or claiming sent', async ({ page }) => {
  await mockSession(page, '/quotations/no-phone', false);
  await page.route(/\/api\/quotations\/no-phone(?:\?.*)?$/, route => route.fulfill({ json: {
    id: 'no-phone', number: 'Q-NO-PHONE', customer_name: 'No contact', status: 'draft', floor_id: 'first-floor',
    items: [{ id: 'line', sku: 'B-1', name: 'Basin', qty: 1, unit_price: 200, discount_pct: 0 }], rooms: [],
    subtotal: 200, discount_total: 0, grand_total: 200, created_at: '2026-10-01T10:00:00Z', created_by_name: 'Audit Owner',
  } }));
  await page.route('**/api/quotations/no-phone/breakdown', route => route.fulfill({ json: { lines: [], project_discount_pct: 0, category_discounts: {} } }));
  await page.route('**/api/activity/quotation/no-phone', route => route.fulfill({ json: [] }));
  await page.route('**/api/purchase-orders?quotation_id=no-phone', route => route.fulfill({ json: [] }));
  await page.route('**/api/quotations/no-phone/whatsapp-draft**', route => route.fulfill({ status: 422, json: { detail: "Add a valid WhatsApp phone number to the customer's contact details first" } }));
  await page.goto('/quotations/no-phone');
  await page.getByTestId('quotation-whatsapp-draft').click();
  await expect(page.getByText("Add a valid WhatsApp phone number to the customer's contact details first")).toBeVisible();
  await expect(page.getByTestId('quotation-whatsapp-sheet')).not.toBeVisible();
  await expect(page.getByRole('button', { name: /mark.*sent/i })).toHaveCount(0);
});

for (const kind of ['sanitary', 'tiles_selection', 'tiles_quotation'] as const) {
  test(`${kind} quotation builder prepares WhatsApp draft with document floor on every viewport`, async ({ page }) => {
    const tiles = kind !== 'sanitary';
    const path = tiles ? `/tiles/${kind === 'tiles_selection' ? 'selection' : 'quotation'}` : '/quotations/new';
    const floorId = tiles ? 'ground-floor' : 'first-floor';
    await mockSession(page, path, false);
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
      return route.fulfill({ json: draft });
    });
    await page.goto(`${path}?quotationId=builder-wa`);
    if (!tiles) {
      await expect(page.getByTestId('quotation-workspace')).toBeVisible();
      const expand = page.getByTestId('expand-quotation-workspace');
      if (await expand.isVisible()) await expand.click();
    }
    const action = page.getByRole('button', { name: tiles ? 'WhatsApp draft' : 'WhatsApp quotation draft', exact: true });
    await expect(action).toBeEnabled({ timeout: 20_000 });
    await action.click();
    await expect(page.getByTestId('quotation-whatsapp-sheet')).toBeVisible();
    await expect(page.getByTestId('quotation-whatsapp-message')).toHaveValue('Hey Mira Shah, here is your quotation.');
    await expect(page.getByTestId('open-quotation-whatsapp')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}
