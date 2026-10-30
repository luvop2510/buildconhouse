import type { Page, Route } from '@playwright/test';
import { floors, mockSession } from './audit-fixtures';

const entity = (id: string, name: string, sales: number, extra: Record<string, unknown> = {}) => ({
  id, name, sales, sales_rnb: 0, orders: 1, customers: 1, floor_ids: ['first-floor'], ...extra,
});

export const analyticsOrders = [
  { id: 'order-a', number: 'SO-1001', customer_id: 'customer-a', customer_name: 'Ananya Shah', floor_id: 'first-floor', floor_name: 'Sanitary / Bathroom', currency: 'INR', sales: 240000, total: 240000, confirmed_at: '2026-10-10T06:00:00Z', date: '2026-10-10T06:00:00Z', status: 'confirmed', collected: 180000, outstanding: 60000, architect_id: 'architect-a', architect_name: 'Nisha Shah' },
  { id: 'order-b', number: 'TO-1002', customer_id: 'customer-b', customer_name: 'Aarav Joshi', floor_id: 'ground-floor', floor_name: 'Tiles', currency: 'INR', sales: 60000.5, total: 60000.5, confirmed_at: '2026-10-20T06:00:00Z', date: '2026-10-20T06:00:00Z', status: 'confirmed', collected: 40000, outstanding: 20000.5, architect_id: null, architect_name: null },
  { id: 'order-c', number: 'FUR-1003', customer_id: 'customer-c', customer_name: 'Falguni Furniture Client', floor_id: 'third-floor', floor_name: 'Furniture', currency: 'RNB', sales: 75000.5, total: 75000.5, confirmed_at: '2026-10-23T06:00:00Z', date: '2026-10-23T06:00:00Z', status: 'confirmed', collected: 62500, outstanding: 12500.5, architect_id: null, architect_name: null },
];

