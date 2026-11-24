import { expect, test } from "@playwright/test";

import { mockSession } from "./audit-fixtures";

const document = {
  id: "synthetic-recovery", customer_id: "fixture-customer", customer_name: "Fixture Customer",
  number: "FQ-RECOVERY", floor_id: "first-floor", created_by_name: "Sales employee",
  status: "draft", created_at: "2026-11-18T09:00:00Z", updated_at: "2026-11-18T09:00:00Z",
  rooms: ["Master Bathroom"], subtotal: 1200, grand_total: 1080, discount_total: 120,
  items: [{ id: "item-one", product_id: "product-one", sku: "TEST-SKU", name: "Saved basin",
    room: "Master Bathroom", qty: 2, unit_price: 600, discount_pct: null, net_amount: 1080 }],
};

test("critical quotation retries a gateway failure and displays saved lines before related reads finish", async ({ page }) => {
  const path = "/quotations/synthetic-recovery";
  await mockSession(page, path, false);
  let attempts = 0;
  let releaseBreakdown!: () => void;
  const breakdown = new Promise<void>(resolve => { releaseBreakdown = resolve; });
  await page.route("**/api/quotations/synthetic-recovery?view=editor", route => {
    if (++attempts === 1) {
      return route.fulfill({
        status: 502,
        headers: { "x-request-id": "gateway-fixture" },
        json: { status: 502, message: "Application failed to respond" },
      });
    }
    return route.fulfill({ json: document });
  });
  await page.route("**/api/quotations/synthetic-recovery/breakdown", async route => {
    await breakdown;
    await route.fulfill({ status: 503, json: { detail: "Unavailable" } });
  });
  await page.route("**/api/quotations/synthetic-recovery/completion", route => route.fulfill({ json: { purchase_completion_status: "active" } }));
  await page.route("**/api/activity/quotation/synthetic-recovery", route => route.fulfill({ json: [] }));
  await page.route("**/api/purchase-orders?quotation_id=synthetic-recovery", route => route.fulfill({ json: [] }));

  await page.goto(path);
  await expect(page.getByText("Unable to load quotation")).toBeVisible();
  await expect(page.getByText(/Support reference gateway-fixture/)).toBeVisible();
  await expect(page.getByText(/Application failed to respond/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Return to Quotations" })).toBeVisible();

  try {
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByText("FQ-RECOVERY")).toBeVisible();
    await expect(page.getByText("Saved basin")).toBeVisible();
    await expect(page.getByText("Loading discount breakdown…")).toBeVisible();
    await expect(page.getByText("10%", { exact: true })).toBeVisible();
  } finally {
    releaseBreakdown();
  }
  await expect(page.getByText("Some related records are unavailable")).toBeVisible();
  await expect(page.getByText("Saved basin")).toBeVisible();
  expect(attempts).toBe(2);
});
