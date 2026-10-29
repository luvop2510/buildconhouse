import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

for (const kind of ['selection', 'quotation'] as const) {
  for (const layout of [
    { name: '320px phone', width: 320, height: 740, keyboardHeight: 350 },
    { name: 'landscape phone', width: 844, height: 390, keyboardHeight: 230 },
  ]) test(`critical tiles ${kind} keeps address editable above keyboard on ${layout.name}`, async ({ page }, info) => {
    await page.setViewportSize({ width: layout.width, height: layout.height });
    await page.addInitScript(({ width, height }) => {
      const viewport = new EventTarget();
      Object.assign(viewport, { width, height, offsetTop: 0, offsetLeft: 0, scale: 1 });
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
      (window as any).keyboardGeometry = (height: number, offsetTop = 0) => {
        Object.assign(viewport, { height, offsetTop });
        viewport.dispatchEvent(new Event('resize'));
        viewport.dispatchEvent(new Event('scroll'));
      };
    }, page.viewportSize()!);
    const path = `/tiles/${kind}?id=keyboard-document`;
    await mockSession(page, path, false);
    await page.route('**/api/referrers**', route => route.fulfill({ json: [] }));
    await page.route('**/api/quotations/keyboard-document*', route => route.fulfill({ json: {
      id: 'keyboard-document', number: 'T-KEYBOARD', doc_type: `tiles_${kind}`,
      customer_id: 'keyboard-customer', customer_name: 'Keyboard Customer', phone_snapshot: '9900000000',
      address_snapshot: 'Original customer address', status: 'draft', items: [], subtotal: 0, grand_total: 0,
      updated_at: '2026-10-29T00:00:00Z',
    } }));
    await page.goto(path);
    const dock = page.getByTestId('tiles-mobile-workflow-dock');
    const scroll = page.getByTestId('tiles-mobile-editor-scroll');
    const address = page.getByTestId('mobile-address');
    await expect(dock).toBeVisible();
    await expect(address).toHaveValue('Original customer address');
    // Retain the actual input node across focus, keyboard pan and rotation.
    await address.evaluate(node => { (window as any).originalTilesAddress = node; });
    await address.fill('Customer address entered while keyboard is open');
    await expect(dock).toBeHidden();
    await expect(dock).toHaveAttribute('aria-hidden', 'true');
    await page.evaluate(height => (window as any).keyboardGeometry(height, 24), layout.keyboardHeight);
    await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--forge-visible-height'))).toBe(`${layout.keyboardHeight}px`);
    await expect.poll(async () => {
      const main = await page.getByRole('main', { name: 'Workspace content', exact: true }).boundingBox();
      const editor = await scroll.boundingBox();
      return Math.round(main!.y + main!.height - editor!.y - editor!.height);
    }, { message: 'Editor reaches the keyboard with no workflow dock or reserved bottom band' }).toBe(0);
    await expect.poll(async () => {
      const field = await address.boundingBox(), editor = await scroll.boundingBox();
      return field!.y >= editor!.y && field!.y + field!.height <= editor!.y + editor!.height;
    }, { message: 'Address and its caret are inside the editable viewport' }).toBe(true);
    await page.keyboard.type(' edited', { delay: 10 });
    await expect(address).toHaveValue('Customer address entered while keyboard is open edited');
    expect(await address.evaluate(node => node === (window as any).originalTilesAddress && node === document.activeElement)).toBe(true);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`tiles-${kind}-keyboard.png`) });
    await address.blur();
    await page.evaluate(height => (window as any).keyboardGeometry(height), layout.height);
    await expect(dock).toBeVisible();
    // The restored dock occupies its own layout space rather than covering fields.
    const editor = await scroll.boundingBox(), actions = await dock.boundingBox();
    expect(editor!.y + editor!.height).toBeLessThanOrEqual(actions!.y + 1);
    await expect(address).toHaveValue('Customer address entered while keyboard is open edited');
  });
}
