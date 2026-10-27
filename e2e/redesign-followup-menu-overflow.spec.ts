import { expect, test, type Page } from '@playwright/test';
import { mockSession } from './audit-fixtures';

async function followups(page: Page, floorId: string, role = 'owner') {
  await mockSession(page, '/followups', false, { floorId, staff: {
    id: 'audit-owner', email: 'worker@example.test', full_name: 'Current account', role, active: true,
    floor_ids: [floorId],
  } });
  await page.route('**/api/followups/config/assignees', route => route.fulfill({ json: [
    { id: 'sales-worker', full_name: 'Floor salesperson', role: 'sales' },
  ] }));
  await page.route('**/api/followups/config/customers**', route => route.fulfill({ json: [] }));
  await page.route('**/api/followups/saved-views', route => route.fulfill({ json: [] }));
  await page.route('**/api/followups/page?**', route => route.fulfill({ json: {
    items: [{ id: 'menu-customer', customer_id: 'customer', customer_name: 'Follow-up customer',
      customer_phone: '9000000000', customer_tier: 'retail', floor_id: floorId,
      category: 'general', value: 0, reason: 'Call about the quotation', next_action: 'Call customer',
      suggested_channel: 'call', priority_score: 50, priority_level: 'medium', status: 'open', bucket: 'today',
      due_at: new Date().toISOString(), is_automated: false, contact_attempts: 0,
      assigned_to: 'sales-worker', assigned_to_name: 'Floor salesperson' }],
    page: 1, page_size: 100, has_more: false,
  } }));
  let detailReads = 0;
  await page.route('**/api/followups/menu-customer', route => {
    detailReads += 1;
    return route.fulfill({ status: 503, json: { detail: 'Customer preview must not open from an action' } });
  });
  await page.goto('/followups');
  const card = page.getByTestId('followup-menu-customer');
  await expect(card).toBeVisible();
  return { card, detailReads: () => detailReads };
}

for (const floorId of ['ground-floor', 'first-floor', 'third-floor']) {
  test(`critical ${floorId} selected follow-up actions fit the viewport and menus stay separate from customer details`, async ({ page }, info) => {
    const { card, detailReads } = await followups(page, floorId);
    await card.getByRole('checkbox', { name: 'Select', exact: true }).click();
    const bar = page.getByText('selected', { exact: true }).locator('..').locator('..');
    const bounds = await bar.boundingBox();
    expect(bounds).not.toBeNull();
    const width = page.viewportSize()!.width;
    if (width < 768) {
      const lastCardAction = card.getByRole('button', { name: 'More', exact: true });
      await expect.poll(async () => {
        await lastCardAction.evaluate(element => {
          for (let parent = element.parentElement; parent; parent = parent.parentElement) {
            if (/auto|scroll/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight) {
              parent.scrollTop = parent.scrollHeight;
              return;
            }
          }
        });
        const actionBounds = (await lastCardAction.boundingBox())!;
        return actionBounds.y + actionBounds.height;
      }).toBeLessThanOrEqual(bounds!.y);
    }
    for (const name of ['Snooze', 'Assign team', 'Complete', 'Clear selection']) {
      const action = bar.getByRole('button', { name, exact: true });
      const box = await action.boundingBox();
      expect(box, name).not.toBeNull();
      expect(box!.x, name).toBeGreaterThanOrEqual(bounds!.x);
      expect(box!.x + box!.width, name).toBeLessThanOrEqual(Math.min(width, bounds!.x + bounds!.width) + 1);
    }
    await bar.getByRole('button', { name: 'Snooze', exact: true }).click();
    const menu = page.getByRole('menu', { name: 'Snooze', exact: true });
    await expect(menu).toBeVisible();
    const menuBounds = (await menu.boundingBox())!;
    expect(menuBounds.x).toBeGreaterThanOrEqual(0);
    expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(width);
    expect(menuBounds.y + menuBounds.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await bar.getByRole('button', { name: 'Clear selection' }).click();
    await card.getByRole('button', { name: 'More', exact: true }).click();
    await expect(page.getByRole('menu', { name: 'More', exact: true })).toBeVisible();
    expect(detailReads()).toBe(0);
    await expect(page.getByRole('dialog').filter({ has: page.getByText('NEXT ACTION', { exact: true }) })).toHaveCount(0);
    if (width >= 768) {
      await page.keyboard.press('Escape');
      await card.getByRole('button', { name: 'Snooze', exact: true }).click();
      const snooze = page.getByRole('menu', { name: 'Snooze', exact: true });
      await expect(snooze).toBeVisible();
      const bounds = (await snooze.boundingBox())!;
      const label = (await snooze.getByText('Snooze till tomorrow', { exact: true }).boundingBox())!;
      expect(label.x + label.width).toBeLessThanOrEqual(bounds.x + bounds.width);
    }
    await expect(page.getByRole('menu')).toHaveCSS('opacity', '1');
    await page.screenshot({ path: info.outputPath('followup-actions.png') });
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 320, height: 740 });
    await card.getByRole('button', { name: 'More', exact: true }).click();
    await expect(page.getByRole('menu', { name: 'More', exact: true })).toBeVisible();
    // A narrowed/short viewport also represents the available CSS space after zoom.
    await page.setViewportSize({ width: 220, height: 280 });
    const resizedMenu = page.getByRole('menu');
    await expect.poll(async () => {
      const bounds = (await resizedMenu.boundingBox())!;
      return bounds ? bounds.x + bounds.width : Number.POSITIVE_INFINITY;
    }).toBeLessThanOrEqual(220);
    const lastItem = resizedMenu.getByRole('menuitem').last();
    await lastItem.scrollIntoViewIfNeeded();
    await expect(lastItem).toBeVisible();
    const resizedBounds = (await resizedMenu.boundingBox())!;
    expect(resizedBounds.y + resizedBounds.height).toBeLessThanOrEqual(280);
  });
}

for (const role of ['owner', 'sales']) test(`critical ${role} follow-up salesperson filter offers Mine only to staff`, async ({ page }) => {
  await followups(page, 'ground-floor', role);
  const mine = page.getByTestId('followups-salesperson-mine');
  if (role === 'owner') await expect(mine).toHaveCount(0);
  else await expect(mine).toBeVisible();
  await expect(page.getByTestId('followups-salesperson-sales-worker')).toBeVisible();
});
