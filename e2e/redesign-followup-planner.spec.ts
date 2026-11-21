import { expect, test, type Page } from '@playwright/test';
import { floors, mockSession } from './audit-fixtures';
import { captureRuntimeHealth } from './runtime-health';

const TODAY = '2026-11-21';
const MONDAY = '2026-11-23';
const FLOOR = 'first-floor';
const NIKHIL = { id: 'nikhil', name: 'Nikhil' };
const MANOJ = { id: 'manoj', name: 'Manoj' };
const GROHE = { id: 'grohe', name: 'Grohe' };
const VITRA = { id: 'vitra', name: 'Vitra' };
type Category = 'all' | 'today' | 'overdue' | 'upcoming' | 'completed' | 'won' | 'lost' | 'created' | 'active' | 'outcomes';
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

function group(...records: RecordRow[]) {
  const { customer_id, customer_name, customer_phone } = records[0];
  return { key: customer_id, customer_id, customer_name, customer_phone, records };
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
  let late = task('late-call', 'late-client', 'QA Overdue Customer', '2026-11-20', 'Q-80', 80_000);
  const monday = task('monday-call', 'monday-client', 'QA Monday Customer', MONDAY, 'Q-125', 125_000);
  const won = quote('Won Customer', 'won', '2026-11-15', 360_000, [GROHE, VITRA]);
  const lost = quote('Lost Customer', 'lost', '2026-07-27', 80_000);
  const created = quote('New Customer', 'created', '2026-11-19', 95_000);
  const reads: URLSearchParams[] = [];
  const postponements: unknown[] = [];
  const notes: { note: string; request_key: string }[] = [];
  const abandonedSearch = Promise.withResolvers<void>();
  const abandonedResponse = Promise.withResolvers<void>();
  let completions = 0;

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
    return route.fulfill({ json: { ...late, bucket: 'overdue' } });
  });
  await page.route(/\/api\/followups\/(call-today|late-call)(?:\?|$)/, route => {
    const row = new URL(route.request().url()).pathname.endsWith('call-today') ? callToday : late;
    const bucket = row.status === 'done' ? 'completed' : row.date === TODAY ? 'today' : row.date < TODAY ? 'overdue' : 'later';
    return route.fulfill({
      json: {
        followup: { ...row, bucket },
        customer: { id: row.customer_id, name: row.customer_name, tier: 'retail', phone: row.customer_phone },
        quotations: [], purchases: [], payments: [], timeline: [],
        stats: { risk_level: 'low', pending_quotations: 0 },
      },
    });
  });
  await page.route(/\/api\/followups\/planner(?:\?|$)/, async route => {
    const query = new URL(route.request().url()).searchParams;
    reads.push(query);
    const category = (query.get('category') || 'all') as Category;
    const period = query.get('period') || 'all_time';
    const groheOnly = query.get('brand') === GROHE.id;
    const mondayLate = late.date === MONDAY;
    const todayTasks = callToday.status === 'open' ? [callToday, secondCallToday] : [secondCallToday];
    const summary = {
      all: metric(4, 455_000, 3),
      today: metric(todayTasks.length, 250_000, 1),
      overdue: mondayLate ? metric() : metric(1, 80_000),
      upcoming: mondayLate ? metric(2, 205_000) : metric(1, 125_000),
      completed: callToday.status === 'done' ? metric(1, 250_000) : metric(),
      won: period === 'all_time' || period === 'last_30_days' ? metric(1, groheOnly ? 240_000 : 360_000) : metric(),
      lost: period === 'all_time' || period === 'last_6_months' ||
        (period === 'custom' && query.get('start') === '2026-07-01' && query.get('end') === '2026-07-31') ?
        metric(1, 80_000) : metric(),
      created: period === 'all_time' || period === 'this_week' ? metric(1, 95_000) : metric(),
    };
    const wonGroups = summary.won.count ? [group({ ...won, value: groheOnly ? 240_000 : 360_000 })] : [];
    const lostGroups = summary.lost.count ? [group(lost)] : [];
    const groupsByCategory = {
      all: [group(...todayTasks), group(late), group(monday)],
      active: [group(...todayTasks), group(late), group(monday)],
      outcomes: [...wonGroups, ...lostGroups],
      today: [group(...todayTasks)],
      overdue: mondayLate ? [] : [group(late)],
      upcoming: mondayLate ? [group(monday), group(late)] : [group(monday)],
      completed: callToday.status === 'done' ? [group(callToday)] : [],
      won: wonGroups,
      lost: lostGroups,
      created: summary.created.count ? [group(created)] : [],
    };
    const week = Number(query.get('week') || '0');
    const days = week === 0 ? [16, 17, 18, 19, 20, 21, 22] : [23, 24, 25, 26, 27, 28, 29];
    const search = (query.get('q') || '').toLowerCase();
    const items = groupsByCategory[category].filter(customer =>
      customer.records.some(record => (!query.get('day') || query.get('day') === record.date)
        && (!query.get('assigned_to') || query.get('assigned_to') === record.assigned_to)
        && (!query.get('department') || query.get('department') === 'all' || query.get('department') === record.floor_id)
        && [record.customer_name, record.customer_phone, record.quotation_number].some(value => value.toLowerCase().includes(search))));
    const response = {
      json: {
        today: TODAY, summary: {
          ...summary, active: metric(todayTasks.length + 2, 455_000, 3),
          outcomes: metric(wonGroups.length + lostGroups.length, (summary.won.amounts[0]?.value || 0) + (summary.lost.amounts[0]?.value || 0)),
        }, items, page: 1, page_size: 25, has_more: false,
        schedule: days.map(day => ({ day: '2026-11-' + day, ...(day === 23 ? summary.upcoming : metric()) })),
        employees: [{
          ...NIKHIL, today: summary.today.count, overdue: summary.overdue.count,
          upcoming: summary.upcoming.count, amounts: [{ currency: 'INR', value: 455_000 }],
        }],
        brands: [{
          ...GROHE, won: summary.won.count, lost: summary.lost.count,
          won_amounts: summary.won.count ? [{ currency: 'INR', value: 240_000 }] : [], lost_amounts: summary.lost.amounts,
        }, {
          ...VITRA, won: summary.won.count, lost: 0,
          won_amounts: summary.won.count ? [{ currency: 'INR', value: 120_000 }] : [], lost_amounts: [],
        }],
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
    lastRead: () => reads.at(-1), postponements, notes, completions: () => completions,
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
  await page.getByTestId('planner-' + filter).click();
  await page.getByTestId('planner-' + filter + '-' + value).click();
}

test('critical Follow-ups planner groups today’s work and opens the next Monday schedule', async ({ page }, info) => {
  const runtime = captureRuntimeHealth(page);
  const fixture = await mockPlanner(page);
  await page.goto('/followups');
  const planner = page.getByTestId('followup-planner');
  const today = planner.getByTestId('planner-card-today');
  await expect(today).toContainText(/₹\s*2,50,000/);
  await expect(today).toContainText('1 customer');
  await today.click();
  await expectQuery(fixture, { category: 'today' });
  const customer = planner.getByTestId('planner-customer-today-client');
  await expect(customer).toHaveCount(1);
  await expect(planner.getByText('QA Monday Customer')).toHaveCount(0);
  if (process.env.FOLLOWUP_PLANNER_SCREENSHOTS === '1') {
    await page.screenshot({ path: info.outputPath('follow-up-planner.png') });
  }
  await customer.click();
  await expect(page.getByTestId('planner-open-call-today')).toBeVisible();
  await expect(page.getByTestId('planner-open-second-call')).toBeVisible();
  await page.getByTestId('planner-open-call-today').click();
  const detail = page.getByRole('dialog', { name: 'QA Today Customer', exact: true });
  await detail.getByRole('button', { name: /^(Done|Complete follow-up|Mark follow-up complete)$/ }).click();
  await expect.poll(fixture.completions).toBe(1);
  await expect(planner.getByTestId('planner-result-metric')).toContainText(/\b1 record\b/);
  if (await detail.isVisible()) await detail.getByRole('button', { name: 'Close', exact: true }).click();
  await customer.click();
  await expect(page.getByTestId('planner-open-call-today')).toHaveCount(0);
  await expect(page.getByTestId('planner-open-second-call')).toBeVisible();
  await detail.getByRole('button', { name: 'Close', exact: true }).click();

  await planner.getByTestId('planner-workload-toggle').click();
  await planner.getByTestId('planner-workload-nikhil').click();
  await expectQuery(fixture, { category: 'active', assigned_to: NIKHIL.id });
  await expect(planner.getByTestId('planner-result-metric')).toContainText(/₹\s*4,55,000/);
  await planner.getByTestId('planner-card-upcoming').click();
  await planner.getByTestId('planner-next-week').click();
  const monday = planner.getByTestId('planner-day-' + MONDAY);
  await expect(monday).toContainText(/Mon/i);
  await expect(monday).toContainText(/23/);
  await monday.click();
  await expectQuery(fixture, { category: 'upcoming', day: MONDAY, week: '1' });
  await expect(planner.getByTestId('planner-customer-monday-client')).toBeVisible();
  await expect(planner.getByTestId('planner-customer-late-client')).toHaveCount(0);
  await runtime.assertHealthy();
});

test('critical Follow-ups planner combines reporting filters, preserves focus and drills into quotations', async ({ page }) => {
  const runtime = captureRuntimeHealth(page);
  const fixture = await mockPlanner(page, true);
  await page.goto('/followups');
  const planner = page.getByTestId('followup-planner');
  const won = planner.getByTestId('planner-card-won');
  await expect(won).toContainText(/₹\s*3,60,000/);
  await won.click();
  const filterToggle = planner.getByTestId('planner-filter-toggle');
  const period = planner.getByTestId('planner-period');
  if (!await period.isVisible()) await filterToggle.click();
  await choose(page, 'period', 'last_30_days');
  await choose(page, 'employee', NIKHIL.id);
  await planner.getByTestId('planner-brand-toggle').click();
  await planner.getByTestId('planner-brand-grohe').click();
  await expectQuery(fixture, { category: 'outcomes', brand: GROHE.id });
  await expect(planner.getByTestId('planner-customer-Won Customer')).toBeVisible();
  const brandWon = planner.getByTestId('planner-brand-grohe-won');
  await expect(brandWon).toContainText(/₹\s*2,40,000/);
  await brandWon.click();
  await planner.getByTestId('planner-department').click();
  await expect(page.getByTestId('planner-department-ground-floor')).toHaveCount(0);
  await expect(page.getByTestId('planner-department-second-floor')).toHaveCount(0);
  await page.getByTestId('planner-department-' + FLOOR).click();
  const search = planner.getByTestId('planner-search');
  try {
    await search.fill('abandoned-search');
    await expectQuery(fixture, { q: 'abandoned-search' });
    await search.fill('Q-Won');
    await expectQuery(fixture, { category: 'won', period: 'last_30_days', assigned_to: NIKHIL.id, brand: GROHE.id, department: FLOOR, q: 'Q-Won' });
    await expect(planner.getByTestId('planner-customer-Won Customer')).toBeVisible();
  } finally {
    await fixture.releaseAbandonedSearch();
  }
  await expect(search).toBeFocused();
  await expect(won).toContainText(/₹\s*2,40,000/);
  await expect(planner.getByTestId('planner-customer-Won Customer')).toBeVisible();
  await expect(planner.getByText('QA Lost Customer')).toHaveCount(0);
  const box = (await search.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);

  await planner.getByTestId('planner-reset').click();
  await planner.getByTestId('planner-card-lost').click();
  if (!await period.isVisible()) await filterToggle.click();
  await choose(page, 'period', 'last_6_months');
  await expectQuery(fixture, { category: 'lost', period: 'last_6_months' });
  await expect(planner.getByTestId('planner-card-lost')).toContainText(/₹\s*80,000/);
  await planner.getByTestId('planner-customer-Lost Customer').click();
  await expect(page.getByText('Customer changed plans')).toBeVisible();
  await page.getByRole('dialog', { name: 'QA Lost Customer' }).getByRole('button', { name: 'Close', exact: true }).click();
  await choose(page, 'period', 'custom');
  await planner.getByTestId('planner-start-date').fill('2026-07-01');
  await planner.getByTestId('planner-end-date').fill('2026-07-31');
  await expectQuery(fixture, { category: 'lost', period: 'custom', start: '2026-07-01', end: '2026-07-31' });
  await expect(planner.getByTestId('planner-customer-Lost Customer')).toBeVisible();
  await runtime.assertHealthy();
});

test('critical Follow-ups planner keeps a postponement draft and reconciles the saved schedule on reload', async ({ page }) => {
  const runtime = captureRuntimeHealth(page);
  const fixture = await mockPlanner(page);
  await page.goto('/followups');
  const planner = page.getByTestId('followup-planner');
  const overdue = planner.getByTestId('planner-card-overdue');
  await overdue.click();
  await expectQuery(fixture, { category: 'overdue' });
  const lateCustomer = planner.getByTestId('planner-customer-late-client');
  await expect(lateCustomer).toContainText('Overdue by 1 day');
  await lateCustomer.click();
  await page.getByTestId('planner-open-late-call').click();
  await page.getByRole('button', { name: 'Postpone follow-up', exact: true }).click();
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
  await expect(overdue).not.toContainText(/₹\s*80,000/);
  await page.reload();
  await planner.getByTestId('planner-card-upcoming').click();
  await planner.getByTestId('planner-next-week').click();
  await planner.getByTestId('planner-day-' + MONDAY).click();
  await expect(planner.getByTestId('planner-customer-late-client')).toHaveCount(1);
  await expect(planner.getByTestId('planner-customer-monday-client')).toHaveCount(1);

  const period = planner.getByTestId('planner-period');
  if (!await period.isVisible()) await planner.getByTestId('planner-filter-toggle').click();
  await choose(page, 'category', 'created');
  await choose(page, 'period', 'this_week');
  await expectQuery(fixture, { category: 'created', period: 'this_week' });
  await expect(planner.getByTestId('planner-result-metric')).toContainText(/₹\s*95,000/);
  await expect(planner.getByTestId('planner-customer-New Customer')).toBeVisible();
  await runtime.assertHealthy();
});

test('critical Follow-ups planner retains an unsaved note and reuses the exact retry key', async ({ page }) => {
  const runtime = captureRuntimeHealth(page);
  const fixture = await mockPlanner(page);
  await page.goto('/followups');
  const planner = page.getByTestId('followup-planner');
  const overdue = planner.getByTestId('planner-card-overdue');
  const customer = planner.getByTestId('planner-customer-late-client');
  await overdue.click();
  await customer.click();
  await page.getByTestId('planner-open-late-call').click();
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
  await expect(page.getByText(written)).toBeVisible();
  await runtime.assertHealthy();
});
