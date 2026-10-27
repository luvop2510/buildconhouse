import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

// Deterministic display fixtures only. The audit server has no production API
// proxy and every request is intercepted before opening the prior export.
const base = process.env.SALES_BEFORE_URL || 'http://127.0.0.1:8094';
const output = '.taste-skill/before';
const floors = [
  { id: 'first-floor', slug: 'first-floor', name: 'Sanitary' },
  { id: 'ground-floor', slug: 'ground-floor', name: 'Tiles' },
  { id: 'second-floor', slug: 'second-floor', name: 'Kitchen' },
  { id: 'third-floor', slug: 'third-floor', name: 'Furniture' },
];
const period = { start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z', label: 'This month' };
const brands = [
  { brand_id: 'hansgrohe', name: 'Hansgrohe', revenue: 180000, quantity: 24, orders: 8, is_unlinked: false },
  { brand_id: 'duravit', name: 'Duravit', revenue: 60000, quantity: 8, orders: 4, is_unlinked: false },
];
const products = [
  { product_id: 'basin', name: 'Vero Air washbasin', brand_name: 'Duravit', revenue: 60000, quantity: 8, orders: 4, customers: 3 },
  { product_id: 'mixer', name: 'Talis single lever basin mixer', brand_name: 'Hansgrohe', revenue: 180000, quantity: 24, orders: 8, customers: 5 },
];
const customers = [{ customer_id: 'fixture-customer', name: 'Display fixture customer', revenue: 240000, orders: 12, aov: 20000, last_order_at: '2026-10-26T10:00:00Z' }];
const relationships = [{ id: 'fixture-reference', name: 'Display fixture architect', company: 'Display fixture studio', type: 'architect', revenue: 240000, orders: 12, customers: 8, customers_acquired: 10, last_order_at: '2026-10-26T10:00:00Z' }];
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
try {
  for (const width of [320, 390, 768, 1024, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: width >= 1024 ? 900 : 844 } });
    await context.addInitScript(() => {
      localStorage.setItem('forge.jwt.kind', JSON.stringify('staff'));
      localStorage.setItem('forge.active-floor', JSON.stringify('first-floor'));
    });
    await context.route('**/api/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      let body;
      if (pathname === '/api/auth/me') body = { id: 'fixture-owner', full_name: 'Display fixture owner', role: 'owner', active: true, floor_ids: floors.map(f => f.id) };
      else if (pathname === '/api/settings/floor-access') body = { all_floors: true, floors, floor_ids: floors.map(f => f.id) };
      else if (pathname === '/api/settings/permission-matrix') body = { modules: [], roles: [], matrix: { owner: {} } };
      else if (pathname === '/api/settings/floors') body = floors;
      else if (pathname === '/api/settings/roles' || pathname === '/api/referrers' || pathname === '/api/notifications') body = [];
      else if (pathname.endsWith('/default-period')) body = { preset: 'this_month', date_from: null, date_to: null, label: 'This month', fallback_applied: false, latest_order_at: null };
      else if (pathname.endsWith('/overview')) body = {
        period, kpis: { revenue: 240000, orders: 12, aov: 20000, customers: 8, outstanding: { ordered: 240000, collected: 180000, outstanding: 60000 }, comparison: { delta_pct: null, direction: null, history_state: 'no_prior_period' }, previous_label: null, previous_revenue: null },
        revenue_by_floor: [{ floor_id: 'first-floor', revenue: 240000, orders: 12 }], attention: [], opportunities: [], attention_total: 0, opportunities_total: 0,
      };
      else if (pathname.includes('/workspaces/')) body = { workspace: pathname.split('/').at(-1), period: period.label, kpis: { revenue: 240000, orders: 12, outstanding: 60000 }, brands, products, customers, relationships, floors: [] };
      else if (pathname.endsWith('/revenue-by-brand')) body = { rows: brands };
      else if (pathname.endsWith('/revenue-by-customer')) body = { rows: customers };
      else if (pathname.endsWith('/best-selling-products')) body = { rows: products };
      else if (pathname.endsWith('/revenue-trend')) body = { points: [{ bucket: '01 Oct', revenue: 60000 }, { bucket: '15 Oct', revenue: 180000 }] };
      else if (pathname.includes('/analytics/')) body = { rows: [], total: 0 };
      else return route.fulfill({ status: 503, json: { detail: 'Unconfigured display fixture request' } });
      return route.fulfill({ json: body });
    });
    const page = await context.newPage();
    for (const [name, route] of [['sales', '/sales-data'], ['references', '/sales-data/relationships'], ['customers', '/sales-data/customers']]) {
      await page.goto(`${base}${route}`);
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `${output}/${name}-${width}.png`, fullPage: true });
    }
    await context.close();
  }
} finally {
  await browser.close();
}
console.log(`Before screenshots: ${output}/{sales,references,customers}-{320,390,768,1024,1440}.png (display fixtures)`);
