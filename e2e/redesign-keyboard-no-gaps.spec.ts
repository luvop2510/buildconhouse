import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

for (const pan of [0, 40]) test(`critical keyboard has no hidden chrome gaps with viewport pan ${pan}`, async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(({ width, height }) => {
    const viewport = new EventTarget();
    Object.assign(viewport, { width, height, offsetTop: 0, offsetLeft: 0, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    (window as any).keyboardGeometry = (height: number, offsetTop: number) => {
      Object.assign(viewport, { height, offsetTop });
      viewport.dispatchEvent(new Event('resize'));
      viewport.dispatchEvent(new Event('scroll'));
    };
  }, page.viewportSize()!);
  await mockSession(page, '/customers/new', false);
  await page.route('**/api/referrers**', r => r.fulfill({ json: [] }));
  await page.goto('/customers/new');
  const header = page.getByTestId('mobile-workspace-header');
  const input = page.getByTestId('new-customer-name');
  const before = await input.boundingBox();
  await input.fill('Keyboard geometry QA');
  await expect(header).toBeVisible();
  expect((await input.boundingBox())!.y).toBeCloseTo(before!.y, 0);
  await page.evaluate(pan => (window as any).keyboardGeometry(360, pan), pan);
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--forge-visible-height'))).toBe('360px');
  const main = page.getByRole('main', { name: 'Workspace content', exact: true });
  await expect.poll(async () => {
    const root = await page.locator('#root').boundingBox(), body = await main.boundingBox();
    return Math.round(root!.y + root!.height - body!.y - body!.height);
  }, { message: 'Content must reach the keyboard without a hidden bottom navigation band' }).toBe(0);
  await expect(header).toBeVisible();
  const stable = await input.boundingBox();
  await page.keyboard.type(' smooth', { delay: 15 });
  expect((await input.boundingBox())!.y).toBeCloseTo(stable!.y, 0);
  await expect(input).toHaveValue('Keyboard geometry QA smooth');
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('keyboard-no-gaps.png') });
});
