import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { gzipSync } from 'node:zlib';
import { mockSession } from './audit-fixtures';
import { captureRuntimeHealth } from './runtime-health';

function primaryContentJavascript(page: Page, baseURL: string) {
  const origin = new URL(baseURL).origin;
  const requested = new Set<string>();
  const captures: { route: string; urls: string[] }[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === origin && url.pathname.endsWith('.js')) requested.add(url.href);
  });
  return {
    begin() { requested.clear(); },
    ready(route: string) { captures.push({ route, urls: [...requested].sort() }); },
    async report() {
      // Read only the immutable export served by this run, after the timing assertions.
      const root = resolve('output/performance-export');
      const sizes = new Map<string, { rawBytes: number; gzipBytes: number }>();
      const routes = [];
      for (const capture of captures) {
        const assets = [];
        for (const url of capture.urls) {
          const pathname = decodeURIComponent(new URL(url).pathname);
          const file = resolve(root, `.${pathname}`);
          expect(file.startsWith(root + sep), 'Observed JavaScript belongs to the frozen export').toBe(true);
          if (!sizes.has(pathname)) {
            const source = await readFile(file);
            sizes.set(pathname, { rawBytes: source.length, gzipBytes: gzipSync(source, { level: 9 }).length });
          }
          assets.push({ url, ...sizes.get(pathname)! });
        }
        expect(assets.length, 'Primary content must include its actual startup JavaScript').toBeGreaterThan(0);
        routes.push({ route: capture.route, rawBytes: assets.reduce((total, asset) => total + asset.rawBytes, 0),
          gzipBytes: assets.reduce((total, asset) => total + asset.gzipBytes, 0), assets });
      }
      return { requestScope: 'All same-origin JavaScript requested from navigation through primary-content readiness, including lazy chunks; URLs deduplicated per route.',
        sizeScope: 'Gzip level 9 of frozen export bytes, calculated after readiness timing; not wire transfer or browser cache measurements.', routes };
    },
  };
}

