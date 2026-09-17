import { expect, test, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mockSession } from './audit-fixtures';

type RouteBaseline = { routes: { route: string; group: string }[] };

const baselinePath = process.env.FORGE_ROUTE_BASELINE;
const baseline: RouteBaseline | null = baselinePath && existsSync(baselinePath)
  ? JSON.parse(readFileSync(baselinePath, 'utf8'))
  : null;
const routes = baseline?.routes || [];
const visualRoutes = new Set(['/dashboard', '/customers', '/followups', '/quotations/new', '/tiles/orders', '/settings']);
const visualDirectory = process.env.FORGE_DRIFT_VISUAL_DIR;

function usesSession(path: string) {
  return !['/', '/login', '/privacy', '/terms'].includes(path);
}

function routeSlug(path: string) {
  return path === '/' ? 'root' : path.slice(1).replaceAll('/', '--').replaceAll(':', 'param-');
}

async function assertSurface(page: Page, path: string) {
  const errors: string[] = [];
  page.on('pageerror', (error: Error) => errors.push(error.message));
  if (usesSession(path)) await mockSession(page, path);
  await page.goto(path);
  await expect(page.locator('body')).not.toContainText('Unmatched Route');
  await expect.poll(() => page.locator('body').innerText()).toMatch(/[A-Za-z]{4}/);
  await page.waitForTimeout(500);
  expect(errors, `${path} browser errors`).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${path} horizontal overflow`).toBe(true);
  const heading = page.getByRole('heading').first();
  if (await heading.count()) {
    await expect(heading).toBeVisible();
    const headingState = await heading.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const failures: string[] = [];
      if (box.left < -1 || box.right > innerWidth + 1) failures.push('heading outside viewport');
      if (element.scrollWidth > element.clientWidth + 2) failures.push('heading text overflow');
      return failures;
    });
    expect(headingState, `${path} heading`).toEqual([]);
  }
  const unnamed = await page.locator('button, [role="button"], [role="link"], [role="tab"]').evaluateAll((elements) => elements.filter((element) => {
    const node = element as HTMLElement;
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return !(node.getAttribute('aria-label') || node.textContent?.trim() || node.getAttribute('title'));
  }).length);
  expect(unnamed, `${path} unnamed interactive controls`).toBe(0);
  if (visualDirectory && visualRoutes.has(path)) {
    mkdirSync(visualDirectory, { recursive: true });
    await page.screenshot({ path: join(visualDirectory, `${test.info().project.name}-${routeSlug(path)}.png`), fullPage: true });
  }
}

if (!baseline) {
  test('requires FORGE_ROUTE_BASELINE', () => {
    expect(baselinePath, 'Set FORGE_ROUTE_BASELINE to state/forge-route-baseline.json').toBeTruthy();
  });
} else {
  for (const { route } of routes) {
    test(`drift gate: ${route}`, async ({ page }) => {
      await assertSurface(page, route);
    });
  }
}
