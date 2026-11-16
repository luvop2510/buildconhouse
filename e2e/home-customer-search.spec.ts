import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { captureRuntimeHealth } from './runtime-health';

const headers = { 'X-Floor-Id': 'second-floor' };

test('Home search finds saved customers and opens complete linked history on desktop and phone', async ({ page, context }, info) => {
  const health = captureRuntimeHealth(page);
  const marker = randomUUID().slice(0, 8);
  const name = `Home history ${marker}`;
  const phone = `9${BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 12)}`).toString().slice(-9).padStart(9, '0')}`;
  const created = await context.request.post('/api/kitchen-projects', { headers, data: {
    idempotency_key: randomUUID(), customer: { name, phone, address: 'Synthetic Home search address' },
    lead: { site_location: 'Home search synthetic site', notes: `Saved lead ${marker}` },
  } });
  expect(created.ok(), await created.text()).toBe(true);
  const project = await created.json();
  const interaction = await context.request.post(`/api/kitchen-projects/${project.id}/follow-ups`, { headers, data: {
    stage: 'lead', date: '2026-09-15', notes: `Saved call ${marker}`, interaction_type: 'Call', idempotency_key: randomUUID(),
  } });
  expect(interaction.ok(), await interaction.text()).toBe(true);
  await page.addInitScript(() => {
    localStorage.setItem('forge.jwt.kind', JSON.stringify('staff'));
    localStorage.setItem('forge.active-floor', JSON.stringify('second-floor'));
  });
  // Only Today's unrelated queue is stubbed. Search/profile are actual authenticated
  // FastAPI routes backed by the run-owned Mongo database.
  await page.route('**/api/dashboard/today', route => route.fulfill({ json: {
    floor_id: 'second-floor', floor_name: 'Kitchen', generated_at: '2026-11-16T06:00:00Z', full_floor_access: false,
    resources: ['kitchen_projects'], task_summary: { open: 0, overdue: 0, due_today: 0, completed_today: 0 },
    tasks: [], workflows: [], payments: null, truncated: false,
  } }));
  await page.goto('/dashboard');
  const search = page.getByTestId('home-customer-search-input');
  await expect(search).toBeVisible();
  await search.fill(marker);
  const result = page.getByTestId(`home-customer-result-kitchen-${project.id}`);
  await expect(result).toBeVisible();
  await expect(result).toContainText(name);
  await result.click();
  const profile = page.getByTestId('home-customer-profile');
  await expect(profile).toBeVisible();
  await expect(profile).toContainText(`Saved lead ${marker}`);
  await expect(profile).toContainText(`Saved call ${marker}`);
  await expect(profile).toContainText('2026-09-15');
  await page.screenshot({ path: info.outputPath('home-complete-customer-profile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Close' }).last().click();
  await search.fill(phone.slice(2, 8));
  await expect(result).toBeVisible();
  await search.fill(`No matching person ${randomUUID()}`);
  await expect(page.getByText('No matching customers', { exact: true })).toBeVisible();
  const geometry = await page.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth }));
  expect(geometry.content).toBeLessThanOrEqual(geometry.width + 1);
  await health.assertHealthy();
});
