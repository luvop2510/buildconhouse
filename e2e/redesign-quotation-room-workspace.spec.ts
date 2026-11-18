import { expect, test, type Page } from "@playwright/test";

import { mockSession } from "./audit-fixtures";

type SavedLine = {
  id: string; product_id: string; sku: string; name: string; room: string; qty: number; unit_price: number;
  finish: string | null; discount_pct: number | null;
};

const roomNames = ["Master Bathroom", "Guest Bathroom", "Second Bathroom", "Third Bathroom"];
const line = (id: string, room: number, qty: number, price: number): SavedLine => ({
  id, product_id: `product-${id}`, sku: id.toUpperCase(), name: `Fitting ${id}`, room: roomNames[room],
  qty, unit_price: price, finish: "Chrome", discount_pct: null,
});

async function openReview(page: Page) {
  const exit = page.getByTestId("expand-quotation-workspace");
  if (await exit.isVisible()) await exit.click();
  const tab = page.getByRole("tab", { name: /Quotation ·/ });
  if (await tab.isVisible()) await tab.click();
  await expect(page.getByTestId("receipt-list")).toBeVisible();
}

async function fixture(page: Page, failFirstRead = false) {
  await mockSession(page, "/quotations/new", false);
  const document = {
    id: "room-workspace", number: "FQ-2026-0249", status: "sent", floor_id: "first-floor",
    customer_id: "customer", customer_name: "Showroom test customer",
    items: [line("basin", 0, 1, 100), line("shower", 0, 2, 300), line("guest", 1, 4, 50), line("third", 3, 3, 80)],
    rooms: roomNames, collapsed_rooms: ["Third Bathroom"],
    updated_at: "2026-11-14T08:00:00.000+00:00",
  };
  let posts = 0;
  let interrupted = false;
  let roomWrites = 0;
  let patchVersion = 0;
  await page.route("**/api/categories**", route => route.fulfill({ json: [] }));
  await page.route("**/api/brands**", route => route.fulfill({ json: [] }));
  await page.route("**/api/products/**", route => route.fulfill({ json: { items: [], total: 0 } }));
  await page.route("**/api/customers**", route => route.fulfill({ json: [{ id: "customer", name: document.customer_name }] }));
  await page.route("**/api/quotations/recent?**", route => route.fulfill({ json: [] }));
  await page.route("**/api/quotations", route => {
    if (route.request().method() === "POST") posts++;
    return route.fulfill({ status: 503, json: { detail: "An edit should never create a new quotation." } });
  });
  await page.route(/\/api\/quotations\/room-workspace(?:\?.*)?$/, async route => {
    if (route.request().method() === "GET") {
      if (failFirstRead) {
        failFirstRead = false;
        return route.fulfill({ status: 503, json: { detail: "The saved quotation is temporarily unavailable." } });
      }
      return route.fulfill({ json: document });
    }
    const payload = route.request().postDataJSON();
    if (payload.expected_updated_at !== document.updated_at) {
      return route.fulfill({ status: 409, json: { detail: "This quotation changed elsewhere." } });
    }
    const isQuantityChange = payload.items[0].qty !== document.items[0].qty;
    const updated_at = new Date(Date.UTC(2026, 10, 14, 8, 0, ++patchVersion)).toISOString();
    Object.assign(document, payload, { updated_at });
    if (isQuantityChange) {
      roomWrites++;
      if (!interrupted) {
        interrupted = true;
        return route.fulfill({ status: 504, json: { detail: "Save acknowledgement was interrupted." } });
      }
    }
    return route.fulfill({ json: document });
  });
  await page.goto("/quotations/new?quotationId=room-workspace");
  return { document, roomWrites: () => roomWrites, postCount: () => posts };
}

test("critical quotation deletion waits for an interrupted same-record autosave", async ({ page }) => {
  await fixture(page);
  await expect(page.getByTestId("room-header-Master Bathroom")).toBeAttached();
  await openReview(page);
  const requests: string[] = [];
  let releaseSave = () => {};
  let deleted = false;
  await page.route(/\/api\/quotations\/room-workspace(?:\?.*)?$/, async route => {
    if (route.request().method() === "PATCH") {
      requests.push("save started");
      await new Promise<void>(resolve => { releaseSave = resolve; });
      requests.push("save interrupted");
      return route.abort("failed");
    }
    if (route.request().method() === "DELETE") {
      requests.push("delete");
      deleted = true;
      return route.fulfill({ json: { ok: true } });
    }
    if (deleted) return route.fulfill({ status: 404, json: { detail: "Quotation not found" } });
    return route.fallback();
  });
  const quantity = page.getByTestId("qty-basin");
  await quantity.fill("5");
  await quantity.press("Tab");
  await expect.poll(() => requests).toEqual(["save started"]);

  const deleteButton = page.getByTestId("builder-delete-quotation");
  if (await deleteButton.isVisible()) await deleteButton.click();
  else {
    await page.getByTestId("builder-actions").click();
    await page.getByRole("button", { name: "Delete quotation", exact: true }).click();
  }
  const confirmation = page.getByTestId("confirm-delete-active-builder-quotation-confirm");
  await confirmation.click();
  await expect(confirmation).toBeDisabled();
  expect(requests).toEqual(["save started"]);
  releaseSave();
  await expect.poll(() => requests).toEqual(["save started", "save interrupted", "delete"]);
  await expect(confirmation).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Quotation not found", { exact: true })).toBeVisible();
});

