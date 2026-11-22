import { expect, test, type Page } from '@playwright/test';
import { floors, mockSession } from './audit-fixtures';
import { captureRuntimeHealth } from './runtime-health';

const TODAY = '2026-11-21';
const MONDAY = '2026-11-23';
const TUESDAY = '2026-11-24';
const FLOOR = 'first-floor';
const NIKHIL = { id: 'nikhil', name: 'Nikhil' };
const MANOJ = { id: 'manoj', name: 'Manoj' };
const GROHE = { id: 'grohe', name: 'Grohe' };
const VITRA = { id: 'vitra', name: 'Vitra' };
type Category = 'all' | 'today' | 'overdue' | 'upcoming' | 'completed' | 'won' | 'lost' | 'created' | 'active' | 'outcomes';
type Bucket = 'today' | 'overdue' | 'later' | 'completed';
type HistoryEntry = { previous_due_at: string; new_due_at: string; reason: string; actor_name: string; changed_at: string };
type NoteEntry = { note: string; actor_name: string; recorded_at: string };

function metric(count = 0, value = 0, customers = count) {
  return { count, customers, amounts: value ? [{ currency: 'INR', value }] : [], missing_dates: 0 };
}

function task(id: string, customerId: string, name: string, date: string, quotation: string, value: number) {
  return {
    id, kind: 'followup' as const, floor_id: FLOOR, quotation_id: quotation,
    quotation_number: quotation, assigned_to: NIKHIL.id, assigned_to_name: NIKHIL.name,
    due_at: new Date(date + 'T00:00:00+05:30').toISOString(), status: 'open', date,
    brands: [GROHE], currency: 'INR', value, notes: 'Review the saved quotation.',
    lost_reason: null, doc_type: 'quotation',
    customer_id: customerId, customer_name: name, customer_phone: '9000000000',
    customer_tier: 'retail', rule_type: 'quotation_followup', category: 'quotation',
    reason: 'Check the quotation', next_action: 'Call customer', suggested_channel: 'call',
    reason_factors: [], tags: [], priority_score: 50, priority_level: 'medium',
    contact_attempts: 0, postponement_history: [] as HistoryEntry[],
    latest_note: null as string | null, note_history: [] as NoteEntry[],
    origin: null as string | null, completed_outcome: null as string | null,
    is_automated: false,
  };
}

function quote(id: string, status: 'won' | 'lost' | 'created', date: string, value: number, brands = [GROHE]) {
  return {
    ...task('record-' + id, id, 'QA ' + id, date, 'Q-' + id, value),
    kind: 'quotation' as const, status, due_at: null, brands,
    lost_reason: status === 'lost' ? 'Customer changed plans' : null,
  };
}

type RecordRow = ReturnType<typeof task> | ReturnType<typeof quote>;

function bucket(row: ReturnType<typeof task>): Bucket {
  return row.status === 'done' ? 'completed' : row.date === TODAY ? 'today' : row.date < TODAY ? 'overdue' : 'later';
}

function amountFor(row: RecordRow, brand: string | null) {
  if (row.quotation_number !== 'Q-Won Customer' || !brand) return row.value;
  return brand === GROHE.id ? 240_000 : 120_000;
}

function groupRecords(rows: RecordRow[], brand: string | null) {
  return [...Map.groupBy(rows, row => row.customer_id)].map(([key, records]) => {
    const { customer_id, customer_name, customer_phone } = records[0];
    return {
      key, customer_id, customer_name, customer_phone,
      records: records.map(row => row.kind === 'quotation'
        ? { ...row, value: amountFor(row, brand) }
        : { ...row, task: { ...row, bucket: bucket(row) } }),
    };
  });
}

function summarize(rows: RecordRow[], brand: string | null) {
  const quotations = new Map(rows.map(row => [row.quotation_id, row]));
  const value = [...quotations.values()].reduce((total, row) => total + amountFor(row, brand), 0);
  return metric(rows.length, value, new Set(rows.map(row => row.customer_id)).size);
}