export function analyticsDashboard(floorId = 'all', basis = 'confirmation') {
  const orders = analyticsOrders.filter(row => floorId === 'all' || row.floor_id === floorId);
  const inr = orders.filter(row => row.currency === 'INR');
  const rnb = orders.filter(row => row.currency === 'RNB');
  const sum = (rows: typeof orders, key: 'sales' | 'collected' | 'outstanding') => rows.reduce((total, row) => total + row[key], 0);
  const sales = sum(inr, basis === 'payment' ? 'collected' : 'sales');
  const salesRnb = sum(rnb, basis === 'payment' ? 'collected' : 'sales');
  const amountFor = (row: typeof analyticsOrders[number]) => basis === 'payment' ? row.collected : row.sales;
  const catalog = floorId !== 'second-floor' && floorId !== 'third-floor';
  return {
    title: floorId === 'all' ? 'Overall Sales Data' : `${floors.find(row => row.id === floorId)?.name} Analysis`,
    generated_at: '2026-10-28T06:30:00Z',
    period: { label: 'October 2026', start: '2026-10-01T00:00:00+05:30', end: '2026-11-01T00:00:00+05:30' },
    filters: { floor_id: floorId, preset: 'this_month', date_basis: basis },
    metric_label: basis === 'payment' ? 'Collected amount' : 'Confirmed sales',
    kpis: { sales, sales_rnb: salesRnb, orders: orders.length, customers: orders.length, average_order_value: inr.length ? sales / inr.length : null, average_order_value_rnb: rnb.length ? salesRnb / rnb.length : null, collected: sum(inr, 'collected'), collected_rnb: sum(rnb, 'collected'), outstanding: sum(inr, 'outstanding'), outstanding_rnb: sum(rnb, 'outstanding'), change_pct_rnb: null, products: catalog ? orders.length : null, change_pct: null },
    floors: floors.filter(row => floorId === 'all' || row.id === floorId).map(row => {
      const source = orders.filter(order => order.floor_id === row.id);
      const amount = sum(source, basis === 'payment' ? 'collected' : 'sales');
      const currency = row.id === 'third-floor' ? 'RNB' : 'INR';
      return { id: row.id, floor_id: row.id, name: row.name, currency, sales: amount, orders: source.length, customers: source.length, average_order_value: source.length ? amount / source.length : null, contribution_pct: amount ? amount / (currency === 'RNB' ? salesRnb : sales) * 100 : 0 };
    }),
    trend: orders.map(row => ({ id: row.id === 'order-a' ? '2026-10-10' : row.id === 'order-b' ? '2026-10-20' : '2026-10-23', label: row.id === 'order-a' ? '10 Oct' : row.id === 'order-b' ? '20 Oct' : '23 Oct', start: row.date, end: row.id === 'order-a' ? '2026-10-11T06:00:00Z' : row.id === 'order-b' ? '2026-10-21T06:00:00Z' : '2026-10-24T06:00:00Z', sales: row.currency === 'INR' ? amountFor(row) : 0, sales_rnb: row.currency === 'RNB' ? amountFor(row) : 0, orders: 1, orders_inr: row.currency === 'INR' ? 1 : 0, orders_rnb: row.currency === 'RNB' ? 1 : 0, previous_sales: null })),
    companies: catalog && inr.length ? [entity('company-a', 'Hansgrohe', sales)] : [],
    products: catalog && inr.length ? [entity('product-a', 'Talis basin mixer', sales, { sku: 'TAL-001', quantity: 24, unit: 'Piece', company_id: 'company-a', company_name: 'Hansgrohe' })] : [],
    architects: orders.some(row => row.architect_id) ? [entity('architect-a', 'Nisha Shah', amountFor(analyticsOrders[0]))] : [],
    customers: orders.map(row => entity(row.customer_id, row.customer_name, row.currency === 'INR' ? amountFor(row) : 0, { sales_rnb: row.currency === 'RNB' ? amountFor(row) : 0, floor_ids: [row.floor_id], outstanding: row.outstanding })),
    customer_segments: [{ id: 'new', name: 'New customers', customers: orders.length }, { id: 'repeat', name: 'Repeat customers', customers: 0 }],
    coverage: { notes: catalog ? ['Previous-period comparison unavailable: no reliable historical baseline.'] : ['Product attribution unavailable for this workflow.'], missing_dates: 0, missing_customer_ids: 0, products_available: catalog },
    insights: orders.length ? [`${orders.length} confirmed customer orders support this report.`] : [],
  };
}

// Fixture assertions prevent a chart or KPI from drifting away from source orders.
if (analyticsDashboard().kpis.sales !== analyticsOrders.filter(row => row.currency === 'INR').reduce((sum, row) => sum + row.total, 0)) {
  throw new Error('Analytics source orders do not reconcile with confirmed sales');
}

export function analyticsOwnerOperations(floorId = 'all') {
  const people = [
    { id: 'team-mira', name: 'Mira Patel', floor_id: 'first-floor', open: 2, overdue: 1, completed: 1, contacts: 3, calls: 2 },
    { id: 'team-arjun', name: 'Arjun Shah', floor_id: 'ground-floor', open: 1, overdue: 1, completed: 1, contacts: 2, calls: 1 },
  ].filter(row => floorId === 'all' || row.floor_id === floorId);
  const unassigned = floorId === 'all' || floorId === 'first-floor' ? 1 : 0;
  return {
    generated_at: '2026-10-29T06:30:00Z', floor_ids: floors.filter(row => floorId === 'all' || row.id === floorId).map(row => row.id),
    period_label: 'Current follow-ups · contacts in the last 30 days',
    open_followups: people.reduce((sum, row) => sum + row.open, unassigned),
    overdue_followups: people.reduce((sum, row) => sum + row.overdue, 0),
    completed_followups: people.reduce((sum, row) => sum + row.completed, 0),
    dismissed_followups: 0, unassigned_followups: unassigned, team: people,
    workflows: floorId === 'all' || floorId === 'second-floor' ? [{floor_id:'second-floor',name:'Kitchen',unit:'projects',total:7,active:4,completed:2,on_hold:1,overdue:1,stages:[{id:'lead',name:'Lead',count:2},{id:'production',name:'Production',count:2},{id:'completed',name:'Completed',count:2}],workload:[{id:'team-mira',name:'Mira Patel',count:3}]}] : [],
    notes: ['Contacts count recorded attempts in the last 30 days; calls are included in contacts.', 'Completed assigned follow-ups describe recorded status, not the actor who completed them.'],
  };
}

