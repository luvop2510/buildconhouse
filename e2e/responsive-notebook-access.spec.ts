import { expect, test, type Page } from '@playwright/test';
import { retiredNotebookRedirect } from './retired-notebook-fixtures';
import { floors, mockSession } from './audit-fixtures';

const lead = {
  id: 'lead-one', customer_name: 'Notebook customer', customer_phone: '9000000000', address: 'Project site',
  kitchen_type: 'GI', referred_by: '', referrer_id: null, referrer_name: '', referrer_type: null,
  architect_interior_designer: '', status: 'pending', notes: 'Confirm measurements', lost_reason: '',
  is_converted: false, converted_at: null, last_contacted_at: null, contact_attempts: 0,
  updated_at: '2026-10-01T10:00:00Z', quotation_price: 25000,
};
const saved = {
  id: 'rmb-one', customer_name: 'RDCL', customer_phone: '9000000000', floor_id: 'third-floor', status: 'draft', revision: 1,
  created_at: lead.updated_at, updated_at: lead.updated_at,
  charges: [{ id: 'charge-one', description: 'TOTAL PURCHASE', amount_rmb: '100' }],
  deposits: [{ id: 'deposit-one', description: 'Customer deposit', currency: 'RMB', amount: '10', rate: '1' }],
  total_payable_rmb: '100.00', total_received_rmb: '10.00', balance_rmb: '90.00',
};
async function viewOnly(page: Page, path: string, floorId: string, resource: string) {
  await mockSession(page, path, false, {
    staff: { id: 'viewer', email: 'viewer@example.test', full_name: 'Viewer', role: 'sales', active: true,
      custom_access: true, floor_ids: [floorId] },
    grants: [{ floor_id: floorId, resource, actions: ['view'] }],
    floorAccess: { all_floors: false, floors: floors.filter(floor => floor.id === floorId), floor_ids: [floorId] },
  });
  await page.addInitScript(id => localStorage.setItem('forge.active-floor', JSON.stringify(id)), floorId);
}
for (const [slug, floorId] of [['kitchen', 'second-floor'], ['furniture', 'third-floor']] as const) {
  for (const quotation of [false, true]) {
    test(`${slug} retired ${quotation ? 'quotation follow-up' : 'walk-ins'} grant cannot authorize the shared workspace`, async ({ page }) => {
      const path = `/notebook/${slug}${quotation ? '/quotation-follow-up' : ''}`;
      await viewOnly(page, path, floorId, quotation ? 'notebook_quotations' : 'notebook_walkins');
      let reads = 0;
      await page.route('**/api/followups/notebook/**', route => { reads++; return route.fulfill({ json: { rows: [] } }); });
      await page.route('**/api/followups/page?**', route => { reads++; return route.fulfill({ json: { items: [] } }); });
      await page.route(/\/api\/walkins(?:\?|$)/, route => { reads++; return route.fulfill({ json: [] }); });
      await page.goto(path);
      await expect(page).toHaveURL(/\/access$/);
      await expect(page.getByTestId('no-page-access')).toContainText('No pages enabled on this floor');
      expect(reads).toBe(0);
      for (const id of ['new-followup-btn', 'walkin-new-btn', 'complete-retained-customer', 'interested-retained-customer']) {
        await expect(page.getByTestId(id)).toHaveCount(0);
      }
    });
  }
}