async function mockPlanner(page: Page, limited = false) {
  const accessible = floors.filter(floor => limited ? floor.id === FLOOR : [FLOOR, 'ground-floor'].includes(floor.id));
  await mockSession(page, '/followups', false, {
    floorId: FLOOR,
    floorAccess: { all_floors: false, floors: accessible, floor_ids: accessible.map(floor => floor.id) },
    ...(limited ? {
      staff: { id: NIKHIL.id, email: 'nikhil@example.test', full_name: NIKHIL.name, role: 'sales', active: true, floor_ids: [FLOOR] },
    } : {}),
  });
  await page.clock.setFixedTime(new Date(TODAY + 'T10:30:00+05:30'));
  await page.route('**/api/followups/config/**', route => route.fulfill({ json: [] }));
  await page.route('**/api/followups/saved-views', route => route.fulfill({ json: [] }));

  let callToday = task('call-today', 'today-client', 'QA Today Customer', TODAY, 'Q-250', 250_000);
  const secondCallToday = task('second-call', 'today-client', 'QA Today Customer', TODAY, 'Q-250', 250_000);
  let late = { ...task('late-call', 'late-client', 'QA Overdue Customer', '2026-11-20', 'Q-80', 80_000), customer_phone: '8765432109' };
  let monday = task('monday-call', 'monday-client', 'QA Monday Customer', MONDAY, 'Q-125', 125_000);
  const showroom = {
    ...task('showroom-visit', 'showroom-client', 'QA Showroom Customer', '2026-11-20', 'Q-SHOW', 85_000),
    assigned_to: MANOJ.id, assigned_to_name: MANOJ.name, brands: [VITRA], origin: 'visit_showroom',
  };
  const won = quote('Won Customer', 'won', '2026-11-15', 360_000, [GROHE, VITRA]);
  const lost = quote('Lost Customer', 'lost', '2026-07-27', 80_000);
  const created = quote('New Customer', 'created', '2026-11-19', 95_000);
  let closedLate: ReturnType<typeof quote> | undefined;
  let closedMonday: ReturnType<typeof quote> | undefined;
  let nextCall: ReturnType<typeof task> | undefined;
  const reads: URLSearchParams[] = [];
  const legacyReads: string[] = [];
  const postponements: unknown[] = [];
  const notes: { note: string; request_key: string }[] = [];
  const outcomes: unknown[] = [];
  const orders: unknown[] = [];
  const abandonedSearch = Promise.withResolvers<void>();
  const abandonedResponse = Promise.withResolvers<void>();
  let completions = 0;

  await page.route('**/api/followups/page?**', route => {
    legacyReads.push(route.request().url());
    return route.fulfill({ json: { items: [], page: 1, page_size: 25, has_more: false } });
  });
  await page.route('**/api/followups/call-today/complete', route => {
    completions++;
    callToday = { ...callToday, status: 'done' };
    return route.fulfill({ json: { ...callToday, completed_at: TODAY + 'T07:00:00Z', bucket: 'completed' } });
  });
  await page.route('**/api/followups/late-call/postpone', route => {
    const body = route.request().postDataJSON();
    postponements.push(body);
    if (postponements.length === 1) {
      return route.fulfill({ status: 503, json: { detail: 'Save interrupted. Try again.' } });
    }
    const dueAt = new Date(body.new_due_date + 'T00:00:00+05:30').toISOString();
    late = { ...late, date: body.new_due_date, due_at: dueAt, postponement_history: [...late.postponement_history, {
      previous_due_at: body.expected_due_at, new_due_at: dueAt, actor_name: NIKHIL.name,
      reason: body.reason, changed_at: TODAY + 'T07:00:00Z',
    }] };
    return route.fulfill({ json: { ...late, bucket: 'later' } });
  });
  await page.route('**/api/followups/late-call/notes', route => {
    const body = route.request().postDataJSON();
    notes.push(body);
    if (notes.length === 1) {
      return route.fulfill({ status: 503, json: { detail: 'Could not confirm the note. Try again.' } });
    }
    late = {
      ...late, notes: body.note, latest_note: body.note,
      note_history: [...late.note_history, { note: body.note, actor_name: NIKHIL.name, recorded_at: TODAY + 'T07:00:00Z' }],
    };
    return route.fulfill({ json: { ...late, bucket: bucket(late) } });
  });
  await page.route('**/api/followups/late-call/log-call', route => {
    const body = route.request().postDataJSON();
    outcomes.push(body);
    if (body.outcome === 'lost') {
      closedLate = { ...quote('Closed Customer', 'lost', TODAY, late.value), quotation_id: late.quotation_id,
        quotation_number: late.quotation_number, customer_id: late.customer_id, customer_name: late.customer_name, lost_reason: body.notes };
    } else if (body.next_followup_at) {
      nextCall = task('next-call', late.customer_id, late.customer_name, body.next_followup_at.slice(0, 10), late.quotation_id, late.value);
      nextCall.due_at = body.next_followup_at;
    }
    late = { ...late, status: 'done', completed_outcome: body.outcome };
    return route.fulfill({ json: { ...late, bucket: bucket(late) } });
  });
  await page.route(/\/api\/followups\/(call-today|late-call|showroom-visit|monday-call)(?:\?|$)/, route => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1);
    const row = id === 'call-today' ? callToday : id === 'showroom-visit' ? showroom : id === 'monday-call' ? monday : late;
    return route.fulfill({
      json: {
        followup: { ...row, bucket: bucket(row) },
        customer: { id: row.customer_id, name: row.customer_name, tier: 'retail', phone: row.customer_phone },
        quotations: [], purchases: [], payments: [], timeline: [],
        stats: { risk_level: 'low', pending_quotations: 0 },
      },
    });
  });
  const line = { id: 'line-125', sku: 'G-125', name: 'Basin', qty: 1, unit_price: 125_000, discount_pct: 0, room: 'Bathroom' };
  const supplier = { id: 'grohe-supplier', name: 'Fixture supplier', brand_id: GROHE.id };
  await page.route(/\/api\/quotations\/Q-125(?:\?|$)/, route => route.fulfill({ json: {
    id: 'Q-125', number: 'Q-125', status: closedMonday ? 'ordered' : 'sent', floor_id: FLOOR, customer_name: monday.customer_name,
    items: [line], rooms: ['Bathroom'], subtotal: monday.value, discount_total: 0, grand_total: monday.value, created_at: '2026-11-19T10:00:00Z',
  } }));
  await page.route('**/api/quotations/Q-125/breakdown', route => route.fulfill({ json: {
    lines: [], totals: { subtotal: monday.value, discount_total: 0, grand_total: monday.value }, project_discount_pct: 0, category_discounts: {},
  } }));
  await page.route('**/api/activity/quotation/Q-125', route => route.fulfill({ json: [] }));
  await page.route('**/api/purchase-orders?quotation_id=Q-125', route => route.fulfill({ json: [] }));
  await page.route('**/api/suppliers', route => route.fulfill({ json: [supplier] }));
  await page.route('**/api/quotations/Q-125/place-order/preview', route => route.fulfill({ json: {
    quotation_id: 'Q-125', quotation_number: 'Q-125', doc_type: 'standard', customer_id: monday.customer_id,
    customer_name: monday.customer_name, total_value: monday.value, brands: [{
      brand_id: GROHE.id, brand_name: GROHE.name, subtotal: monday.value, item_count: 1, default_supplier: supplier,
      items: [{ line_id: line.id, product_id: 'basin-125', sku: line.sku, name: line.name, qty: 1, unit_cost: monday.value }],
    }],
  } }));
  await page.route('**/api/quotations/Q-125/place-order/confirm', route => {
    orders.push(route.request().postDataJSON());
    monday = { ...monday, status: 'done', completed_outcome: 'won' };
    closedMonday = { ...quote('Monday Order', 'won', TODAY, monday.value), quotation_id: monday.quotation_id,
      quotation_number: monday.quotation_number, customer_id: monday.customer_id, customer_name: monday.customer_name };
    return route.fulfill({ json: { purchase_orders: [{ id: 'po-125' }], count: 1 } });
  });
  await page.route(/\/api\/followups\/planner(?:\?|$)/, async route => {
    const query = new URL(route.request().url()).searchParams;
    reads.push(query);
    const category = (query.get('category') || 'all') as Category;
    const period = query.get('period') || 'all_time';
    const brand = query.get('brand');
    const search = (query.get('q') || '').toLowerCase();
    const workspace = query.get('workspace') || 'all';
    const day = query.get('day');
    const inPeriod = (date: string) => {
      if (period === 'last_30_days') return date >= '2026-10-23' && date <= TODAY;
      if (period === 'this_week') return date >= '2026-11-16' && date <= '2026-11-22';
      if (period === 'custom') return date >= query.get('start')! && date <= query.get('end')!;
      return true;
    };
    const inScope = (row: RecordRow) => {
      const department = query.get('department');
      return (workspace === 'all' || (workspace === 'visit_showroom' && row.origin === 'visit_showroom'))
        && (!query.get('assigned_to') || query.get('assigned_to') === row.assigned_to)
        && (!department || department === 'all' || department === row.floor_id)
        && [row.customer_name, row.customer_phone, row.quotation_number].some(value => value.toLowerCase().includes(search))
        && inPeriod(row.date);
    };
    const tasks = [callToday, secondCallToday, late, monday, showroom, ...(nextCall ? [nextCall] : [])].filter(inScope);
    const quotes = [won, lost, created, closedLate, closedMonday].filter((row): row is ReturnType<typeof quote> => row !== undefined).filter(inScope);
    const withBrand = (rows: RecordRow[], brandId: string | null) =>
      rows.filter(row => !brandId || row.brands.some(entry => entry.id === brandId));
    const work = withBrand(tasks, brand);
    const outcomes = withBrand(quotes, brand);
    const active = work.filter(row => row.status === 'open');
    const rowsByCategory = {
      all: work, active, today: active.filter(row => row.date === TODAY),
      overdue: active.filter(row => row.date < TODAY), upcoming: active.filter(row => row.date > TODAY),
      completed: work.filter(row => row.status === 'done'),
      won: outcomes.filter(row => row.status === 'won'), lost: outcomes.filter(row => row.status === 'lost'),
      created: outcomes.filter(row => row.status === 'created'),
      outcomes: outcomes.filter(row => row.status === 'won' || row.status === 'lost'),
    };
    const summary = Object.fromEntries(Object.entries(rowsByCategory).map(([name, rows]) => [name, summarize(rows, brand)]));
    const week = Number(query.get('week') || '0');
    const days = Array.from({ length: 7 }, (_, offset) => new Date(Date.UTC(2026, 10, 16 + week * 7 + offset)).toISOString().slice(0, 10));
    const items = groupRecords(rowsByCategory[category].filter(row => !day || (row.status === 'open' && day === row.date)), brand);
    const workload = (rows: RecordRow[], brandId: string | null) => ({
      today: rows.filter(row => row.date === TODAY).length,
      overdue: rows.filter(row => row.date < TODAY).length,
      upcoming: rows.filter(row => row.date > TODAY).length,
      amounts: summarize(rows, brandId).amounts,
    });
    const response = {
      json: {
        today: TODAY, summary, items, page: 1, page_size: 25, has_more: false, operational: true,
        schedule: days.map(date => ({ day: date, ...summarize(active.filter(row => row.date === date), brand) })),
        employees: [NIKHIL, MANOJ].map(employee => ({
          ...employee, ...workload(active.filter(row => row.assigned_to === employee.id), brand),
        })),
        brands: [GROHE, VITRA].filter(company => !brand || company.id === brand).map(company => {
          const records = withBrand(quotes, company.id);
          const wonTotals = summarize(records.filter(row => row.status === 'won'), company.id);
          const lostTotals = summarize(records.filter(row => row.status === 'lost'), company.id);
          const { amounts, ...counts } = workload(withBrand(active, company.id), company.id);
          return { ...company, ...counts, workload_amounts: amounts, won: wonTotals.count, lost: lostTotals.count,
            won_amounts: wonTotals.amounts, lost_amounts: lostTotals.amounts };
        }),
        options: { employees: limited ? [NIKHIL] : [NIKHIL, MANOJ], brands: [GROHE, VITRA], departments: accessible },
        reports_available: true,
      },
    };
    if (search === 'abandoned-search') {
      await abandonedSearch.promise;
      try { await route.fulfill(response); }
      catch { /* An aborted obsolete read may discard the response at the browser. */ }
      finally { abandonedResponse.resolve(); }
      return;
    }
    return route.fulfill(response);
  });
  return {
    lastRead: () => reads.at(-1), postponements, notes, outcomes, orders, legacyReads, completions: () => completions,
    async releaseAbandonedSearch() {
      abandonedSearch.resolve();
      if (reads.some(query => query.get('q') === 'abandoned-search')) await abandonedResponse.promise;
    },
  };
}

