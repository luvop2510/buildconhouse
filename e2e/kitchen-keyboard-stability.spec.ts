import { expect, test, type Locator } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { captureRuntimeHealth } from './runtime-health';

// These resize browser viewports. Physical Android/iOS software keyboards remain a manual release check.
async function insideScrollViewport(field: Locator) {
  await expect.poll(() => field.evaluate(element => {
    const fieldBox = element.getBoundingClientRect();
    const scroll = element.closest('[data-testid="kitchen-page-scroll"]')!;
    const scrollBox = scroll.getBoundingClientRect();
    const viewport = window.visualViewport!;
    return fieldBox.top >= Math.max(scrollBox.top, viewport.offsetTop) - 1
      && fieldBox.bottom <= Math.min(scrollBox.bottom, viewport.offsetTop + viewport.height) + 1;
  }), { message: 'The focused field fits inside the actual scroll viewport above reserved phone chrome' }).toBe(true);
}

for (const width of [360, 390, 768, 1024, 1440]) {
  test(`Kitchen keyboard viewport ${width}: bottom notes, input switching and rotation retain focus and values`, async ({ page, context }, info) => {
    await page.setViewportSize({ width, height: 844 });
    const created = await context.request.post('/api/kitchen-projects', { headers: { 'X-Floor-Id': 'second-floor' }, data: {
      customer_id: process.env.KITCHEN_E2E_CUSTOMER_ID, idempotency_key: randomUUID(),
      lead: { site_location: 'Keyboard clipping acceptance', notes: 'Initial note' },
    } });
    expect(created.ok(), await created.text()).toBe(true);
    const project = await created.json();
    const health = captureRuntimeHealth(page);
    await page.addInitScript(() => {
      localStorage.setItem('forge.jwt.kind', JSON.stringify('staff'));
      localStorage.setItem('forge.active-floor', JSON.stringify('second-floor'));
    });
    await page.goto(`/kitchen/${project.id}/stages/lead`);
    await expect(page.getByTestId('kitchen-project-ready')).toHaveCount(1);
    const notes = page.getByTestId('kitchen-lead-notes');
    await notes.click();
    const focusedNode = await notes.elementHandle();
    await expect(notes).toBeFocused();
    await page.setViewportSize({ width, height: 450 });
    await insideScrollViewport(notes);
    await notes.pressSequentially(' short\nSecond line\nThird line');
    const expected = 'Initial note short\nSecond line\nThird line';
    await expect(notes).toHaveValue(expected);
    await expect(notes).toBeFocused();
    await insideScrollViewport(notes);
    expect(await focusedNode!.evaluate(element => element === document.activeElement), 'Typing retains the original mounted input').toBe(true);
    await page.screenshot({ path: info.outputPath(`keyboard-${width}-editing.png`) });

    // Oversized notes scroll internally; native key navigation keeps the active caret reachable.
    const longTail = "\n" + Array.from({ length: 32 }, (_, line) => `Long note line ${line}`).join("\n");
    await notes.pressSequentially(longTail);
    const longValue = expected + longTail;
    await expect(notes).toHaveValue(longValue);
    await insideScrollViewport(notes);
    await expect.poll(() => notes.evaluate(element => element.clientHeight)).toBeLessThanOrEqual(261);
    // Native caret scrolling may leave bottom padding and line leading below visible text glyphs.
    await expect.poll(() => notes.evaluate(element => {
      const style = getComputedStyle(element);
      const trailingSpace = parseFloat(style.paddingBottom) + parseFloat(style.lineHeight) - parseFloat(style.fontSize);
      return element.scrollHeight - element.clientHeight - element.scrollTop - trailingSpace;
    })).toBeLessThanOrEqual(1);
    await notes.press('ControlOrMeta+A');
    await notes.press('ArrowLeft');
    await notes.pressSequentially('Start ');
    await expect.poll(() => notes.evaluate(element => (element as HTMLTextAreaElement).selectionStart)).toBe(6);
    await expect.poll(() => notes.evaluate(element => element.scrollTop)).toBeLessThanOrEqual(2);
    for (let line = 0; line < 15; line++) await notes.press('ArrowDown');
    await notes.pressSequentially('Middle ');
    const middle = await notes.evaluate(element => ({ scroll: element.scrollTop, height: element.clientHeight,
      total: element.scrollHeight, caret: (element as HTMLTextAreaElement).selectionStart, length: (element as HTMLTextAreaElement).value.length }));
    expect(middle.caret).toBeGreaterThan(6);
    expect(middle.caret).toBeLessThan(middle.length - 10);
    expect(middle.scroll).toBeGreaterThan(0);
    expect(middle.scroll).toBeLessThan(middle.total - middle.height);
    await insideScrollViewport(notes);
    await expect(notes).toBeFocused();
    expect(await focusedNode!.evaluate(element => element === document.activeElement)).toBe(true);
    await page.screenshot({ path: info.outputPath(`keyboard-${width}-long-notes.png`) });
    await notes.fill(expected);
    await expect.poll(() => notes.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);

    // Keyboard traversal is a real user input, with no helper scroll after focus or resizing.
    await notes.press('Shift+Tab');
    const budget = page.getByTestId('kitchen-lead-budget');
    await expect(budget).toBeFocused();
    await insideScrollViewport(budget);
    await budget.press('Tab');
    await expect(notes).toBeFocused();
    await insideScrollViewport(notes);
    await page.setViewportSize({ width: 844, height: 450 });
    await insideScrollViewport(notes);
    await expect(notes).toHaveValue(expected);
    expect(await focusedNode!.evaluate(element => element === document.activeElement), 'Rotation retains the original input').toBe(true);
    await notes.blur();
    await page.setViewportSize({ width, height: 844 });
    await expect(notes).toHaveValue(expected);
    expect(await notes.evaluate(element => document.documentElement.scrollWidth <= innerWidth + 1 && element.isConnected)).toBe(true);
    await health.assertHealthy();
  });
}

