import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

test('critical historical customer order drives the production start date', async ({ page }) => {
  const path = '/kitchen/historical-order/stages/order';
  await mockSession(page, path, false, { floorId: 'second-floor' });
  const recent = '2026-11-06';
  const design = { id: 'design', number: 1, workflow_cycle: 1, response: 'Approved', shared_date: recent, approval_date: recent, handoff_status: 'Yes', handoff_date: recent, attachment_ids: ['design-pdf'], final_attachment_id: 'design-pdf', upload_date: recent };
  const quote = { id: 'quote', number: 1, workflow_cycle: 1, response: 'Approved', design_version_id: design.id, amount: '1000', shared_date: recent, sent_status: 'Yes', received_status: 'Yes', received_date: recent, pdf_options: [{ attachment_id: 'quote-pdf', kitchen_type: 'GI' }], final_attachment_id: 'quote-pdf', kitchen_type: 'GI', upload_date: recent };
  let project: any = {
    id: 'historical-order', reference: 'KIT-HISTORY', project_reference: 'KIT-HISTORY', customer_id: 'customer', customer: { id: 'customer', name: 'Historical customer', phone: '9000000001' },
    version: 1, workflow_cycle: 1, stage: 'order', status: 'Pending', lifecycle_status: 'Active', lead: { status: 'Qualified', site_location: 'Historical site' }, visit: { status: 'Visited' }, cad: { received: true, progress: 100, ready: true, status: 'Completed' },
    production: { status: 'Not Started', start_date: null, completion_date: null }, installation: { status: 'Not Started', start_date: null, completion_date: null }, final_design_version_id: design.id, design_versions: [design], quotation_versions: [quote],
    orders: [], approvals: [], assignments: {}, exceptions: [], activity: [], attachments: ['design', 'quote'].map(id => ({ id: `${id}-pdf`, filename: `${id}.pdf`, content_type: 'application/pdf', uploaded_at: `${recent}T10:00:00Z`, size_bytes: 24 })),
    blocked_transitions: [], permissions: { can_update: true, can_approve_exceptions: true },
  };
  const writes: any[] = [];
  await page.route('**/api/kitchen-projects**', async route => {
    const request = route.request();
    const routePath = new URL(request.url()).pathname;
    if (routePath.endsWith('/configuration')) return route.fulfill({ json: { version: 1, department_manager_user_ids: [], files: {} } });
    if (request.method() === 'POST') {
      const body = request.postDataJSON();
      writes.push(body);
      if (body.command === 'order_confirm') project = { ...project, version: project.version + 1, orders: [{ id: 'order', confirmed: true, status: 'Confirmed', final_amount: '1000', original_amount: '1000', order_date: body.payload.order_date, quotation_version_id: quote.id, advance: { received: false, amount: '0' }, amendments: [] }] };
      else if (body.command === 'production_update') project = { ...project, version: project.version + 1, production: body.payload, production_started: true };
      else throw new Error(`Unexpected command ${body.command}`);
      return route.fulfill({ json: project });
    }
    return route.fulfill({ json: routePath.endsWith('/historical-order') ? project : { rows: [], total: 0, page: 1, limit: 25 } });
  });
  await page.goto(path);
  await expect(page.getByTestId('kitchen-project-ready')).toBeAttached();
  await page.getByTestId('kitchen-order-amount').fill('1000');
  await page.getByTestId('kitchen-order-date').fill('2024-01-05');
  await expect(page.getByTestId('kitchen-order-date')).not.toHaveAttribute('min');
  await expect(page.getByTestId('kitchen-production-start')).toHaveValue('2024-01-05');
  await page.getByTestId('kitchen-order-confirm').click();
  await expect(page.getByTestId('kitchen-order-edit-date')).toHaveValue('2024-01-05');
  expect(writes[0].payload.order_date).toBe('2024-01-05');
  expect(project.production.status).toBe('Not Started');
  expect(project.production.start_date).toBeNull();
  await page.getByTestId('kitchen-production-status-in-production').click();
  await expect(page.getByTestId('kitchen-production-start')).toHaveValue('2024-01-05');
  await page.getByTestId('kitchen-production-save').click();
  await page.getByTestId('kitchen-production-confirm-start').click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toMatchObject({ command: 'production_update', payload: { status: 'In Production', start_date: '2024-01-05', completion_date: '2024-03-05' } });
  await page.reload();
  await expect(page.getByTestId('kitchen-production-start')).toHaveValue('2024-01-05');
});