async function expectQuery(fixture: Awaited<ReturnType<typeof mockPlanner>>, params: Record<string, string>) {
  await expect.poll(() => Object.fromEntries(fixture.lastRead()?.entries() || [])).toMatchObject(params);
}

async function choose(page: Page, filter: string, value: string) {
  const control = page.getByTestId('planner-' + filter);
  if (!await control.isVisible()) await page.getByTestId('planner-filter-toggle').click();
  await control.click();
  await page.getByTestId('planner-' + filter + '-' + value).click();
}

test('critical Follow-ups planner groups today’s work and opens the next Monday schedule', async ({ page }, info) => {
  const runtime = captureRuntimeHealth(page);
  const fixture = await mockPlanner(page);
  await page.goto('/customers');
  await page.getByTestId(page.viewportSize()!.width < 768 ? 'bottom-nav-followups' : 'nav-followups').click();
  await expect(page).toHaveURL(/\/followups$/);
  await expectQuery(fixture, { operational: 'true', category: 'all' });
  await expect(page.getByRole('heading', { name: 'Follow-ups', exact: true })).toBeVisible();
  await expect(page.getByTestId('new-followup-btn')).toBeVisible();
  const today = page.getByTestId('planner-card-today');
  await expect(today).toContainText(/₹\s*2,50,000/);
  const first = page.getByTestId('followup-call-today');
  const second = page.getByTestId('followup-second-call');
  const mondayCard = page.getByTestId('followup-monday-call');
  await expect(first).toBeVisible();
  await expect(page.getByTestId('followup-late-call')).toBeInViewport();
  await expect(page.getByText('QA Today Customer', { exact: true })).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(fixture.legacyReads).toEqual([]);
  await today.click();
  await expectQuery(fixture, { category: 'today' });
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();
  await expect(mondayCard).toHaveCount(0);
  if (process.env.FOLLOWUP_PLANNER_SCREENSHOTS === '1') {
    await page.screenshot({ path: info.outputPath('follow-up-workspace.png') });
  }
  await first.click();
  const detail = page.getByRole('dialog', { name: 'QA Today Customer', exact: true });
  await expect(detail).toContainText('Q-250');
  await detail.getByRole('button', { name: /^(Done|Complete follow-up|Mark follow-up complete)$/ }).click();
  await expect.poll(fixture.completions).toBe(1);
  if (await detail.isVisible()) await detail.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(first).toHaveCount(0);
  await expect(second).toBeVisible();
  await expect(page.getByTestId('planner-result-metric')).toContainText(/\b1 record\b/);

  await page.getByTestId('planner-workload-toggle').click();
  const nikhil = page.getByTestId('planner-workload-nikhil');
  await expect(nikhil).toContainText(/₹\s*4,55,000/);
  await expect(page.getByTestId('planner-workload-nikhil-today')).toContainText('Today 1');
  await expect(page.getByTestId('planner-workload-nikhil-overdue')).toContainText('Overdue 1');
  await expect(page.getByTestId('planner-workload-nikhil-upcoming')).toContainText('Upcoming 1');
  await nikhil.click();
  await expectQuery(fixture, { category: 'active', assigned_to: NIKHIL.id });
  await expect(second).toBeVisible();
  await expect(page.getByTestId('followup-showroom-visit')).toHaveCount(0);
  await page.getByTestId('planner-card-upcoming').click();
  await page.getByTestId('planner-next-week').click();
  const monday = page.getByTestId('planner-day-' + MONDAY);
  await expect(monday).toContainText(/Mon/i);
  await expect(monday).toContainText(/23/);
  await monday.click();
  await expectQuery(fixture, { category: 'all', day: MONDAY, week: '1' });
  await expect(mondayCard).toBeVisible();
  await expect(page.getByTestId('followup-late-call')).toHaveCount(0);
  await page.getByTestId('planner-previous-week').click();
  await expectQuery(fixture, { week: '0' });
  await page.getByTestId('planner-previous-week').click();
  await expectQuery(fixture, { week: '-1' });
  await expect(page.getByTestId('planner-day-2026-11-09')).toContainText(/Mon/i);
  await expect(page).toHaveURL(/\/followups$/);

  await page.getByTestId('planner-card-upcoming').click();
  await mondayCard.click();
  const mondayDetail = page.getByRole('dialog', { name: 'QA Monday Customer', exact: true });
  await mondayDetail.getByRole('button', { name: /open quotation/i }).click();
  await expect(page).toHaveURL(/\/quotations\/Q-125$/);
  await page.getByTestId('place-order-btn').click();
  await page.getByTestId('confirm-place-order').click();
  await expect.poll(() => fixture.orders.length).toBe(1);
  await expect(page).toHaveURL(/\/purchases/);
  await page.goto('/followups');
  const won = page.getByTestId('planner-card-won');
  await expect(won).toContainText(/₹\s*4,85,000/);
  await won.click();
  await expect(page.getByText('QA Monday Customer', { exact: true })).toBeVisible();
  await expect(page.getByTestId('planner-open-record-Monday Order')).toBeVisible();
  expect(fixture.legacyReads).toEqual([]);
  await runtime.assertHealthy();
});

