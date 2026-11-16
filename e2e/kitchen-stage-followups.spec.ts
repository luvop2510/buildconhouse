import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { captureRuntimeHealth } from './runtime-health';

const headers = { 'X-Floor-Id': 'second-floor' };
const stages = ['lead', 'visit', 'cad', 'design', 'quotation', 'order', 'installation', 'completed'] as const;

test('Each Kitchen section records numbered follow-ups with explicit dates and retains them on reload', async ({ page, context }, info) => {
  test.setTimeout(150000);
  const health = captureRuntimeHealth(page);
  await page.addInitScript(() => {
    localStorage.setItem('forge.jwt.kind', JSON.stringify('staff'));
    localStorage.setItem('forge.active-floor', JSON.stringify('second-floor'));
  });
  const response = await context.request.post('/api/kitchen-projects', { headers, data: {
    customer_id: process.env.KITCHEN_E2E_CUSTOMER_ID, idempotency_key: randomUUID(),
    lead: { site_location: 'Synthetic stage interaction acceptance' },
  } });
  expect(response.ok(), await response.text()).toBe(true);
  const project = await response.json();
  for (const stage of stages) {
    await page.goto(`/kitchen/${project.id}/stages/${stage}`);
    await expect(page.getByTestId('kitchen-project-ready')).toBeAttached();
    await expect(page.getByTestId('kitchen-followup-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('kitchen-followup-content')).toHaveCount(0);
    await page.getByTestId('kitchen-followup-toggle').click();
    await page.getByTestId('kitchen-followup-add').click();
    await expect(page.getByTestId('kitchen-followup-form')).toContainText('Follow-Up 1');
    await expect(page.getByTestId('kitchen-followup-date')).toHaveValue('');
    await page.getByTestId('kitchen-followup-date').focus();
    await expect(page.getByTestId('kitchen-followup-date')).toHaveValue('');
    await expect(page.getByTestId('kitchen-followup-save')).toBeDisabled();
    await page.getByTestId('kitchen-followup-date').fill('2026-09-14');
    await page.getByTestId('kitchen-followup-notes').fill(`Saved ${stage} interaction`);
    await page.getByTestId(`kitchen-followup-type-${stage === 'lead' ? 'call' : 'visit'}`).click();
    const save = page.waitForResponse(value => value.url().endsWith('/follow-ups') && value.request().method() === 'POST');
    await page.getByTestId('kitchen-followup-save').click();
    const saved = await save;
    expect(saved.ok(), await saved.text()).toBe(true);
    expect((await saved.json()).number).toBe(1);
    await expect(page.getByTestId('kitchen-followup-record-1')).toContainText(`Saved ${stage} interaction`);
    await page.getByTestId('kitchen-followup-toggle').click();
    await expect(page.getByTestId('kitchen-followup-content')).toHaveCount(0);
    await page.getByTestId('kitchen-followup-toggle').click();
    await expect(page.getByTestId('kitchen-followup-record-1')).toContainText(`Saved ${stage} interaction`);
    if (stage === 'lead') {
      await page.getByTestId('kitchen-followup-add').click();
      await expect(page.getByTestId('kitchen-followup-form')).toContainText('Follow-Up 2');
      await expect(page.getByTestId('kitchen-followup-date')).toHaveValue('');
      await page.getByTestId('kitchen-followup-date').fill('2026-09-15');
      await page.getByTestId('kitchen-followup-notes').fill('Second lead contact');
      await page.getByTestId('kitchen-followup-save').click();
      await expect(page.getByTestId('kitchen-followup-record-2')).toContainText('Second lead contact');
    }
    await page.reload();
    await expect(page.getByTestId('kitchen-followup-toggle')).toHaveAttribute('aria-expanded', 'false');
    await page.getByTestId('kitchen-followup-toggle').click();
    await expect(page.getByTestId('kitchen-followup-record-1')).toContainText(`Saved ${stage} interaction`);
    const history = await context.request.get(`/api/kitchen-projects/${project.id}/follow-ups?stage=${stage}`, { headers });
    expect(history.ok(), await history.text()).toBe(true);
    expect(history.headers()['cache-control']).toBe('no-store');
    expect(history.headers()['content-type']).toContain('application/json');
    expect((await history.json()).rows[0].date).toBe(stage === 'lead' ? '2026-09-15' : '2026-09-14');
    const width = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
    expect(width.content).toBeLessThanOrEqual(width.viewport + 1);
  }
  const current = await context.request.get(`/api/kitchen-projects/${project.id}`, { headers });
  expect((await current.json()).stage).toBe('lead');
  await page.getByTestId('kitchen-project-actions').click();
  await page.getByRole('menuitem', { name: 'History', exact: true }).click();
  await expect(page.getByTestId('kitchen-history-sheet')).toContainText('Follow-Up history');
  await expect(page.getByTestId('kitchen-history-sheet')).toContainText('Second lead contact');
  await page.screenshot({ path: info.outputPath('kitchen-followup-history.png'), fullPage: true });
  await health.assertHealthy();
});
