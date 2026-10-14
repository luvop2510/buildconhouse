import { expect, test, type Page } from '@playwright/test';
import { mockSession } from './audit-fixtures';
import { captureRuntimeHealth } from './runtime-health';

const stock = (index: number) => ({ id: `stable-stock-${index}`, product_id: `product-${index}`,
  sku: `STABLE-${index}`, name: `Warehouse fitting ${index}`, brand_name: 'Duravit',
  qty_received: index === 0 ? 0 : 2, available_qty: index === 0 ? 0 : 2,
  transferable_qty: index === 0 ? 0 : 2, quantity_missing: index === 0,
  unit_price: index % 2 ? 2500 : null, stock_value: index % 2 ? 5000 : null,
  image: null, price_variants: [], allocations: [], customer_transfers: [] });

async function fixtures(page: Page) {
  await mockSession(page, '/quotations', false, { seedStorageOnce: true });
  await page.route('**/api/categories**', route => route.fulfill({ json: [] }));
  await page.route('**/api/brands**', route => route.fulfill({ json: [] }));
  await page.route('**/api/products/families?**', route => route.fulfill({ json: { total: 0, items: [] } }));
  await page.route('**/api/quotations?**', route => route.fulfill({ json: [] }));
  await page.route('**/api/quotations/recent?**', route => route.fulfill({ json: [] }));
  await page.route('**/api/godown-stock?**', route => route.fulfill({ json: {
    lots: Array.from({ length: 1015 }, (_, index) => stock(index)), brands: [],
    total_available_qty: 2028, total_stock_value: 2535000, unpriced_lot_count: 508,
  } }));
}

async function navigate(page: Page, label: string) {
  if (page.viewportSize()!.width < 768 && !(await page.getByRole('link', { name: label, exact: true }).isVisible())) {
    await page.getByRole('button', { name: 'More', exact: true }).click();
  }
  await page.getByRole('link', { name: label, exact: true }).click();
}

test('critical opening new quotation and full warehouse repeatedly keeps navigation and session healthy', async ({ page }) => {
  const health = captureRuntimeHealth(page);
  await fixtures(page);
  await page.goto('/quotations');
  for (let pass = 0; pass < 2; pass++) {
    await page.getByTestId('new-quotation-btn').click();
    await expect(page.getByTestId('quotation-workspace')).toBeVisible();
    await health.assertHealthy();
    await page.goBack();
    await expect(page.getByTestId('new-quotation-btn')).toBeVisible();
    await navigate(page, 'Godown stock');
    await expect(page.getByTestId('godown-lot-stable-stock-0')).toContainText('Quantity not recorded');
    await expect(page.getByTestId('godown-lot-stable-stock-60')).toHaveCount(0);
    await page.getByRole('textbox', { name: 'Search godown stock', exact: true }).fill('STABLE-1014');
    await expect(page.getByTestId('godown-lot-stable-stock-1014')).toBeVisible();
    await health.assertHealthy();
    await navigate(page, 'Customers');
    await expect(page.getByText('No customers yet', { exact: true })).toBeVisible();
    await navigate(page, 'Quotations');
    await expect(page.getByTestId('new-quotation-btn')).toBeVisible();
  }
  await page.reload();
  await expect(page.getByTestId('new-quotation-btn')).toBeVisible();
  await expect(page.getByTestId('login-submit')).toHaveCount(0);
  await health.assertHealthy();
});

// An API mock deliberately violates the React child contract. This executes a
// real render failure, proving that the error cannot destroy authentication or
// the surrounding navigator; merely checking a fallback component is weaker.
for (const recovery of ['retry', 'navigate'] as const) {
  test(`critical page render failure preserves the shell and signed-in ${recovery} recovery`, async ({ page }) => {
    const health = captureRuntimeHealth(page, { expectedErrors: [/Objects are not valid as a React child|Minified React error #31|The above error occurred|An error occurred in the .* component/i] });
    await fixtures(page);
    let fail = true;
    await page.route('**/api/godown-stock?**', route => route.fulfill({ json: {
      lots: [{ ...stock(1), name: fail ? { invalid_render_fixture: true } : 'Recovered warehouse fitting' }],
      brands: [], total_available_qty: 2, total_stock_value: 5000, unpriced_lot_count: 0,
    } }));
    await page.goto('/godown-stock');
    await expect(page.getByTestId('route-error-boundary')).toContainText("This page couldn't open");
    await expect(page.getByTestId(page.viewportSize()!.width < 768 ? 'bottom-nav-more' : 'nav-customers')).toBeVisible();
    await expect(page.getByTestId('login-submit')).toHaveCount(0);
    fail = false;
    if (recovery === 'retry') {
      await page.getByRole('button', { name: 'Try opening this page again', exact: true }).click();
      await expect(page.getByTestId('godown-lot-stable-stock-1')).toContainText('Recovered warehouse fitting');
    } else {
      await navigate(page, 'Customers');
      await expect(page.getByText('No customers yet', { exact: true })).toBeVisible();
      await navigate(page, 'Godown stock');
      await expect(page.getByTestId('godown-lot-stable-stock-1')).toContainText('Recovered warehouse fitting');
    }
    await expect(page.getByTestId('login-submit')).toHaveCount(0);
    await health.assertHealthy();
  });
}

test('critical a failed quotation module offers reload and retains the signed-in destination', async ({ page }) => {
  const health = captureRuntimeHealth(page, { expectedErrors: [/Loading module .* failed|AsyncRequireError|The above error occurred|An error occurred in the .* component/i, /^Asset request failed: \/_expo\/static\/js\/web\/QuotationBuilder-.* 404$/] });
  await fixtures(page);
  let block = true;
  let failures = 0;
  await page.route('**/QuotationBuilder-*.js', route => {
    if (!block) return route.continue();
    failures++;
    return route.fulfill({ status: 404, contentType: 'application/javascript', body: '' });
  });
  await page.goto('/quotations');
  await page.getByTestId('new-quotation-btn').click();
  await expect(page.getByTestId('route-error-boundary')).toContainText('An app update is available.');
  expect(failures).toBeGreaterThan(0);
  await expect(page.getByTestId('login-submit')).toHaveCount(0);
  // Phone quotation editing deliberately hides the general navigation bar.
  await expect(page.getByRole('button', { name: 'Open workspace home', exact: true })).toBeVisible();
  block = false;
  await page.getByRole('button', { name: 'Reload app', exact: true }).click();
  await expect(page.getByTestId('quotation-workspace')).toBeVisible();
  await expect(page).toHaveURL(/\/quotations\/new/);
  await expect(page.getByTestId('login-submit')).toHaveCount(0);
  await health.assertHealthy();
});
