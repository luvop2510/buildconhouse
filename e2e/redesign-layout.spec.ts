import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

test('critical page headings remain readable inside clipping ancestors', async ({ page }) => {
  test.setTimeout(90000);
  await mockSession(page, '/customers');
  for (const path of ['/customers', '/walkins', '/followups', '/purchases', '/payments', '/payments-list', '/tiles', '/tiles/orders', '/sales-data', '/team']) {
    await page.goto(path);
    const heading = page.getByRole('heading', { level: 1 }).first();
    await expect(heading).toBeVisible();
    const defects = await heading.evaluate(element => {
      const failures: string[] = [];
      const box = element.getBoundingClientRect();
      if (box.width < Math.min(180, innerWidth / 2)) failures.push('Title is compressed');
      if (element.scrollWidth > element.clientWidth + 2) failures.push('Title text overflows its box');
      if (box.left < -1 || box.right > innerWidth + 1) failures.push('Title leaves the viewport');
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (!['hidden', 'clip'].includes(style.overflowX)) continue;
        const parentBox = ancestor.getBoundingClientRect();
        if (box.left < parentBox.left - 2 || box.right > parentBox.right + 2) failures.push('Title is clipped by an ancestor');
      }
      return failures;
    });
    expect(defects, path).toEqual([]);
  }
});

test('critical enlarged form text retains visible focus and reachable save controls', async ({ page }, info) => {
  await mockSession(page, '/customers/new');
  await page.goto('/customers/new');
  await page.getByTestId('new-customer-name').fill('A long customer and project name for a showroom renovation');
  // Exercise reflow with 200% text size; this is not a claim of browser zoom coverage.
  await page.evaluate(() => {
    const elements = Array.from(document.querySelectorAll<HTMLElement>('main *')).filter(el => el.children.length === 0 && el.innerText?.trim());
    const sizes = elements.map(el => parseFloat(getComputedStyle(el).fontSize));
    elements.forEach((el, index) => { el.style.fontSize = `${sizes[index] * 2}px`; el.style.lineHeight = '1.4'; });
  });
  const save = page.getByRole('button', { name: 'Save Customer', exact: true });
  await save.focus();
  await expect(save).toBeFocused();
  await expect(save).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const box = await save.boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(44);
  expect((box?.y || 0) + (box?.height || 0)).toBeLessThanOrEqual(page.viewportSize()!.height);
  await page.screenshot({ path: info.outputPath('enlarged-customer-form.png'), fullPage: true });
});
