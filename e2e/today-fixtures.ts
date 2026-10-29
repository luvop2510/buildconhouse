import type { Page } from '@playwright/test';
import type { TodayData } from '../src/api/today';
export function todayFixture(floor = 'first-floor', full = true): TodayData {
  return {
    floor_id: floor, floor_name: floor === 'ground-floor' ? 'Ground Floor' : 'The Sanitary Bathroom',
    generated_at: '2026-10-29T06:30:00Z', full_floor_access: full,
    resources: ['followups', ...(full ? ['quotations','walkins','payments'] : [])],
    task_summary: { open: 2, overdue: 1, due_today: 1, completed_today: 3 },
    tasks: ['First', 'Second'].map((name, index) => ({ id: `followup-${index}`, resource: 'followups', title: `${name} fixture customer`, status: 'open', due_at: '2026-10-29T08:00:00Z', updated_at: null, assignee_name: 'Fixture employee', href: '/followups', progress: null })),
    workflows: full ? [{resource:'quotations',label:'Quotations',total:5,statuses:[{status:'draft',count:2},{status:'ordered',count:3}]}] : [],
    payments: full ? {currency:'INR',received_today:12000,receipt_count:2} : null,
    truncated: false,
  };
}

export async function mockTodayOverview(page: Page, data: TodayData = todayFixture()) {
  await page.route('**/api/dashboard/today/overview', route => route.fulfill({json:{floor_id:data.floor_id,workflows:data.workflows,payments:data.payments,unavailable_sections:[]}}));
}