test('furniture view-only grant keeps the RNB ledger readable without edit or export controls', async ({ page }) => {
  await viewOnly(page, '/notebook/furniture-quotations', 'third-floor', 'furniture_quotations');
  await page.route('**/api/furniture-quotations', route => route.fulfill({ json: { rows: [saved], next_cursor: null } }));
  await page.route(/\/api\/furniture-quotations\/rmb-one(?:\?.*)?$/, route => route.fulfill({ json: saved }));
  await page.goto('/notebook/furniture-quotations');
  await expect(page.getByRole('button', { name: 'New RNB quotation', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open RDCL', exact: true }).click();
  await expect(page.getByLabel('Customer name / quotation heading (RDCL)', { exact: true })).not.toBeEditable();
  await expect(page.getByLabel('Deposit 1 amount (RNB)', { exact: true })).not.toBeEditable();
  for (const name of ['Save quotation', 'Finalize and lock charges', 'Add customer deposit', 'Download PDF', 'Send PDF to WhatsApp']) {
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  }
  await expect(page.getByTestId('furniture-summary')).toContainText('90.00');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('furniture list and ledger load while the independent WhatsApp configuration request remains pending', async ({ page }) => {
  await mockSession(page, '/notebook/furniture-quotations', false);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let providerReady = false;
  await page.route('**/api/whatsapp/configuration', async route => {
    await gate;
    return providerReady ? route.fulfill({ json: { configured: true, template_configured: false } })
      : route.fulfill({ status: 503, json: { detail: 'Provider unavailable' } });
  });
  await page.route('**/api/furniture-quotations', route => route.fulfill({ json: { rows: [saved], next_cursor: null } }));
  await page.route(/\/api\/furniture-quotations\/rmb-one(?:\?.*)?$/, route => route.fulfill({ json: saved }));
  try {
    await page.goto('/notebook/furniture-quotations');
    await page.getByRole('button', { name: 'Open RDCL', exact: true }).click();
    await expect(page.getByTestId('furniture-summary')).toContainText('90.00');
    await expect(page.getByRole('button', { name: 'Send PDF to WhatsApp', exact: true })).toBeDisabled();
    release();
    await expect(page.getByRole('alert').filter({ hasText: 'Could not check WhatsApp availability' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download PDF', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Send PDF to WhatsApp', exact: true })).toBeDisabled();
    providerReady = true;
    await page.getByRole('button', { name: 'Retry WhatsApp availability', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Send PDF to WhatsApp', exact: true })).toBeEnabled();
  } finally { release(); }
});

test('retired kitchen bookmarks never select the kitchen floor over the current furniture workspace', async ({ page }) => {
  await retiredNotebookRedirect(page, '/notebook/kitchen', 'walkins', 'third-floor');
  await expect(page.getByTestId('floor-switcher').filter({ visible: true }).first()).toContainText('Furniture');
});

test('a retired notebook deep link never reads an unassigned floor', async ({ page }) => {
  await retiredNotebookRedirect(page, '/notebook/kitchen', 'walkins', 'first-floor', true);
  await expect(page.getByTestId('floor-switcher').filter({ visible: true }).first()).toContainText('The Sanitary Bathroom');
});

test('retired quotation bookmarks cannot use old notebook-only grants to read shared follow-ups', async ({ page }) => {
  const path = '/notebook/kitchen/quotation-follow-up';
  await viewOnly(page, path, 'second-floor', 'notebook_quotations');
  let reads = 0;
  await page.route('**/api/followups/page?**', route => { reads++; return route.fulfill({ json: { items: [] } }); });
  await page.route('**/api/followups/notebook/**', route => { reads++; return route.fulfill({ json: { rows: [] } }); });
  await page.goto(path);
  await expect(page).toHaveURL(/\/access$/);
      await expect(page.getByTestId('no-page-access')).toContainText('No pages enabled on this floor');
  expect(reads).toBe(0);
});

test('retired furniture quotation bookmark stays on the current kitchen floor and removes conversion actions', async ({ page }) => {
  await retiredNotebookRedirect(page, '/notebook/furniture/quotation-follow-up', 'followups', 'second-floor');
  await expect(page.getByTestId('floor-switcher').filter({ visible: true }).first()).toContainText('Kitchen');
  await expect(page.getByRole('button', { name: 'Move to quotation', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Quotation price *', { exact: true })).toHaveCount(0);
});

test('furniture export-only grant allows PDF delivery and receipt refresh while keeping ledger edits read-only', async ({ page }) => {
  await mockSession(page, '/notebook/furniture-quotations', false, {
    staff: { id: 'exporter', email: 'exporter@example.test', full_name: 'Exporter', role: 'sales', active: true,
      custom_access: true, floor_ids: ['third-floor'] },
    grants: [{ floor_id: 'third-floor', resource: 'furniture_quotations', actions: ['view', 'export'] }],
    floorAccess: { all_floors: false, floors: floors.filter(floor => floor.id === 'third-floor'), floor_ids: ['third-floor'] },
  });
  await page.route('**/api/furniture-quotations', route => route.fulfill({ json: { rows: [saved], next_cursor: null } }));
  await page.route(/\/api\/furniture-quotations\/rmb-one(?:\?.*)?$/, route => route.fulfill({ json: saved }));
  await page.route('**/api/whatsapp/configuration', route => {
    expect(route.request().headers()['x-floor-id']).toBe('third-floor');
    return route.fulfill({ json: { configured: true, template_configured: false } });
  });
  await page.route('**/api/furniture-quotations/rmb-one/whatsapp-send', route => {
    expect(route.request().headers()['x-floor-id']).toBe('third-floor');
    expect(route.request().postDataJSON().expected_updated_at).toBe(saved.updated_at);
    return route.fulfill({ json: { status: 'accepted', message_id: 'test-message' } });
  });
  await page.route('**/api/whatsapp/deliveries/rmb-one/*', route => {
    expect(route.request().headers()['x-floor-id']).toBe('third-floor');
    return route.fulfill({ json: { status: 'delivered', message_id: 'test-message' } });
  });
  await page.goto('/notebook/furniture-quotations');
  await page.getByRole('button', { name: 'Open RDCL', exact: true }).click();
  await expect(page.getByLabel('Charge 1 RNB', { exact: true })).not.toBeEditable();
  await expect(page.getByRole('button', { name: 'Save quotation', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download PDF', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Send PDF to WhatsApp', exact: true }).click();
  await expect(page.getByText('WhatsApp status: accepted', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh delivery status', exact: true }).click();
  await expect(page.getByText('WhatsApp status: delivered', { exact: true })).toBeVisible();
});