const stages = ['lead', 'visit', 'cad', 'design', 'quotation', 'order', 'production', 'installation'] as const;
for (const stage of stages.slice(1)) {
  test(`Kitchen ${stage} keyboard editing keeps the shared field mounted and adjacent content scrollable`, async ({ page, context }) => {
    const headers = { 'X-Floor-Id': 'second-floor' };
    const created = await context.request.post('/api/kitchen-projects', { headers, data: {
      customer_id: process.env.KITCHEN_E2E_CUSTOMER_ID, idempotency_key: randomUUID(), lead: { site_location: `${stage} keyboard acceptance` },
    } });
    expect(created.ok(), await created.text()).toBe(true);
    let project = await created.json();
    for (const target of stages.slice(1)) {
      const moved = await context.request.post(`/api/kitchen-projects/${project.id}/commands`, { headers, data: {
        expected_version: project.version, idempotency_key: randomUUID(), command: 'move_stage', payload: { target_stage: target },
      } });
      expect(moved.ok(), await moved.text()).toBe(true);
      project = await moved.json();
      if (target === stage) break;
    }
    const health = captureRuntimeHealth(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => {
      localStorage.setItem('forge.jwt.kind', JSON.stringify('staff'));
      localStorage.setItem('forge.active-floor', JSON.stringify('second-floor'));
    });
    await page.goto(`/kitchen/${project.id}/stages/${stage}`);
    await expect(page.getByTestId('kitchen-project-ready')).toHaveCount(1);
    if (stage === 'quotation') await page.getByTestId('kitchen-quotation-amount').fill('-1');
    const notes = page.getByTestId(`kitchen-${stage === 'design' ? 'design-edit' : stage}-notes`);
    await notes.click();
    const original = await notes.elementHandle();
    await page.setViewportSize({ width: 390, height: 450 });
    await notes.pressSequentially('First line\nSecond line\nThird line');
    await expect(notes).toHaveValue('First line\nSecond line\nThird line');
    await expect(notes).toBeFocused();
    await insideScrollViewport(notes);
    expect(await original!.evaluate(element => element === document.activeElement)).toBe(true);
    if (stage === 'quotation') {
      // Scroll with the user's wheel while focus remains in the editor; no helper reveals validation.
      await page.mouse.move(10, 200);
      await page.mouse.wheel(0, 100);
      await expect(page.getByText('Enter a valid amount, or leave it blank.', { exact: true })).toBeInViewport();
      await expect(notes).toBeFocused();
    }
    await notes.press('Shift+Tab');
    expect(await notes.evaluate(element => document.activeElement !== element)).toBe(true);
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(notes).toHaveValue('First line\nSecond line\nThird line');
    await health.assertHealthy();
  });
}