test("critical quotation opens an individual bathroom, previews additive changes and recovers a lost save acknowledgement", async ({ page }, testInfo) => {
  const fixtureData = await fixture(page);
  await expect(page.getByTestId("room-header-Master Bathroom")).toBeAttached();
  await openReview(page);

  await page.getByTestId("choose-quotation-room").click();
  await page.getByTestId("choose-room-Third Bathroom").click();
  await expect(page.getByTestId("qty-third")).toHaveValue("3");
  await expect(page.getByTestId("qty-basin")).toHaveCount(0);
  await expect(page.getByTestId("qty-guest")).toHaveCount(0);

  await page.getByTestId("room-Guest Bathroom").click();
  await expect(page.getByTestId("qty-guest")).toHaveValue("4");
  await expect(page.getByTestId("qty-third")).toHaveCount(0);

  await page.getByTestId("room-Master Bathroom").click();
  await page.getByTestId("bulk-room-quantity").click();
  let sheet = page.getByTestId("room-products-increase-sheet");
  await expect(sheet.getByText("1 → 2")).toBeVisible();
  await expect(sheet.getByText("2 → 3")).toBeVisible();
  await sheet.getByTestId("custom-quantity-increase").fill("0");
  await expect(sheet.getByTestId("confirm-room-products")).toBeDisabled();
  await sheet.getByTestId("quantity-increase-1").click();
  await sheet.getByTestId("confirm-room-products").click();
  await expect(sheet.getByText("Save acknowledgement was interrupted.")).toBeVisible();
  await expect(sheet.getByText("1 → 2")).toBeVisible();
  await sheet.getByTestId("confirm-room-products").click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId("qty-basin")).toHaveValue("2");
  expect(fixtureData.roomWrites()).toBe(1);

  await page.getByTestId("bulk-room-quantity").click();
  sheet = page.getByTestId("room-products-increase-sheet");
  await sheet.getByTestId("quantity-increase-3").click();
  await expect(sheet.getByText("2 → 5")).toBeVisible();
  await expect(sheet.getByText("3 → 6")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("quantity-preview.png") });
  await sheet.getByTestId("confirm-room-products").click();
  await expect(sheet).toHaveCount(0);
  expect(fixtureData.document.items.map(({ qty }) => qty)).toEqual([5, 6, 4, 3]);
  expect(fixtureData.document.items.reduce((sum, { qty, unit_price }) => sum + qty * unit_price, 0)).toBe(2740);
  expect(fixtureData.document.items.every(item => item.finish === "Chrome")).toBe(true);
  expect(fixtureData.postCount()).toBe(0);

  await page.reload();
  await expect(page.getByTestId("room-header-Master Bathroom")).toBeAttached();
  await openReview(page);
  await expect(page.getByTestId("qty-basin")).toHaveValue("5");
  await expect(page.getByTestId("builder-quotation-status").filter({ visible: true })).toHaveText("Pending");
  await page.getByTestId("copy-room-products").click();
  const copy = page.getByTestId("room-products-copy-sheet");
  await expect(copy.getByTestId("copy-products-to-Guest Bathroom")).toHaveCount(0);
  await copy.getByTestId("copy-products-to-Second Bathroom").click();
  await copy.getByTestId("confirm-room-products").click();
  await expect(copy).toHaveCount(0);
  await page.getByTestId("room-Second Bathroom").click();
  await expect(page.getByText("Fitting basin", { exact: true })).toBeVisible();
  expect(fixtureData.document.items.filter(item => item.room === "Second Bathroom").map(item => [item.qty, item.unit_price, item.finish])).toEqual([[5, 100, "Chrome"], [6, 300, "Chrome"]]);
  expect(fixtureData.document.number).toBe("FQ-2026-0249");
});

test("critical quotation does not open a blank draft when an existing quote fails to load", async ({ page }) => {
  const fixtureData = await fixture(page, true);
  await expect(page.getByText("The saved quotation is temporarily unavailable.")).toBeVisible();
  await expect(page.getByTestId("quotation-workspace")).toHaveCount(0);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("room-header-Master Bathroom")).toBeAttached();
  await openReview(page);
  await page.getByTestId("qty-basin").fill("2");
  await page.getByTestId("qty-basin").press("Tab");
  await expect.poll(() => fixtureData.document.items[0].qty).toBe(2);
  expect(fixtureData.document.number).toBe("FQ-2026-0249");
  expect(fixtureData.postCount()).toBe(0);
});
