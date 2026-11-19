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
