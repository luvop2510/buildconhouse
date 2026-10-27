import type { Page, Route } from '@playwright/test';
import type { SalesSummary } from '../src/api/salesSummary';
import { floors, mockSession } from './audit-fixtures';

export const salesSummaryFixture: SalesSummary = {
  period: { start: '2026-10-01T00:00:00+00:00', end: '2026-11-01T00:00:00+00:00', label: 'This month' },
  kpis: { revenue: 240000, revenue_rnb: 0, outstanding_rnb: 0, orders: 12, products: 3, customers: 3, total_customers: 3, outstanding: 60000, followups: 5, overdue_followups: 2 },
  departments: [{ floor_id: 'first-floor', currency: 'INR', revenue: 240000, orders: 12, customers: 3, total_customers: 3, outstanding: 60000 }],
  quantities: [{ unit: 'Piece', quantity: 32 }, { unit: 'Set', quantity: 8 }],
  brands: [
    { brand_id: 'hansgrohe', name: 'Hansgrohe', revenue: 180000, orders: 8, products: 2, quantities: [{ unit: 'Piece', quantity: 24 }, { unit: 'Set', quantity: 8 }], is_unlinked: false },
    { brand_id: 'duravit', name: 'Duravit', revenue: 60000, orders: 4, products: 1, quantities: [{ unit: 'Piece', quantity: 8 }], is_unlinked: false },
  ],
  products: [
    { product_id: 'mixer', name: 'Talis basin mixer', sku: 'TAL-001', brand_name: 'Hansgrohe', revenue: 120000, orders: 4, customers: 2, quantities: [{ unit: 'Piece', quantity: 24 }] },
    { product_id: 'shower', name: 'Raindance shower set', sku: 'RND-002', brand_name: 'Hansgrohe', revenue: 60000, orders: 4, customers: 2, quantities: [{ unit: 'Set', quantity: 8 }] },
    { product_id: 'basin', name: 'Vero Air washbasin', sku: 'VRA-003', brand_name: 'Duravit', revenue: 60000, orders: 4, customers: 3, quantities: [{ unit: 'Piece', quantity: 8 }] },
  ],
  customers: [
    { key: 'INR:customer-a', currency: 'INR', floor_ids: ['first-floor'], phone: null, customer_id: 'customer-a', name: 'Ananya Shah', revenue: 80000, orders: 4, outstanding: 20000, last_order_at: '2026-10-26T10:00:00Z' },
    { key: 'INR:customer-b', currency: 'INR', floor_ids: ['first-floor'], phone: null, customer_id: 'customer-b', name: 'Rohan Mehta', revenue: 80000, orders: 4, outstanding: 20000, last_order_at: '2026-10-25T10:00:00Z' },
    { key: 'INR:customer-c', currency: 'INR', floor_ids: ['first-floor'], phone: null, customer_id: 'customer-c', name: 'Dev Patel', revenue: 80000, orders: 4, outstanding: 20000, last_order_at: '2026-10-24T10:00:00Z' },
  ],
  totals: { brands: 2, products: 3, customers: 3 },
  limit: 100,
  coverage: {
    sales: 'all_departments', outstanding: 'department_ledgers',
    sales_available: true, products_available: true, outstanding_available: true,
    note: '',
  },
};

// Display fixtures reconcile across their KPI and row representations.
if (salesSummaryFixture.brands.reduce((sum, row) => sum + row.revenue, 0) !== salesSummaryFixture.kpis.revenue
  || salesSummaryFixture.products.reduce((sum, row) => sum + row.revenue, 0) !== salesSummaryFixture.kpis.revenue
  || salesSummaryFixture.customers.reduce((sum, row) => sum + row.outstanding, 0) !== salesSummaryFixture.kpis.outstanding) {
  throw new Error('Sales display fixture does not reconcile');
}

export function emptySalesSummary() {
  return {
    ...salesSummaryFixture,
    kpis: { revenue: 0, revenue_rnb: 0, outstanding_rnb: 0, orders: 0, products: 0, customers: 0, total_customers: 0, outstanding: 0, followups: 0, overdue_followups: 0 },
    departments: salesSummaryFixture.departments.map(row => ({ ...row, revenue: 0, orders: 0, customers: 0, total_customers: 0, outstanding: 0 })),
    quantities: [], brands: [], products: [], customers: [],
    totals: { brands: 0, products: 0, customers: 0 },
  };
}

