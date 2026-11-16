import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';
import { todayFixture } from './today-fixtures';
import { captureRuntimeHealth } from './runtime-health';

const stages = [
  ['lead', 'Lead', '#64748B'], ['visit', 'Visit', '#F59E0B'], ['cad', 'CAD File', '#DB2777'],
  ['design', 'Design', '#8B5CF6'], ['quotation', 'Quotation', '#06B6D4'], ['order', 'Order', '#2563EB'],
  ['production', 'Production', '#F97316'], ['installation', 'Installation', '#14B8A6'], ['completed', 'Completed', '#22C55E'],
] as const;
const rgb = (hex: string) => `rgb(${[1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16)).join(', ')})`;

test('critical Kitchen department progress keeps stage colours through refresh and dynamic counts', async ({ page }, testInfo) => {
  const health = captureRuntimeHealth(page);
  await mockSession(page, '/dashboard', false, { floorId: 'second-floor' });
  let updated = false;
  const snapshot = () => ({
    ...todayFixture('second-floor'), floor_name: 'Kitchen Floor', resources: ['kitchen_projects'], tasks: [], payments: null,
    workflows: [{ resource: 'kitchen_projects', label: 'Kitchen projects', total: updated ? 22 : 9,
      statuses: [...stages].reverse().map(([status]) => ({ status, count: updated ? status === 'quotation' ? 22 : 0 : 1 })) }],
  });
  await page.route('**/api/dashboard/today', route => route.fulfill({ json: snapshot() }));
  await page.route('**/api/dashboard/today/overview', route => route.fulfill({ json: snapshot() }));
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  const workflow = page.getByTestId('today-workflow-kitchen_projects');
  await expect(workflow).toBeVisible();
  const meter = page.getByTestId('today-workflow-meter-kitchen_projects');
  for (const [stage, label, hex] of stages) {
    await expect(page.getByTestId(`today-workflow-swatch-kitchen_projects-${stage}`)).toHaveCSS('background-color', rgb(hex));
    await expect(page.getByTestId(`today-workflow-stage-kitchen_projects-${stage}`)).toContainText(label);
    await expect(meter).toHaveAttribute('aria-label', new RegExp(`${label}: 1`));
    expect(await meter.locator(':scope > div').evaluateAll((nodes, expected) =>
      nodes.some(node => getComputedStyle(node).backgroundColor === expected), rgb(hex))).toBe(true);
  }
  await testInfo.attach('Kitchen stage colours', { body: await workflow.screenshot(), contentType: 'image/png' });
  updated = true;
  await page.getByRole('button', { name: 'Refresh floor work', exact: true }).click();
  await expect(meter).toHaveAttribute('aria-label', /Quotation: 22/);
  expect(await meter.locator(':scope > div').evaluateAll(nodes =>
    [...new Set(nodes.map(node => getComputedStyle(node).backgroundColor))])).toEqual([rgb('#06B6D4')]);
  for (const [stage, label, hex] of stages) {
    await expect(page.getByTestId(`today-workflow-swatch-kitchen_projects-${stage}`)).toHaveCSS('background-color', rgb(hex));
    await expect(meter).toHaveAttribute('aria-label', new RegExp(`${label}: ${stage === 'quotation' ? 22 : 0}`));
  }
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(meter).toHaveAttribute('aria-label', /Quotation: 22/);
  const overflow = await workflow.evaluate(node => node.getBoundingClientRect().right > document.documentElement.clientWidth + 1);
  expect(overflow).toBe(false);
  await health.assertHealthy();
});