test('critical Follow-ups planner combines reporting filters, preserves focus and drills into quotations', async ({ page }) => {
  const runtime = captureRuntimeHealth(page);
  const fixture = await mockPlanner(page, true);
  await page.goto('/followups');
  const won = page.getByTestId('planner-card-won');
  await expect(won).toContainText(/₹\s*3,60,000/);
  await page.getByTestId('planner-brand-toggle').click();
  await expect(page.getByTestId('planner-brand-vitra-won')).toContainText(/₹\s*1,20,000/);
  await page.getByTestId('planner-brand-toggle').click();
  await page.getByTestId('planner-card-overdue').click();
  await expect(page.getByTestId('followup-late-call')).toBeVisible();
  await choose(page, 'period', 'last_30_days');
  await choose(page, 'employee', NIKHIL.id);
  await choose(page, 'company', GROHE.id);
  await expectQuery(fixture, { category: 'overdue', period: 'last_30_days', assigned_to: NIKHIL.id, brand: GROHE.id });
  await expect(page.getByTestId('followup-late-call')).toBeVisible();
  await expect(page.getByTestId('followup-showroom-visit')).toHaveCount(0);
  await expect(page.getByTestId('planner-card-overdue')).toContainText(/₹\s*80,000/);
  await expect(page).toHaveURL(/\/followups$/);
  const search = page.getByTestId('planner-search');
  await search.fill('8765');
  await expectQuery(fixture, { q: '8765' });
  await expect(page.getByTestId('followup-late-call')).toBeVisible();
  await search.fill('');
  await expect.poll(() => fixture.lastRead()?.get('q')).toBeNull();

  await won.click();
  await page.getByTestId('planner-brand-toggle').click();
  await page.getByTestId('planner-brand-grohe').click();
  await expectQuery(fixture, { category: 'outcomes', brand: GROHE.id });
  const brandWon = page.getByTestId('planner-brand-grohe-won');
  await expect(brandWon).toContainText(/₹\s*2,40,000/);
  await brandWon.click();
  const department = page.getByTestId('planner-department');
  if (!await department.isVisible()) await page.getByTestId('planner-filter-toggle').click();
  await department.click();
  await expect(page.getByTestId('planner-department-ground-floor')).toHaveCount(0);
  await expect(page.getByTestId('planner-department-second-floor')).toHaveCount(0);
  await page.getByTestId('planner-department-' + FLOOR).click();
  try {
    await search.fill('abandoned-search');
    await expectQuery(fixture, { q: 'abandoned-search' });
    await search.fill('Q-Won');
    await expectQuery(fixture, { category: 'won', period: 'last_30_days', assigned_to: NIKHIL.id, brand: GROHE.id, department: FLOOR, q: 'Q-Won' });
    await expect(page.getByText('QA Won Customer', { exact: true })).toBeVisible();
  } finally {
    await fixture.releaseAbandonedSearch();
  }
  await expect(search).toBeFocused();
  await expect(won).toContainText(/₹\s*2,40,000/);
  await expect(page.getByTestId('planner-open-record-Won Customer')).toBeVisible();
  await expect(page.getByText(/won · .*Grohe.*₹\s*2,40,000/i)).toBeVisible();
  await expect(page.getByText('QA Lost Customer', { exact: true })).toHaveCount(0);
  const box = (await search.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);

  await page.getByTestId('planner-reset').click();
  await expectQuery(fixture, { category: 'all', period: 'all_time' });
  await expect(page.getByTestId('followup-call-today')).toBeVisible();
  await page.getByTestId('planner-card-lost').click();
  await choose(page, 'period', 'last_6_months');
  await expectQuery(fixture, { category: 'lost', period: 'last_6_months' });
  await page.getByTestId('planner-brand-grohe-lost').click();
  await expectQuery(fixture, { category: 'lost', period: 'last_6_months', brand: GROHE.id });
  await expect(page.getByTestId('planner-card-lost')).toContainText(/₹\s*80,000/);
  await expect(page.getByTestId('planner-open-record-Lost Customer')).toBeVisible();
  await expect(page.getByText('Customer changed plans')).toBeVisible();
  await choose(page, 'period', 'custom');
  await page.getByTestId('planner-start-date').fill('2026-07-01');
  await page.getByTestId('planner-end-date').fill('2026-07-31');
  await expectQuery(fixture, { category: 'lost', period: 'custom', start: '2026-07-01', end: '2026-07-31' });
  await expect(page.getByText('QA Lost Customer', { exact: true })).toBeVisible();
  expect(fixture.legacyReads).toEqual([]);
  await runtime.assertHealthy();
});