// Four different business sources, with Furniture's RNB ledger kept separate.
// Product attribution exists only for the catalog-backed Sanitary/Tiles rows.
export function fourDepartmentSummary(floorId = 'all'): SalesSummary {
  const allDepartments: SalesSummary['departments'] = [
    { floor_id: 'first-floor', currency: 'INR', revenue: 240000, orders: 12, customers: 3, total_customers: 3, outstanding: 60000 },
    { floor_id: 'ground-floor', currency: 'INR', revenue: 100000, orders: 2, customers: 2, total_customers: 2, outstanding: 25000 },
    { floor_id: 'second-floor', currency: 'INR', revenue: 300000.25, orders: 1, customers: 1, total_customers: 1, outstanding: 100000.25 },
    { floor_id: 'third-floor', currency: 'RNB', revenue: 75000.5, orders: 1, customers: 1, total_customers: 1, outstanding: 12500.5 },
  ];
  const departments = allDepartments.filter(row => floorId === 'all' || row.floor_id === floorId);
  const extraCustomers: SalesSummary['customers'] = [
    { key: 'INR:tiles-a', currency: 'INR', floor_ids: ['ground-floor'], phone: null, customer_id: 'tiles-a', name: 'Aarav Joshi', revenue: 50000, orders: 1, outstanding: 15000, last_order_at: '2026-10-20T10:00:00Z' },
    { key: 'INR:tiles-b', currency: 'INR', floor_ids: ['ground-floor'], phone: null, customer_id: 'tiles-b', name: 'Diya Desai', revenue: 50000, orders: 1, outstanding: 10000, last_order_at: '2026-10-21T10:00:00Z' },
    { key: 'INR:kitchen-a', currency: 'INR', floor_ids: ['second-floor'], phone: null, customer_id: 'kitchen-a', name: 'Kavya Kitchen Client', revenue: 300000.25, orders: 1, outstanding: 100000.25, last_order_at: '2026-10-22T10:00:00Z' },
    { key: 'RNB:furniture-a', currency: 'RNB', floor_ids: ['third-floor'], phone: '9876543210', customer_id: null, name: 'Falguni Furniture Client', revenue: 75000.5, orders: 1, outstanding: 12500.5, last_order_at: '2026-10-23T10:00:00Z' },
  ];
  const customers = [...salesSummaryFixture.customers, ...extraCustomers]
    .filter(row => floorId === 'all' || row.floor_ids.includes(floorId))
    .sort((a, b) => b.outstanding - a.outstanding);
  const sum = (key: 'revenue' | 'outstanding', currency: string) => departments.filter(row => row.currency === currency).reduce((total, row) => total + row[key], 0);
  const productCoverage = floorId === 'all' || ['first-floor', 'ground-floor'].includes(floorId);
  const sanitary = floorId === 'all' || floorId === 'first-floor';
  const tiles = floorId === 'all' || floorId === 'ground-floor';
  const tileQuantity = { unit: 'Box', quantity: 10 };
  const catalogRows = {
    ...salesSummaryFixture,
    brands: [
      ...(sanitary ? salesSummaryFixture.brands : []),
      ...(tiles ? [{ brand_id: 'kajaria', name: 'Kajaria', revenue: 100000, orders: 2, products: 1, quantities: [tileQuantity], is_unlinked: false }] : []),
    ],
    products: [
      ...(sanitary ? salesSummaryFixture.products : []),
      ...(tiles ? [{ product_id: 'tile', name: 'Kajaria porcelain tile', sku: 'KJR-600', brand_name: 'Kajaria', revenue: 100000, orders: 2, customers: 2, quantities: [tileQuantity] }] : []),
    ],
    quantities: [...(sanitary ? salesSummaryFixture.quantities : []), ...(tiles ? [tileQuantity] : [])],
  };
  return {
    ...catalogRows,
    departments,
    customers,
    kpis: {
      ...catalogRows.kpis,
      products: catalogRows.products.length,
      revenue: sum('revenue', 'INR'), revenue_rnb: sum('revenue', 'RNB'),
      outstanding: sum('outstanding', 'INR'), outstanding_rnb: sum('outstanding', 'RNB'),
      orders: departments.reduce((total, row) => total + row.orders, 0),
      customers: customers.length, total_customers: customers.length,
      followups: floorId === 'all' ? 14 : floorId === 'second-floor' ? 4 : floorId === 'third-floor' ? 3 : 5,
      overdue_followups: floorId === 'all' ? 3 : 1,
    },
    totals: { brands: catalogRows.brands.length, products: catalogRows.products.length, customers: customers.length },
    coverage: {
      ...salesSummaryFixture.coverage, products_available: productCoverage,
      note: productCoverage ? 'All four departments are included. Furniture RNB is reported separately from INR.' : 'Confirmed project sales and unpaid balances are included. Product and brand attribution is not recorded for this department.',
    },
  };
}

export async function mockSalesSummary(page: Page, options: {
  path?: string;
  floorId?: string;
  summary?: SalesSummary;
  onSummary?: (route: Route) => Promise<unknown>;
} = {}) {
  await mockSession(page, options.path || '/sales-data', false, { seedStorageOnce: true, floorId: options.floorId });
  await page.route('**/api/settings/floors', route => route.fulfill({ json: floors }));
  await page.route('**/api/analytics/default-period?**', route => route.fulfill({ json: {
    preset: 'this_month', date_from: null, date_to: null, label: 'This month', fallback_applied: false, latest_order_at: null,
  } }));
  await page.route('**/api/analytics/sales-summary?**', options.onSummary || (route => route.fulfill({ json: options.summary || salesSummaryFixture })));
  await page.route('**/api/referrers**', route => route.fulfill({ json: [] }));
  await page.route('**/api/analytics/workspaces/relationships?**', route => route.fulfill({ json: {
    workspace: 'relationships', period: 'This month',
    kpis: { revenue: 0, revenue_rnb: 0, outstanding_rnb: 0, orders: 0, outstanding: 0, hansgrohe_revenue: 0 },
    brands: [], products: [], customers: [], floors: [], relationships: [],
  } }));
}
