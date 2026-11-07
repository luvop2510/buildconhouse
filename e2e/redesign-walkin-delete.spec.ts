import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

for (const floor of ['first-floor', 'ground-floor', 'second-floor', 'third-floor']) {
  test(`critical walk-in deletion respects ${floor} scope`, async ({ page }) => {
    await mockSession(page, '/walkins', false, { floorId: floor });
    const row = { id:'walkin-one', number:'WI-TEST', customer_id:'customer', customer_name:'Test visitor', customer_phone:'9000000000',
      floor_id:floor, salesperson_id:'audit-owner', salesperson_name:'Audit Owner', source:'Walk-in', status:'new', interested_products:[],
      visited_at:'2026-10-11T10:00:00Z', created_at:'2026-10-11T10:00:00Z', updated_at:'2026-10-11T10:00:00Z' };
    await page.route('**/api/walkins/config/sources', route => route.fulfill({ json: { sources: ['Walk-in'] } }));
    await page.route('**/api/walkins/dashboard**', route => route.fulfill({ json: { total:1, today_walkins:1, this_week:1, pending_followups:0, selections_scheduled:0, converted:0, lost:0, conversion_rate:0, avg_conversion_days:0 } }));
    await page.route(/\/api\/walkins\/page(?:\?.*)?$/, route => route.fulfill({ json:{items:[row],next_cursor:null} }));
    let deletes = 0;
    await page.route('**/api/walkins/walkin-one', route => {
      expect(route.request().method()).toBe('DELETE');
      expect(route.request().headers()['x-floor-id']).toBe(floor);
      deletes++;
      return route.fulfill({ json:{ok:true} });
    });
    await page.goto('/walkins');
    const button = page.getByTestId('walkin-delete-walkin-one');
    if (['first-floor','ground-floor'].includes(floor)) {
      await expect(page.getByTestId('walkin-card-walkin-one')).toBeVisible();
      await button.click();
      await expect(page.getByTestId('walkin-card-walkin-one')).toHaveCount(0);
      expect(deletes).toBe(1);
      await expect(page).toHaveURL(/\/walkins$/);
    } else {
      if (floor === 'second-floor') await expect(page.getByRole('heading', { name:'Kitchen dashboard' })).toBeVisible();
      else await expect(page.getByTestId('walkin-card-walkin-one')).toBeVisible();
      await expect(button).toHaveCount(0);
      expect(deletes).toBe(0);
    }
  });
}
