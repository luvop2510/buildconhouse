import { expect, type Locator, type Page } from '@playwright/test';

export async function analyticsFitsViewport(page: Page, controls: Locator[] = []) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Analytics fits its viewport').toBe(true);
  for (const control of controls) {
    await expect(control).toBeVisible();
    await control.scrollIntoViewIfNeeded();
    const box = await control.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
    expect(box!.height).toBeGreaterThanOrEqual(43.999);
    expect(box!.width).toBeGreaterThanOrEqual(43.999);
  }
}

export async function analyticsChoice(page: Page, id: string, value: string) {
  await page.getByTestId(id).click();
  await page.getByTestId(`${id}-${value}`).click();
}

export async function analyticsFloor(page: Page, floor: string) {
  await page.getByTestId('analytics-filter-open').click();
  await analyticsChoice(page, 'analytics-floor-picker', floor);
  await page.getByTestId('analytics-filter-apply').click();
}

export async function analyticsCustomRange(page: Page, from = '2026-09-03', to = '2026-09-17') {
  await page.getByTestId('analytics-filter-open').click();
  await analyticsChoice(page, 'analytics-period', 'custom');
  await page.getByTestId('analytics-date-from').fill(from);
  await page.getByTestId('analytics-date-to').fill(to);
}

export async function analyticsExport(page: Page, format: 'pdf' | 'xlsx') {
  await page.getByTestId('analytics-export').click();
  const downloaded = page.waitForEvent('download');
  await page.getByTestId(`analytics-export-${format}`).click();
  const mobileSave = await page.evaluate(() => /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
    || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (mobileSave) await page.getByTestId('mobile-file-download').click();
  return downloaded;
}
