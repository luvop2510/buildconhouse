import type { Page } from '@playwright/test';
import { mockSession } from './audit-fixtures';

export const reportIds = [
  'pending-company', 'pending-interior', 'placed-company', 'placed-interior', 'products', 'interior-orders',
] as const;

const brands = [
  { id: 'grohe', name: 'Grohe' },
  { id: 'hansgrohe', name: 'Hansgrohe' },
  { id: 'vitra', name: 'Vitra' },
];
const buyer = 'Aarav Desai';
const architect = 'Ria Shah';
const product = 'Rainshower 310';

type Options = { floorId?: string; role?: string; failOnce?: string; pagedPending?: boolean };

export async function mockSanitarySales(page: Page, options: Options = {}) {
  await mockSession(page, '/sanitary-sales', false, {
    floorId: options.floorId,
    seedStorageOnce: true,
    ...(options.role && {
      staff: {
        id: 'audit-staff', email: 'staff@example.test', full_name: 'Audit Staff',
        role: options.role, active: true, floor_ids: ['first-floor'],
      },
    }),
  });
  const requests: URL[] = [];
  let fail = options.failOnce;
  await page.route('**/api/sanitary-sales/**', async route => {
    const url = new URL(route.request().url());
    requests.push(url);
    const [report, action] = url.pathname.replace('/api/sanitary-sales/', '').split('/');
    const q = url.searchParams;
    if (report === 'brands') return route.fulfill({ json: { items: brands } });
    if (report === 'overview') {
      const mrp = q.get('value_basis') === 'mrp';
      const pendingValue = mrp ? 300000.01 : 200000.01;
      const placedValue = mrp ? 150000.25 : 100000.25;
      const quote = { id: 'q-103', target_id: 'q-103', target_type: 'quotation', customer_id: 'buyer-aarav',
        customer_name: buyer, number: 'SQ-103', label: 'Pending quotation', date: '2026-10-10', value: pendingValue, status: 'sent' };
      const payment = { id: 'q-204', target_id: 'q-204', target_type: 'payment', customer_id: 'buyer-aarav',
        customer_name: buyer, number: 'SQ-204', label: 'Delivered but unpaid', value: placedValue,
        order_amount: 118000, paid: 80000, outstanding: 38000, age_days: 6,
        age_reference: 'order date', delivery_status: 'delivered', employee: 'Asha' };
      const followup = { id: 'follow-1', target_id: 'follow-1', target_type: 'followup', customer_id: 'buyer-aarav',
        customer_name: buyer, label: 'Overdue follow-up', due_date: '2026-10-19', days_overdue: 1, reason: 'Confirm finish' };
      const customer = { id: 'buyer-aarav', customer_id: 'buyer-aarav', customer_name: buyer, items: [followup, quote, payment] };
      if (action) {
        const items = action === 'architect' || action === 'attention' ? [customer]
          : action === 'outstanding' || action === 'delivered_unpaid' ? [payment] : [quote];
        return route.fulfill({ json: { items, total: items.length, page: 1, page_size: 25 } });
      }
      const metrics = (value: number) => ({
        value, mrp_value: value, offer_value: value, missing_value_lines: 0, missing_mrp_lines: 0, missing_offer_lines: 0,
        customer_count: 1, document_count: 1,
      });
      return route.fulfill({ json: {
        kpis: { pending_quotations: metrics(pendingValue), placed_orders: metrics(placedValue),
          draft_customers: 1, pending_customers: 1, followups: { overdue: 1, today: 0, customer_count: 1 },
          outstanding: { value: 38000, customer_count: 1, order_count: 1, missing_amounts: 0 },
          delivered_unpaid: { value: 38000, order_count: 1, missing_amounts: 0 },
          conversion: { rate: 50, converted: 1, opportunities: 2 } },
        pipeline: [
          { id: 'pending', name: 'Pending', ...metrics(pendingValue) },
          { id: 'placed', name: 'Order placed', ...metrics(placedValue) },
        ],
        brands: [{ id: 'grohe', name: 'Grohe', pending_value: pendingValue, placed_value: placedValue,
          order_count: 1, quantities: [{ unit: 'pcs', quantity: 8 }], share: 100 }],
        architects: [{ id: 'architect-ria', name: architect, customer_count: 1, draft_customers: 1,
          pending_customers: 1, order_count: 1, order_value: placedValue, outstanding: 38000 }],
        products: [{ id: 'product-310', name: product, ...metrics(placedValue), quantity: 8, unit: 'pcs',
          brand: 'Grohe', sku: 'RAIN-310', size: '310 mm', finish: 'Chrome' }],
        attention: [customer], payments: { items: [payment],
          aging: [{ id: 'undated', name: 'No due date recorded', order_count: 1, value: 38000 }] }, notes: [],
      } });
    }
    if (report === 'quotation-pdfs') {
      return route.fulfill({
        contentType: 'application/pdf',
        headers: { 'Content-Disposition': 'attachment; filename="SQ-103.pdf"' },
        body: '%PDF-1.4\n% hermetic latest quotation fixture\n%%EOF\n',
      });
    }
    if (action === 'export') {
      return route.fulfill({
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        headers: { 'Content-Disposition': `attachment; filename="Sanitary_${report}.xlsx"` },
        body: 'Hermetic Sanitary sales acceptance download fixture',
      });
    }
    if (report === fail) {
      fail = undefined;
      return route.fulfill({ status: 503, json: { detail: 'The report timed out. Try again.' } });
    }
    if (!reportIds.some(id => id === report)) return route.fulfill({ status: 404 });
    const pending = report.startsWith('pending');
    const isProduct = report === 'products';
    const interior = report.includes('interior');
    const inGroup = q.has('group_id');
    const documents = inGroup && (!interior || q.has('customer_id'));
    const brand = brands.find(company => company.id === (q.get('brand_id') || 'grohe'))?.name || 'Grohe';
    const mrpValue = pending ? 300_000.01 : 150_000.25;
    const offerValue = pending ? 200_000.01 : 100_000.25;
    const value = q.get('value_basis') === 'mrp' ? mrpValue : offerValue;
    const empty = brand === 'Vitra';
    const statuses = [pending ? 'draft' : 'ordered'];
    const totals = {
      value: empty ? 0 : value, mrp_value: empty ? 0 : mrpValue, offer_value: empty ? 0 : offerValue,
      missing_value_lines: 0, missing_mrp_lines: 0, missing_offer_lines: 0,
      customer_count: empty ? 0 : 1, document_count: empty ? 0 : 1,
    };
    if (options.pagedPending && report === 'pending-company' && !inGroup) {
      const preset = q.get('preset');
      const total = preset === 'last_7_days' ? 3 : preset === 'last_30_days' ? 16 : 17;
      const page = Number(q.get('page') || 1);
      const size = Number(q.get('page_size') || 15);
      const all = Array.from({ length: total }, (_, index) => ({
        ...totals, id: `buyer-${index + 1}`, name: `Project customer ${index + 1}`, statuses, brands: [brand],
      }));
      return route.fulfill({ json: {
        level: 'groups', items: all.slice((page - 1) * size, page * size), total, page, page_size: size,
        totals: {
          ...totals, value: value * total, mrp_value: mrpValue * total, offer_value: offerValue * total,
          customer_count: total, document_count: total,
        },
        date_from: null, date_to: null, notes: [],
      } });
    }
    const quotationId = pending ? 'q-103' : 'q-204';
    const number = pending ? 'SQ-103' : 'SQ-204';
    const common = { ...totals, brands: [brand], statuses };
    const items = empty ? [] : documents ? [{
      ...common, id: quotationId, name: number, number, date: '2026-10-10',
      customer_name: buyer, contact: '9000000000', status: statuses[0],
      quotation_id: quotationId, quotation_number: number, pdf_available: pending,
      items: [{
        id: 'source-line', name: product, brand, sku: 'RAIN-310', size: '310 mm', finish: 'Chrome',
        unit: 'pcs', quantity: 8, mrp_value: mrpValue, offer_value: offerValue, value,
      }],
    }] : [{
      ...common,
      id: isProduct ? 'product-310' : interior && !inGroup ? 'architect-ria' : 'buyer-aarav',
      name: isProduct ? product : interior && !inGroup ? architect : buyer,
      ...(isProduct && { quantity: 8, unit: 'pcs', brand, sku: 'RAIN-310', size: '310 mm', finish: 'Chrome' }),
    }];
    return route.fulfill({ json: {
      level: documents ? 'documents' : inGroup ? 'customers' : 'groups',
      items, total: items.length, page: Number(q.get('page') || 1), page_size: Number(q.get('page_size') || 25),
      totals, date_from: q.get('date_from'), date_to: q.get('date_to'), notes: [],
    } });
  });
  return requests;
}
