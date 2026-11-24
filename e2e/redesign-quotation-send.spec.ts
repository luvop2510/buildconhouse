import { expect, test } from "@playwright/test";
import { mockSession } from "./audit-fixtures";
import { captureRuntimeHealth } from "./runtime-health";

for (const width of [390, 1440]) {
  test(`quotation downloads leave Draft intact until an explicit send at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 950 });
    const path = "/quotations/synthetic-send";
    await mockSession(page, path, false);
    const health = captureRuntimeHealth(page);
    let quotation: Record<string, unknown> = {
      id: "synthetic-send", customer_id: "synthetic-client", customer_name: "Fixture Customer",
      number: "FQ-2026-9012", floor_id: "first-floor", created_by_name: "Sales employee",
      status: "draft", created_at: "2026-11-18T09:00:00Z", updated_at: "2026-11-18T09:00:00Z",
      rooms: ["Master Bathroom"], subtotal: 1200, grand_total: 1080, discount_total: 120,
      items: [{ id: "item-one", sku: "TEST-SKU", name: "Basin Mixer", qty: 2, unit_price: 600, discount_pct: 10 }],
    };
    let sendRequests = 0;
    await page.route(/\/api\/quotations\/synthetic-send\?view=editor$/, route => route.fulfill({ json: quotation }));
    await page.route("**/api/quotations/synthetic-send/completion", route => route.fulfill({ json: { purchase_completion_status: "active" } }));
    await page.route("**/api/quotations/synthetic-send/breakdown", route => route.fulfill({ json: { lines: [] } }));
    await page.route("**/api/activity/quotation/synthetic-send", route => route.fulfill({ json: [] }));
    await page.route("**/api/purchase-orders?quotation_id=synthetic-send", route => route.fulfill({ json: [] }));
    await page.route("**/api/quotations/synthetic-send/pdf?*", route => route.fulfill({
      contentType: "application/pdf", body: "%PDF-1.4 fixture",
    }));
    await page.route("**/api/quotations/synthetic-send/xlsx", route => route.fulfill({
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", body: "PK-test-workbook",
    }));
    await page.route("**/api/quotations/synthetic-send/mark-sent", async route => {
      const input = route.request().postDataJSON();
      expect(input.followup_days).toBe(width === 390 ? 3 : 12);
      expect(input).not.toHaveProperty("followup_date");
      expect(input.expected_updated_at).toBe(quotation.updated_at);
      if (++sendRequests === 1) {
        await route.fulfill({ status: 503, json: { detail: "Try again in a moment." } });
        return;
      }
      quotation = { ...quotation, status: "sent", sent_at: "2026-11-18T10:00:00Z", sent_by_name: "Sales employee",
        first_followup_due_date: width === 390 ? "2026-11-21" : "2026-11-30",
        first_followup_interval_days: input.followup_days, updated_at: "2026-11-18T10:00:00Z" };
      await route.fulfill({ json: quotation });
    });

    await page.goto(path);
    const summary = page.getByTestId("quotation-detail-summary");
    await expect(summary.getByText("Draft", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Download PDF", exact: true }).click();
    const pdf = page.waitForEvent("download");
    await page.getByTestId("detail-pdf-exclude-dimensions").click();
    expect((await pdf).suggestedFilename()).toMatch(/\.pdf$/);
    const xlsx = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download Excel", exact: true }).click();
    expect((await xlsx).suggestedFilename()).toMatch(/\.xlsx$/);
    await expect(summary.getByText("Draft", { exact: true })).toBeVisible();
    expect(sendRequests).toBe(0);

    await page.getByTestId("mark-quotation-sent").click();
    const sheet = page.getByTestId("mark-quotation-sent-sheet");
    await expect(sheet.getByText("Send Quotation")).toBeVisible();
    for (const days of [3, 6, 7, 9]) await expect(sheet.getByRole("button", { name: `${days} days` })).toBeVisible();
    await sheet.getByRole("button", { name: "Cancel" }).click();
    await expect(summary.getByText("Draft", { exact: true })).toBeVisible();
    expect(sendRequests).toBe(0);
    await page.getByTestId("mark-quotation-sent").click();
    const confirm = page.getByTestId("confirm-mark-quotation-sent");
    const custom = page.getByTestId("quotation-followup-custom-days");
    if (width === 390) {
      await page.getByTestId("quotation-followup-3").click();
      await expect(custom).toHaveCount(0);
    } else {
      await page.getByTestId("quotation-followup-custom").click();
      await custom.fill("0");
      await expect(confirm).toBeDisabled();
      await custom.fill("12");
    }
    await confirm.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText("Try again in a moment.", { exact: true })).toBeVisible();
    if (width !== 390) await expect(custom).toHaveValue("12");
    await page.screenshot({ path: info.outputPath("mark-sent-error.png") });
    await confirm.click();
    await expect(summary.getByText("Pending", { exact: true })).toBeVisible();
    await expect(page.getByTestId("quotation-sent-at")).toContainText(
      width === 390 ? "First follow-up 21 Nov 2026 (3 days)" : "First follow-up 30 Nov 2026 (12 days)",
    );
    expect(sendRequests).toBe(2);
    await page.reload();
    await expect(summary.getByText("Pending", { exact: true })).toBeVisible();
    await expect(page.getByTestId("mark-quotation-sent")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath("pending-quotation.png") });
    await health.assertHealthy();
  });
}