type Options = { floorId?: string; operations?: (route: Route) => Promise<unknown>; dashboard?: (route: Route) => Promise<unknown>; onRequest?: (url: URL) => void };
export async function mockSalesAnalytics(page: Page, options: Options = {}) {
  await mockSession(page, '/sales-data', false, { floorId: options.floorId, seedStorageOnce: true });
  const reference={id:'architect-a',name:'Nisha Shah',type:'architect',company:'Studio Line',phone:'9876543210',floor_id:'first-floor',shared_across_floors:true,updated_at:'v1'};
  await page.route('**/api/referrers/page?**',route=>route.fulfill({json:{rows:[reference],total:1,offset:0,limit:25}}));
  await page.route('**/api/analytics/workspaces/relationships?**',route=>route.fulfill({json:{workspace:'relationships',period:'October 2026',kpis:{revenue:240000,orders:1,outstanding:60000},brands:[],products:[],customers:[],floors:[],relationships:[{...reference,revenue:240000,revenue_rnb:0,orders:1,customers:1,customers_acquired:3}]}}));
  await page.route('**/api/analytics/default-period?**',route=>route.fulfill({json:{preset:'this_month',date_from:null,date_to:null,label:'This month',fallback_applied:false,latest_order_at:null}}));
  await page.route('**/api/sales-data/referrers/*?**',route=>route.fulfill({json:{referrer:reference,customers_acquired:3,referred_people:[{customer_name:'Ananya Shah',confirmed:1,sources:['quotations'],floor_ids:['first-floor'],first_referred_at:'2026-10-10T06:00:00Z'},{customer_name:'Example walk-in',confirmed:0,sources:['walkins'],floor_ids:['first-floor'],first_referred_at:'2026-10-12T06:00:00Z'}],total_revenue:240000,total_revenue_rnb:0,trend:[{bucket:'October',revenue:240000}],quotations:[{id:'order-a',number:'SO-1001',customer_name:'Ananya Shah',grand_total:240000,updated_at:'2026-10-10T06:00:00Z'}]}}));
  await page.route('**/api/executive-analytics/**',route=>route.fulfill({json:{salesperson:{full_name:'Example salesperson'},kpis:{revenue:240000,orders:1,aov:240000,customers:1},brands:[{brand_id:'company-a',brand_name:'Hansgrohe',revenue:240000}],products:[],customers:[]}}));
  let review: Record<string, unknown> | null = null;
  await page.route('**/api/sales-analytics/**', async route => {
    const url = new URL(route.request().url());
    options.onRequest?.(url);
    const path = url.pathname.replace('/api/sales-analytics', '');
    const floor = url.searchParams.get('floor_id') || 'all';
    const basis = url.searchParams.get('date_basis') || 'confirmation';
    const dashboard = analyticsDashboard(floor, basis);
    if (path === '/duplicates') return route.fulfill({ json: { items: [{ id: 'duplicate-customers', kind: 'customers', name: 'Ananya Shah', entities: [{ id: 'customer-a', name: 'Ananya Shah', floor_id: 'first-floor', status: 'Active' }, { id: 'customer-review-b', name: 'Ananya Shah', floor_id: 'first-floor', status: 'Active' }], review }], total: 1, page: 1, page_size: 25 } });
    if (path === '/duplicates/review' && route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      review = { decision: body.decision, note: body.note, reviewed_at: '2026-10-29T00:30:00+05:30', reviewed_by_name: 'Audit Owner', revision: (review ? Number(review.revision) : 0) + 1 };
      return route.fulfill({ json: review });
    }
    if (path === '/owner-operations') return options.operations ? options.operations(route) : route.fulfill({ json: analyticsOwnerOperations(floor) });
    if (path === '/dashboard') return options.dashboard ? options.dashboard(route) : route.fulfill({ json: dashboard });
    if (path === '/records') {
      const items = analyticsOrders.filter(row => floor === 'all' || row.floor_id === floor);
      return route.fulfill({ json: { items, total: items.length, page: 1, page_size: 25 } });
    }
    if (/^\/entities\/[^/]+$/.test(path)) {
      const kind = path.split('/')[2] as 'companies' | 'products' | 'architects' | 'customers';
      const needle = (url.searchParams.get('search') || '').toLowerCase();
      const items = dashboard[kind].filter(row => row.name.toLowerCase().includes(needle));
      return route.fulfill({ json: { items, total: items.length, page: 1, page_size: 25 } });
    }
    if (/^\/entities\/[^/]+\/[^/]+$/.test(path)) {
      const [, , kind, id] = path.split('/');
      const row = dashboard[kind as 'companies' | 'products' | 'architects' | 'customers']?.find(item => item.id === id);
      if (!row) return route.fulfill({ status: 404, json: { detail: 'Entity not found in this reporting scope.' } });
      const profileDashboard = analyticsDashboard(row.floor_ids[0], basis);
      return route.fulfill({ json: {
        ...profileDashboard, title: row.name,
        identity: { id, name: row.name, kind, status: 'Active', floor_ids: row.floor_ids, attributes: [{ label: 'Stable ID', value: id }, { label: 'Contact details', value: null }] },
        tables: { orders: { items: analyticsOrders.filter(order => kind === 'customers' ? order.customer_id === id : order.id === 'order-a'), total: 1 }, products: { items: profileDashboard.products, total: profileDashboard.products.length }, customers: { items: profileDashboard.customers.slice(0, 1), total: 1 }, architects: { items: profileDashboard.architects, total: profileDashboard.architects.length },
          quotations: { items: [
            { id: 'quote-catalog', order_id: 'order-a', floor_id: 'ground-floor', number: 'TQ-103', source: 'catalog', customer_name: 'Ananya Shah' },
            { id: 'quote-sanitary', order_id: 'order-a', floor_id: 'first-floor', number: 'SQ-104', source: 'catalog', customer_name: 'Ananya Shah' },
            { id: 'quote-kitchen', project_id: 'project-kitchen', order_id: 'project-kitchen', floor_id: 'second-floor', number: 'KQ-204', source: 'kitchen', customer_name: 'Ananya Shah' },
          ], total: 3 },
          projects: { items: [{ id: 'project-kitchen', project_id: 'project-kitchen', floor_id: 'second-floor', number: 'KP-204', source: 'kitchen', customer_name: 'Ananya Shah' }], total: 1 },
        },
      } });
    }
    if (/^\/orders\/[^/]+$/.test(path)) {
      const id = path.split('/')[2];
      const row = analyticsOrders.find(item => item.id === id);
      if (!row) return route.fulfill({ status: 404, json: { detail: 'Order not found in this reporting scope.' } });
      return route.fulfill({ json: { ...row,
        lines: [{ id: 'line-a', product_id: 'product-a', product_name: 'Talis basin mixer', company_id: 'company-a', company_name: 'Hansgrohe', quantity: 24, unit: 'Piece', unit_price: 10000, total: row.total }],
        payments: [{ id: 'payment-a', amount: row.collected, date: '2026-10-15T06:00:00Z' }],
        timeline: [{ id: 'event-a', status: 'confirmed', date: row.date }], documents: [],
        summary: { subtotal: row.total, discount: 0, total: row.total, collected: row.collected, outstanding: row.outstanding },
        notes: ['Supporting documents unavailable for this record.'],
      } });
    }
    if (path === '/export') return route.fulfill({ contentType: url.searchParams.get('format') === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', headers: { 'Content-Disposition': `attachment; filename="analytics.${url.searchParams.get('format')}"` }, body: Buffer.from('Hermetic analytics export fixture') });
    return route.fulfill({ status: 404, json: { detail: 'Analytics record not found in this reporting scope.' } });
  });
}