test('Kitchen bounded project page loads and searches within existing budgets', async ({ page, baseURL, browserName }, info) => {
  const runtime = captureRuntimeHealth(page);
  const javascript = primaryContentJavascript(page, baseURL!);
  const reads: { path: string; limit: string | null; floor?: string }[] = [];
  const unexpected: string[] = [];
  const rows = Array.from({ length: 50 }, (_, index) => ({
    id: `kitchen-performance-${index}`, reference: `KIT-PERFORMANCE-${index}`, project_reference: `KIT-PERFORMANCE-${index}`, customer_id: `customer-${index}`,
    customer: { id: `customer-${index}`, name: `Performance Kitchen customer ${index}`, phone: `990000${String(index).padStart(4, '0')}` },
    version: 4, stage: 'lead', status: 'New', lead: { status: 'New', site_location: `Site ${index}` },
    visit: { status: 'Scheduled' }, cad: { received: false, progress: 0, ready: false, status: 'Not Started' },
    assignments: {}, design_revision_count: 0, site_visit_count: 0, order_amount: null,
    permissions: { can_update: true, can_assign: true, can_configure: true },
  }));
  await mockSession(page, '/kitchen/stages/lead', false);
  await page.addInitScript(() => localStorage.setItem('forge.active-floor', JSON.stringify('second-floor')));
  await page.context().route('**/*', route => {
    if (new URL(route.request().url()).origin !== new URL(baseURL!).origin) {
      unexpected.push('external request'); return route.abort();
    }
    return route.continue();
  });
  await page.route('**/api/kitchen-projects**', async route => {
    const request = route.request(); const url = new URL(request.url());
    reads.push({ path: url.pathname, limit: url.searchParams.get('limit'), floor: request.headers()['x-floor-id'] });
    if (request.method() !== 'GET') unexpected.push(`Unexpected ${request.method()}`);
    await new Promise(done => setTimeout(done, 200));
    if (url.pathname.endsWith('/assignees')) return route.fulfill({ json: { rows: [] } });
    if (url.pathname.endsWith('/configuration')) return route.fulfill({ json: { version: 2, decision_contract: '2026-10-20',
      identity_timing: 'creation', department_manager_user_ids: [], cad_require_received: true, cad_require_progress_100: true,
      assignment_user_ids: [], unassigned_visibility: 'owner', production: { require_advance: true, require_manager_approval: true,
        minimum_advance_amount: null, minimum_advance_percent: null, require_confirmation_document: false, manager_user_ids: [] },
      closure: { require_manager_approval: true, manager_user_ids: [] }, exceptions: null,
      metrics: { hold_is_active: false, overdue_date: 'either', confirmed_value_include_completed: false, confirmed_value_include_cancelled: false },
      files: { allowed_types: ['application/pdf'], max_bytes: 786432 }, required_fields: null, history_corrections: null } });
    if (url.pathname.endsWith('/dashboard')) return route.fulfill({ json: { configured: true, active_projects: 105,
      stage_counts: { lead: 25, visit: 10, cad: 10, design: 10, quotation: 10, order: 10, production: 10, installation: 10, completed: 10 },
      stage_customer_counts: { lead: 25, visit: 10, cad: 10, design: 10, quotation: 10, order: 10, production: 10, installation: 10, completed: 10 },
      pending_approvals: 0, on_hold_projects: 2, next_action_overdue_projects: 10, completion_overdue_projects: 5, active_order_value: '100000.00', overdue_projects: 10, confirmed_order_value: '100000.00' } });
    if (url.pathname === '/api/kitchen-projects') {
      const search = url.searchParams.get('search');
      return route.fulfill({ json: { rows: search ? [rows[49]] : rows.slice(0, 25), total: search ? 1 : 105, page: 1, limit: 25 } });
    }
    unexpected.push(url.pathname);
    return route.fulfill({ status: 500, json: { detail: 'Unexpected kitchen fixture request' } });
  });
  javascript.begin();
  const start = performance.now();
  await page.goto('/kitchen/stages/lead', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('kitchen-project-kitchen-performance-0')).toBeVisible();
  const readyMs = performance.now() - start;
  javascript.ready('/kitchen/stages/lead');
  expect(readyMs).toBeLessThan(2500);
  const query = reads.filter(read => read.path === '/api/kitchen-projects');
  expect(query).toHaveLength(1);
  expect(query[0].limit).toBe('25');
  expect(query[0].floor).toBe('second-floor');
  if (browserName === 'chromium') {
    const cpu = await page.context().newCDPSession(page);
    await cpu.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  }
  const searchStart = performance.now();
  await page.getByTestId('kitchen-search').fill('customer 49');
  await expect(page.getByTestId('kitchen-project-kitchen-performance-0')).toHaveCount(0);
  await expect(page.getByTestId('kitchen-project-kitchen-performance-49')).toBeVisible();
  const searchMs = performance.now() - searchStart;
  expect(searchMs).toBeLessThan(1500);
  await expect(page.getByTestId('kitchen-compact-list')).toBeVisible();
  await expect(page.getByTestId('kitchen-view-menu')).toHaveCount(0);
  await expect(page.getByTestId('kitchen-project-kitchen-performance-49')).toBeVisible();
  if (browserName === 'chromium') await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: 1 });
  javascript.begin();
  const projectsStart = performance.now();
  await page.goto('/kitchen/projects', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('kitchen-project-kitchen-performance-0')).toBeVisible();
  const projectsReadyMs = performance.now() - projectsStart;
  javascript.ready('/kitchen/projects');
  expect(projectsReadyMs, 'All-project queue primary content').toBeLessThan(2500);
  expect(reads.filter(read => read.path === '/api/kitchen-projects').at(-1)?.floor).toBe('second-floor');
  expect(reads.filter(read => read.path === '/api/kitchen-projects').at(-1)?.limit).toBe('25');
  javascript.begin();
  const dashboardStart = performance.now();
  await page.goto('/kitchen', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('kitchen-dashboard-count-lead')).toHaveText('25');
  await expect(page.getByTestId('kitchen-dashboard-stages').getByRole('link')).toHaveCount(9);
  const dashboardReadyMs = performance.now() - dashboardStart;
  javascript.ready('/kitchen');
  expect(dashboardReadyMs, 'Dashboard primary content').toBeLessThan(2500);
  if (browserName === 'chromium') await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const globalSearchStart = performance.now();
  await page.getByTestId('kitchen-universal-search').fill('customer 49');
  await expect(page.getByTestId('kitchen-search-project-kitchen-performance-49')).toBeVisible();
  const globalSearchMs = performance.now() - globalSearchStart;
  expect(globalSearchMs, 'Universal customer search').toBeLessThan(1500);
  const globalReads = reads.filter(read => read.path === '/api/kitchen-projects');
  expect(globalReads.at(-1)?.limit).toBe('20');
  expect(globalReads.at(-1)?.floor).toBe('second-floor');
  expect(unexpected).toEqual([]);
  await runtime.assertHealthy();
  const javascriptEvidence = await javascript.report();
  for (const route of javascriptEvidence.routes.filter(route => route.route !== '/kitchen')) {
    expect(route.assets.some(asset => /\/KitchenWorkspace-[^/]+\.js$/.test(new URL(asset.url).pathname)),
      `${route.route} accounting includes its required lazy queue module`).toBe(true);
  }
  await info.attach('Kitchen performance evidence', { contentType: 'application/json', body: JSON.stringify({ device: info.project.name,
    fixtureLatencyMs: 200, totalProjects: 105, pageProjects: 25, readyMs, searchMs, projectsReadyMs, dashboardReadyMs, globalSearchMs, reads, javascriptEvidence }) });
});