test('critical Follow-ups planner keeps a postponement draft and reconciles the saved schedule on reload', async ({ page }) => {
  const runtime = captureRuntimeHealth(page);
  const fixture = await mockPlanner(page);
  await page.goto('/followups');
  const overdue = page.getByTestId('planner-card-overdue');
  await overdue.click();
  await expectQuery(fixture, { category: 'overdue' });
  const lateCustomer = page.getByTestId('followup-late-call');
  await expect(lateCustomer).toContainText(/Overdue/i);
  await lateCustomer.click();
  const detail = page.getByRole('dialog', { name: 'QA Overdue Customer', exact: true });
  await detail.getByRole('button', { name: 'Postpone follow-up', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Postpone follow-up', exact: true });
  const confirm = sheet.getByTestId('confirm-postponement');
  const reason = sheet.getByRole('textbox', { name: 'Reason for postponement', exact: true });
  const date = sheet.getByLabel('New follow-up date');
  await date.fill(MONDAY);
  await reason.fill('   ');
  await expect(confirm).toBeDisabled();
  expect(fixture.postponements).toHaveLength(0);
  await reason.fill('Customer asked for a Monday call');
  await confirm.click();
  await expect(sheet.getByText('Save interrupted. Try again.')).toBeVisible();
  await expect(reason).toHaveValue('Customer asked for a Monday call');
  await expect(date).toHaveValue(MONDAY);
  await confirm.click();
  await expect(sheet).toHaveCount(0);
  const body = { expected_due_at: '2026-11-19T18:30:00.000Z', new_due_date: MONDAY, reason: 'Customer asked for a Monday call' };
  expect(fixture.postponements).toEqual([body, body]);
  await expect(overdue).toContainText(/₹\s*85,000/);
  await page.reload();
  await page.getByTestId('planner-card-upcoming').click();
  await page.getByTestId('planner-next-week').click();
  await page.getByTestId('planner-day-' + MONDAY).click();
  await expect(lateCustomer).toHaveCount(1);
  await expect(page.getByTestId('followup-monday-call')).toHaveCount(1);
  await lateCustomer.click();
  await expect(detail.getByText('Customer asked for a Monday call')).toBeVisible();
  await expect(detail.getByText(/Nikhil/).last()).toBeVisible();
  await detail.getByRole('button', { name: 'Record outcome', exact: true }).click();
  const outcome = page.getByRole('dialog', { name: 'Record contact outcome', exact: true });
  await outcome.getByTestId('outcome-call_back').click();
  await outcome.getByTestId('pending-next-followup-at').fill(TUESDAY);
  await outcome.getByTestId('save-call-outcome').click();
  await expect(outcome).toHaveCount(0);
  expect(fixture.outcomes).toEqual([{ outcome: 'call_back', next_followup_at: TUESDAY + 'T09:00:00+05:30', request_key: expect.any(String) }]);
  await expect(lateCustomer).toHaveCount(0);
  await page.getByTestId('planner-day-' + TUESDAY).click();
  await expect(page.getByTestId('followup-next-call')).toHaveCount(1);

  await choose(page, 'category', 'created');
  await choose(page, 'period', 'this_week');
  await expectQuery(fixture, { category: 'created', period: 'this_week' });
  await expect(page.getByTestId('planner-open-record-New Customer')).toBeVisible();
  await expect(page.getByText('QA New Customer', { exact: true })).toBeVisible();

  await page.getByTestId('planner-reset').click();
  await choose(page, 'workspace', 'visit_showroom');
  await expectQuery(fixture, { workspace: 'visit_showroom', category: 'all' });
  await expect(page.getByTestId('followup-showroom-visit')).toBeVisible();
  await expect(lateCustomer).toHaveCount(0);
  await expect(page).toHaveURL(/\/followups(?:\?|$)/);
  await page.goto('/followups?workspace=visit_showroom');
  await expect(page.getByTestId('followup-showroom-visit')).toBeVisible();
  await expect(lateCustomer).toHaveCount(0);
  expect(fixture.legacyReads).toEqual([]);
  await runtime.assertHealthy();
});

test('critical Follow-ups planner retains an unsaved note and reuses the exact retry key', async ({ page }) => {
  const runtime = captureRuntimeHealth(page);
  const fixture = await mockPlanner(page);
  await page.goto('/followups');
  const overdue = page.getByTestId('planner-card-overdue');
  const customer = page.getByTestId('followup-late-call');
  await overdue.click();
  await customer.click();
  await page.getByTestId('planner-record-note').click();
  const sheet = page.getByRole('dialog', { name: 'Record follow-up note', exact: true });
  const note = sheet.getByTestId('followup-change-note');
  const save = sheet.getByTestId('save-followup-change');
  const written = 'Customer wants the revised specification by email';
  await note.fill('  ' + written + '  ');
  await save.click();
  await expect(sheet.getByText('Could not confirm the note. Try again.')).toBeVisible();
  await expect(note).toHaveValue('  ' + written + '  ');
  await save.click();
  await expect(sheet).toHaveCount(0);
  expect(fixture.notes).toHaveLength(2);
  expect(fixture.notes[0]).toEqual({ note: written, request_key: expect.any(String) });
  expect(fixture.notes[0].request_key).toBeTruthy();
  expect(fixture.notes[1]).toEqual(fixture.notes[0]);
  await page.reload();
  await overdue.click();
  await customer.click();
  const detail = page.getByRole('dialog', { name: 'QA Overdue Customer', exact: true });
  await expect(detail.getByText(written).last()).toBeVisible();
  await detail.getByRole('button', { name: /mark (as )?lost/i }).click();
  const outcome = page.getByRole('dialog', { name: 'Record contact outcome', exact: true });
  const saveOutcome = outcome.getByTestId('save-call-outcome');
  const lossReason = 'Customer awarded the package elsewhere';
  await expect(saveOutcome).toBeDisabled();
  await outcome.getByTestId('outcome-notes').fill(lossReason);
  await saveOutcome.click();
  await expect(outcome).toHaveCount(0);
  expect(fixture.outcomes).toEqual([{ outcome: 'lost', notes: lossReason, request_key: expect.any(String) }]);
  if (await detail.isVisible()) await detail.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(overdue).toContainText(/₹\s*85,000/);
  await expect(customer).toHaveCount(0);
  await page.reload();
  await page.getByTestId('planner-card-lost').click();
  await expect(page.getByTestId('planner-card-lost')).toContainText(/₹\s*1,60,000/);
  await expect(page.getByText(lossReason, { exact: true })).toBeVisible();
  await runtime.assertHealthy();
});
