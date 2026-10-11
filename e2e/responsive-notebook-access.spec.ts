import { expect, test, type Page } from '@playwright/test';
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
    test(`${slug} ${quotation ? 'quotation follow-up' : 'walk-ins'} view-only grant hides unavailable mutations`, async ({ page }) => {
      const path = `/notebook/${slug}${quotation ? '/quotation-follow-up' : ''}`;
      await viewOnly(page, path, floorId, quotation ? 'notebook_quotations' : 'notebook_walkins');
      await page.route(`**/api/followups/notebook/${floorId}?**`, route => {
        expect(route.request().headers()['x-floor-id']).toBe(floorId);
        return route.fulfill({ json: { rows: [{ ...lead, is_converted: quotation }], next_cursor: null } });
      });
      await page.goto(path);
      await expect(page.getByText('Notebook customer', { exact: true })).toBeVisible();
      for (const name of ['New walk-in', 'Call', 'WhatsApp', 'Move to quotation']) {
        await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
      }
      await expect(page.getByRole('button', { name: 'Lost', exact: true })).toHaveCount(quotation ? 0 : 1); // Walk-ins has a read-only Lost filter
      await expect(page.getByText('Confirm measurements', { exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    });
  }
}

test('furniture view-only grant keeps the RMB ledger readable without edit or export controls', async ({ page }) => {
  await viewOnly(page, '/notebook/furniture-quotations', 'third-floor', 'furniture_quotations');
  await page.route('**/api/furniture-quotations', route => route.fulfill({ json: { rows: [saved], next_cursor: null } }));
  await page.route('**/api/furniture-quotations/rmb-one', route => route.fulfill({ json: saved }));
  await page.goto('/notebook/furniture-quotations');
  await expect(page.getByRole('button', { name: 'New RMB quotation', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open RDCL', exact: true }).click();
  await expect(page.getByLabel('Customer name / quotation heading (RDCL)', { exact: true })).not.toBeEditable();
  await expect(page.getByLabel('Deposit 1 amount (RMB)', { exact: true })).not.toBeEditable();
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
  await page.route('**/api/furniture-quotations/rmb-one', route => route.fulfill({ json: saved }));
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

test('switching notebook floors discards a closed draft and uses the destination floor for new walk-ins', async ({ page }) => {
  await mockSession(page, '/notebook/kitchen', false);
  await page.route('**/api/followups/notebook/**', route => route.fulfill({ json: { rows: [], next_cursor: null } }));
  await page.goto('/notebook/kitchen');
  await page.getByRole('button', { name: 'New walk-in', exact: true }).first().click();
  let dialog = page.getByRole('dialog', { name: 'New walk-in', exact: true });
  await dialog.getByLabel('Customer name *', { exact: true }).fill('Kitchen unsaved customer');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByTestId('floor-switcher').filter({ visible: true }).first().click();
  await page.getByRole('menuitem', { name: 'Furniture Floor', exact: true }).click();
  await expect(page).toHaveURL(/\/notebook\/furniture$/);
  await page.getByRole('button', { name: 'New walk-in', exact: true }).first().click();
  dialog = page.getByRole('dialog', { name: 'New walk-in', exact: true });
  await expect(dialog.getByLabel('Customer name *', { exact: true })).toHaveValue('');
  await expect(dialog.getByText('Kitchen type *', { exact: true })).toHaveCount(0);
});

test('a notebook deep link never reads an unassigned floor', async ({ page }) => {
  await mockSession(page, '/notebook/kitchen', false, {
    floorAccess: { all_floors: false, floors: [floors[0]], floor_ids: ['first-floor'] },
  });
  let reads = 0;
  await page.route('**/api/followups/notebook/**', route => { reads++; return route.fulfill({ json: { rows: [], next_cursor: null } }); });
  await page.goto('/notebook/kitchen');
  await expect(page).toHaveURL(/\/dashboard$/);
  expect(reads).toBe(0);
});

test('quotation notebook update access allows choosing an existing partner without creating one', async ({ page }) => {
  const path = '/notebook/kitchen/quotation-follow-up';
  await mockSession(page, path, false, {
    staff: { id: 'editor', email: 'editor@example.test', full_name: 'Editor', role: 'sales', active: true,
      custom_access: true, floor_ids: ['second-floor'] },
    grants: [{ floor_id: 'second-floor', resource: 'notebook_quotations', actions: ['view', 'update'] }],
    floorAccess: { all_floors: false, floors: floors.filter(floor => floor.id === 'second-floor'), floor_ids: ['second-floor'] },
  });
  await page.route('**/api/followups/notebook/second-floor?**', route => route.fulfill({ json: { rows: [{ ...lead, is_converted: true }], next_cursor: null } }));
  await page.route('**/api/referrers', route => route.fulfill({ json: [{ id: 'partner-one', name: 'Existing studio', type: 'architect' }] }));
  await page.goto(path);
  await page.getByRole('button').filter({ hasText: 'Assign architect / interior designer' }).click();
  await page.getByText('Select architect or interior designer', { exact: true }).click();
  const picker = page.getByTestId('customer-referrer-sheet');
  await expect(picker.getByText('Existing studio', { exact: true })).toBeVisible();
  await expect(picker.getByRole('button', { name: 'Add and select', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(picker).not.toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Assign architect or interior designer', exact: true })).toBeVisible();
  await page.getByText('Select architect or interior designer', { exact: true }).click();
  await expect(picker.getByText('Existing studio', { exact: true })).toBeVisible();
  await picker.getByText('Existing studio', { exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Assign architect or interior designer', exact: true })).toBeVisible();
});

test('notebook conversion rejects negative and text-only prices instead of changing their meaning', async ({ page }) => {
  await mockSession(page, '/notebook/kitchen', false);
  await page.route('**/api/followups/notebook/second-floor?**', route => route.fulfill({ json: { rows: [lead], next_cursor: null } }));
  const writes: unknown[] = [];
  await page.route('**/api/followups/notebook/second-floor/lead-one/convert', route => {
    writes.push(route.request().postDataJSON());
    return route.fulfill({ json: { ...lead, is_converted: true } });
  });
  await page.goto('/notebook/kitchen');
  await page.getByRole('button', { name: 'Move to quotation', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Move to quotation follow-up', exact: true });
  await dialog.getByLabel('Follow-up note *', { exact: true }).fill('Client requested this quotation');
  for (const input of ['-100', 'oops']) {
    await dialog.getByLabel('Quotation price *', { exact: true }).fill(input);
    await dialog.getByRole('button', { name: 'Move to quotation follow-up', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('Enter a valid quotation price');
    expect(writes).toHaveLength(0);
  }
  await dialog.getByLabel('Quotation price *', { exact: true }).fill('₹12,500.50');
  await dialog.getByRole('button', { name: 'Move to quotation follow-up', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(writes).toEqual([{ quotation_price: 12500.5, notes: 'Client requested this quotation', updated_at: lead.updated_at }]);
});

test('furniture export-only grant allows PDF delivery and receipt refresh while keeping ledger edits read-only', async ({ page }) => {
  await mockSession(page, '/notebook/furniture-quotations', false, {
    staff: { id: 'exporter', email: 'exporter@example.test', full_name: 'Exporter', role: 'sales', active: true,
      custom_access: true, floor_ids: ['third-floor'] },
    grants: [{ floor_id: 'third-floor', resource: 'furniture_quotations', actions: ['view', 'export'] }],
    floorAccess: { all_floors: false, floors: floors.filter(floor => floor.id === 'third-floor'), floor_ids: ['third-floor'] },
  });
  await page.route('**/api/furniture-quotations', route => route.fulfill({ json: { rows: [saved], next_cursor: null } }));
  await page.route('**/api/furniture-quotations/rmb-one', route => route.fulfill({ json: saved }));
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
  await expect(page.getByLabel('Charge 1 RMB', { exact: true })).not.toBeEditable();
  await expect(page.getByRole('button', { name: 'Save quotation', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download PDF', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Send PDF to WhatsApp', exact: true }).click();
  await expect(page.getByText('WhatsApp status: accepted', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh delivery status', exact: true }).click();
  await expect(page.getByText('WhatsApp status: delivered', { exact: true })).toBeVisible();
});