test('Kitchen stage, long history and private document lists meet existing primary-content budgets', async ({ page, baseURL, browserName }, info) => {
  const runtime = captureRuntimeHealth(page);
  const javascript = primaryContentJavascript(page, baseURL!);
  const unexpected: string[] = [];
  await page.addInitScript(() => {
    const observed = window as unknown as { kitchenHistoryFormats: number };
    observed.kitchenHistoryFormats = 0;
    const original = Date.prototype.toLocaleTimeString;
    const activityTime = Date.parse('2026-10-20T10:00:00.000Z');
    Date.prototype.toLocaleTimeString = function (this: Date, ...args: Parameters<Date["toLocaleTimeString"]>) {
      if (this.getTime() === activityTime) observed.kitchenHistoryFormats++;
      return original.apply(this, args);
    };
  });
  const project = {
    id: 'kitchen-heavy', reference: 'KIT-HEAVY', project_reference: 'KIT-HEAVY', customer_id: 'heavy-customer',
    customer: { id: 'heavy-customer', name: 'Synthetic long-running kitchen', phone: '9900000001' },
    version: 500, workflow_cycle: 1, stage: 'design', status: 'Pending', lead: { status: 'Qualified', site_location: 'Synthetic site' },
    visit: { status: 'Visited' }, cad: { received: true, progress: 100, ready: true, status: 'Completed' }, assignments: {},
    design_revision_count: 20, site_visit_count: 5, permissions: { can_update: true, can_assign: true, can_approve_exceptions: true },
    design_versions: Array.from({ length: 120 }, (_, index) => ({ id: `design-${index}`, number: index + 1, workflow_cycle: 1,
      presentation_date: '2026-10-20', response: 'Pending', notes: `Synthetic drawing ${index}`, url: 'https://example.test/synthetic.pdf' })),
    quotation_versions: [], orders: [], approvals: [], blocked_transitions: [{ target_stage: 'quotation', reason: 'Current design approval is required' }],
    activity: Array.from({ length: 500 }, (_, index) => ({ id: `event-${index}`, type: 'metadata', actor_id: 'synthetic-worker',
      actor_name: 'Synthetic worker', at: '2026-10-20T10:00:00Z', payload: { changes: { next_action: { before: `Step ${index}`, after: `Step ${index + 1}` } } } })),
    attachments: Array.from({ length: 120 }, (_, index) => ({ id: `private-${index}`, filename: `Synthetic-drawing-${index}.pdf`, size_bytes: 1000, content_type: 'application/pdf' })),
  };
  await mockSession(page, '/kitchen/kitchen-heavy/stages/design', false);
  await page.addInitScript(() => localStorage.setItem('forge.active-floor', JSON.stringify('second-floor')));
  await page.context().route('**/*', route => {
    if (new URL(route.request().url()).origin !== new URL(baseURL!).origin) { unexpected.push('external request'); return route.abort(); }
    return route.continue();
  });
  await page.route('**/api/kitchen-projects**', async route => {
    if (route.request().method() !== 'GET') unexpected.push('unexpected mutation');
    const pathname = new URL(route.request().url()).pathname;
    await new Promise(done => setTimeout(done, 200));
    if (pathname.endsWith('/configuration')) return route.fulfill({ json: { version: 1, decision_contract: '2026-10-20', department_manager_user_ids: [], files: { max_bytes: 786432, allowed_types: ['application/pdf'] } } });
    if (pathname.endsWith('/assignees')) return route.fulfill({ json: { rows: [] } });
    if (pathname.endsWith('/file-transfers')) return route.fulfill({ json: { transfer: null } });
    if (pathname === '/api/kitchen-projects/kitchen-heavy') return route.fulfill({ json: project });
    unexpected.push(pathname); return route.fulfill({ status: 500, json: { detail: 'Unexpected heavy fixture request' } });
  });
  const timings: Record<string, number> = {};
  for (const [label, suffix, marker] of [['stage', '/stages/design', 'kitchen-current-task-region'], ['history', '/history', 'kitchen-history-category'], ['documents', '/documents', 'kitchen-documents-page']]) {
    javascript.begin();
    const start = performance.now();
    await page.goto(`/kitchen/kitchen-heavy${suffix}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId(marker)).toBeVisible();
    timings[label] = performance.now() - start;
    javascript.ready(`/kitchen/kitchen-heavy${suffix}`);
    expect(timings[label], `${label} primary content`).toBeLessThan(2500);
    if (label === 'history') {
      await expect(page.getByText('500 records', { exact: true })).toBeVisible();
      const formattingWork = () => page.evaluate(() => (window as unknown as { kitchenHistoryFormats: number }).kitchenHistoryFormats);
      expect(await formattingWork(), 'Only visible activity needs date formatting, including initial rerenders').toBeLessThan(250);
      if (browserName === 'chromium') await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: 4 });
      const expand = performance.now();
      await page.getByRole('button', { name: 'Show earlier records', exact: true }).click();
      await expect(page.getByText('next action: Step 440 → Step 441', { exact: true })).toBeVisible();
      timings.historyExpand = performance.now() - expand;
      expect(timings.historyExpand).toBeLessThan(1500);
      expect(await formattingWork(), 'Expansion must not eagerly format all 500 records').toBeLessThan(250);
      if (browserName === 'chromium') await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: 1 });
    }
    if (label === 'documents') await expect(page.getByRole('button', { name: 'Download Synthetic-drawing-119.pdf', exact: true })).toBeVisible();
    await runtime.assertHealthy();
  }
  expect(unexpected).toEqual([]);
  const javascriptEvidence = await javascript.report();
  for (const route of javascriptEvidence.routes) {
    expect(route.assets.some(asset => /\/KitchenProjectDetail-[^/]+\.js$/.test(new URL(asset.url).pathname)),
      `${route.route} accounting includes its required lazy project module`).toBe(true);
  }
  await info.attach('Kitchen heavy-page fixture timing', { contentType: 'application/json', body: JSON.stringify({ device: info.project.name,
    fixtureLatencyMs: 200, activityRecords: 500, designVersions: 120, privateFiles: 120, timings, javascriptEvidence,
    scope: 'Local fixture rendering only; no hosted storage/auth/network performance claim' }) });
});
