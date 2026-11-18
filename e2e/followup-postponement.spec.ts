import { expect, test } from "@playwright/test";
import { mockSession } from "./audit-fixtures";

for (const width of [390, 1440]) {
  test(`postponing a follow-up preserves the input on failed save at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 870 });
    await mockSession(page, "/followups", false);
    const overdueAt = new Date(Date.now() - 86400000).toISOString();
    let row = {
      id: "postpone-client", customer_id: "client", customer_name: "QA Postponement Customer",
      floor_id: "first-floor", rule_type: "quotation_followup", category: "quotation", customer_tier: "retail",
      reason: "Check whether the customer reviewed the quotation", reason_factors: [], tags: [],
      value: 0, next_action: "Call customer", suggested_channel: "call", priority_score: 50,
      priority_level: "medium", status: "open", bucket: "overdue", due_at: overdueAt, contact_attempts: 0,
      postponement_history: [] as { previous_due_at: string; new_due_at: string; reason: string; actor_name: string; changed_at: string }[],
    };
    await page.route("**/api/followups/config/assignees", route => route.fulfill({ json: [] }));
    await page.route("**/api/followups/saved-views", route => route.fulfill({ json: [] }));
    await page.route("**/api/followups/page?**", route => route.fulfill({ json: { items: [row], page: 1, page_size: 100, has_more: false } }));
    await page.route("**/api/followups/postpone-client", route => route.fulfill({
      json: { followup: row, customer: { id: "client", name: row.customer_name, tier: "retail" },
        quotations: [], purchases: [], payments: [], timeline: [], stats: { risk_level: "low", pending_quotations: 0 } },
    }));

    const writes: { expected_due_at: string; new_due_date: string; reason: string }[] = [];
    await page.route("**/api/followups/postpone-client/postpone", route => {
      const body = route.request().postDataJSON();
      writes.push(body);
      if (writes.length === 1) return route.fulfill({ status: 503, json: { detail: "Save interrupted. Try again." } });
      const newDueAt = new Date(body.new_due_date + "T00:00:00+05:30").toISOString();
      row = {
        ...row, bucket: "this_week", due_at: newDueAt,
        postponement_history: [...row.postponement_history, {
          previous_due_at: body.expected_due_at, new_due_at: newDueAt,
          reason: body.reason, actor_name: "QA Employee", changed_at: new Date().toISOString(),
        }],
      };
      return route.fulfill({ json: row });
    });

    await page.goto("/followups");
    const card = page.getByTestId("followup-postpone-client");
    const open = async () => {
      if (width < 768) {
        await card.getByRole("button", { name: "More", exact: true }).click();
        await page.getByText("Postpone follow-up", { exact: true }).click();
      } else {
        await card.getByTestId("postpone-postpone-client").click();
      }
    };
    await open();
    const dialog = page.getByRole("dialog", { name: "Postpone follow-up", exact: true });
    const confirm = dialog.getByTestId("confirm-postponement");
    const reason = dialog.getByRole("textbox", { name: "Reason for postponement", exact: true });
    const date = dialog.getByLabel("New follow-up date");
    expect(await dialog.getByText("Current follow-up date").count()).toBe(1);
    await expect(confirm).toBeDisabled();
    await dialog.getByTestId("postpone-days-1").focus();
    await page.keyboard.press("Enter");
    await expect(date).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
    await reason.fill("  ");
    await expect(confirm).toBeDisabled();

    const inputBounds = (await date.boundingBox())!;
    expect(inputBounds.x).toBeGreaterThanOrEqual(0);
    expect(inputBounds.x + inputBounds.width).toBeLessThanOrEqual(width);
    await dialog.getByTestId("postpone-days-3").click();
    const chosenDate = await date.inputValue();
    await reason.fill("Customer requested three more days");
    await confirm.click();
    await expect(dialog.getByText("Save interrupted. Try again.")).toBeVisible();
    await expect(date).toHaveValue(chosenDate);
    await expect(reason).toHaveValue("Customer requested three more days");
    await expect(card.getByText(/Overdue ·/)).toHaveCount(1);
    await confirm.click();
    await expect(dialog).toHaveCount(0);
    await expect(card.getByText(/Pending ·/)).toBeVisible();
    expect(writes).toEqual(Array(2).fill({
      expected_due_at: overdueAt, new_due_date: chosenDate, reason: "Customer requested three more days",
    }));

    await page.reload();
    await expect(card.getByText(/Pending ·/)).toBeVisible();
    await card.getByText(row.customer_name).click();
    await expect(page.getByText("Postponement history", { exact: true })).toBeVisible();
    await expect(page.getByText("Customer requested three more days", { exact: true })).toBeVisible();
  });
}
