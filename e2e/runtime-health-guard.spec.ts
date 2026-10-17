import { expect, test } from '@playwright/test';
import { captureRuntimeHealth } from './runtime-health';

test('runtime guard rejects React-caught failures even when the page still has visible content', async ({ page }) => {
  await page.setContent('<main>Existing content remains visible</main>');
  const health = captureRuntimeHealth(page);
  await page.evaluate(() => console.error('Minified React error #31; invalid render child'));
  await expect.poll(() => health.errors.length).toBe(1);
  await expect(health.assertHealthy()).rejects.toThrow('No browser or React runtime errors');
  await page.evaluate(() => console.error(new Error('A caught render exception with visible content')));
  await expect.poll(() => health.errors.length).toBe(2);
});

test('runtime guard rejects a boundary screen without browser errors', async ({ page }) => {
  await page.setContent('<main data-testid="route-error-boundary">This page could not open</main>');
  const health = captureRuntimeHealth(page);
  await expect(health.assertHealthy()).rejects.toThrow();
});
