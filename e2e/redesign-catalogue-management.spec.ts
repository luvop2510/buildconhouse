import { expect, test, type Page } from "@playwright/test";

import { floors, mockSession } from "./audit-fixtures";

const root = "/settings-catalogue-management";
const brand = { id: "fixture-brand", name: "Fixture Brand" };
const category = { id: "fixture-category", name: "Fixture Category", brand_id: brand.id };
const templateMime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const allCapabilities = [
  "catalogue_view", "catalogue_products_add", "catalogue_products_edit", "catalogue_brands", "catalogue_categories",
  "catalogue_bulk", "catalogue_prices", "catalogue_images", "catalogue_history", "catalogue_rollback",
];
const dimensions = { part_bytes: 524288, max_bytes: 83886080 };

async function select(page: Page, testId: string, label: string) {
  await page.getByTestId(testId).click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
}

test("critical catalogue owner previews chunked price updates, confirms once and reverses from history", async ({ page }) => {
  await mockSession(page, "/settings", false, { floorId: "second-floor" });
  const source = Buffer.alloc(dimensions.part_bytes + 23, 17);
  const calls: string[] = [];
  const uploaded: Buffer[] = [];
  const job = {
    id: "fixture-import", filename: "brand-prices.xlsx", operation: "prices", status: "upload",
    brand_name: brand.name, created_by: "audit-owner", size_bytes: source.length,
  };
  let applying = 0;
  await page.route("**/api/catalog/management/**", async route => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace("/api/catalog/management", "");
    expect(req.headers()["x-floor-id"]).toBe("second-floor");
    const floor = url.searchParams.get("floor_id");
    calls.push(`${req.method()} ${path} ${floor}`);
    if (path === "/options") {
      return route.fulfill({ json: { capabilities: allCapabilities, brands: [brand], categories: [category], ...dimensions } });
    }
    expect(floor).toBe("first-floor");
    if (path === "/template.xlsx" || path === "/export.xlsx") {
      expect(url.searchParams.get("operation")).toBe("prices");
      if (path === "/export.xlsx") expect(url.searchParams.get("brand_id")).toBe(brand.id);
      return route.fulfill({ contentType: templateMime, body: "Workbook fixture" });
    }
    if (path === "/jobs" && req.method() === "POST") {
      expect(req.postDataJSON()).toMatchObject({ operation: "prices", brand_id: brand.id, filename: job.filename, size_bytes: source.length });
      expect(req.postDataJSON().key).toMatch(/^[a-f0-9-]{36}$/);
      return route.fulfill({ json: job });
    }
    if (/\/parts\/\d+$/.test(path)) {
      expect(req.method()).toBe("PUT");
      expect(Number(path.split("/").pop())).toBe(uploaded.length);
      uploaded.push(Buffer.from(req.postDataJSON().data_base64, "base64"));
      return route.fulfill({ json: { ok: true } });
    }
    if (path.endsWith("/preview")) {
      expect(Buffer.concat(uploaded)).toEqual(source);
      job.status = "queued";
      return route.fulfill({ json: job });
    }
    if (path.endsWith("/apply")) {
      expect(req.method()).toBe("POST");
      applying++;
      job.status = "applying";
      return route.fulfill({ json: job });
    }
    if (path.endsWith("/rollback")) {
      expect(req.method()).toBe("POST");
      job.status = "rolling_back";
      return route.fulfill({ json: job });
    }
    if (path === "/jobs") return route.fulfill({ json: [job] });
    if (path.endsWith("/errors.xlsx")) return route.fulfill({ contentType: templateMime, body: "Error workbook fixture" });
    if (path === "/jobs/fixture-import") {
      if (job.status === "queued") job.status = "preview";
      if (job.status === "applying") job.status = "complete";
      if (job.status === "rolling_back") job.status = "rolled_back";
      return route.fulfill({ json: {
        ...job, summary: { price: 1, rejected: 1 }, result: job.status === "complete" ? { price: 1, applied: 1, rejected: 1 } : undefined,
        rollback_result: job.status === "rolled_back" ? { restored: 1, conflict: 0 } : undefined,
        rows: [
          { row: 2, sheet: "Prices", sku: "0012", action: "price", previous_mrp: 150, delta: { mrp: 175 } },
          { row: 3, sheet: "Prices", sku: "bad", action: "rejected", errors: ["Price changed since export."] },
        ],
      } });
    }
    return route.fulfill({ status: 404, json: { detail: "Unexpected fixture route" } });
  });

  await page.goto("/settings");
  await page.getByTestId("settings-nav-catalogue-management").click();
  await expect(page.getByText("Kitchen Floor", { exact: true }).first()).toBeVisible();
  await select(page, "catalogue-department", "Sanitary / Bathroom Floor");
  await select(page, "catalogue-operation", "Update prices only");
  await select(page, "catalogue-workbook-brand", brand.name);

  const template = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download Excel template" }).click();
  expect((await template).suggestedFilename()).toMatch(/\.xlsx$/);
  const exported = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export brand price workbook" }).click();
  expect((await exported).suggestedFilename()).toMatch(/\.xlsx$/);

  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Choose workbook" }).click();
  await (await chooser).setFiles({ name: job.filename, mimeType: templateMime, buffer: source });
  await page.getByRole("button", { name: "Upload and preview" }).click();
  await expect(page.getByText("Preview changes", { exact: true })).toBeVisible();
  await expect(page.getByText(/₹150\.00.*₹175\.00/)).toBeVisible();
  await expect(page.getByText("Price changed since export.")).toBeVisible();
  expect(applying).toBe(0);
  expect(uploaded.map(buffer => buffer.length)).toEqual([dimensions.part_bytes, 23]);

  await page.getByRole("button", { name: "Confirm import" }).click();
  await page.getByTestId("catalogue-confirm-confirm").click();
  await expect(page.getByText("Import complete", { exact: true })).toBeVisible();
  expect(applying).toBe(1);
  const errors = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download error report" }).click();
  expect((await errors).suggestedFilename()).toMatch(/\.xlsx$/);
  await page.getByRole("button", { name: "View import history" }).click();
  await page.getByRole("button", { name: "Open brand-prices.xlsx" }).click();
  await page.getByRole("button", { name: "Reverse import", exact: true }).click();
  await page.getByTestId("catalogue-confirm-confirm").click();
  await expect(page.getByTestId("catalogue-active-import").getByText("Import reversed", { exact: true })).toBeVisible();
  expect(calls.filter(call => call.startsWith("POST /jobs "))).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test("critical catalogue employee sees only granted department and product creation actions", async ({ page }) => {
  const accessGrants = [
    { floor_id: "first-floor", resource: "catalogue_view", actions: ["view"] },
    { floor_id: "first-floor", resource: "catalogue_products_add", actions: ["view", "create"] },
  ];
  await mockSession(page, "/settings", false, {
    floorId: "first-floor",
    grants: accessGrants,
    staff: { id: "catalogue-employee", email: "catalogue@example.test", full_name: "Catalogue Employee",
      role: "sales", active: true, custom_access: true, floor_ids: ["first-floor", "ground-floor"], access_grants: accessGrants },
    floorAccess: { all_floors: false, floors: floors.filter(floor => ["first-floor", "ground-floor"].includes(floor.id)),
      floor_ids: ["first-floor", "ground-floor"] },
  });
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let creates = 0;
  await page.route("**/api/catalog/management/**", async route => {
    const req = route.request();
    const url = new URL(req.url());
    expect(url.searchParams.get("floor_id")).toBe("first-floor");
    if (url.pathname.endsWith("/options")) return route.fulfill({ json: {
      capabilities: ["catalogue_view", "catalogue_products_add"], brands: [brand], categories: [category], ...dimensions,
    } });
    if (url.pathname.endsWith("/products")) {
      if (req.method() === "GET") return route.fulfill({ json: { total: 1, next_skip: null, items: [{
        id: "created-basin", sku: "000123", name: "Saved basin", mrp: 1200, price: 1200,
        brand_id: brand.id, category_id: category.id,
      }] } });
      creates++;
      expect(req.postDataJSON()).toMatchObject({ sku: "000123", name: "Saved basin", mrp: 1200, brand_id: brand.id, category_id: category.id });
      await pending;
      return route.fulfill({ json: { id: "created-basin" } });
    }
    return route.fulfill({ status: 403, json: { detail: "Not granted." } });
  });
  await page.goto(root);
  await expect(page.getByRole("button", { name: "Add single product" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add brand", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("catalogue-operation")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Choose workbook" })).toHaveCount(0);
  await expect(page.getByTestId("catalogue-history")).toHaveCount(0);
  await page.getByTestId("catalogue-department").click();
  await expect(page.getByRole("menuitem", { name: "Ground Floor — Tiles" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Sanitary / Bathroom Floor" }).click();

  await page.getByRole("button", { name: "Add single product" }).click();
  await select(page, "catalogue-manual-brand", brand.name);
  await select(page, "catalogue-manual-category", category.name);
  await page.getByLabel("Article number").fill("000123");
  await page.getByLabel("Product name").fill("Saved basin");
  await page.getByLabel("MRP", { exact: true }).fill("1200");
  try {
    await page.getByTestId("catalogue-manual-save").click();
    await expect.poll(() => creates).toBe(1);
    await expect(page.getByText("Product saved to the catalogue.")).toHaveCount(0);
  } finally {
    release();
  }
  await expect(page.getByText("Product saved to the catalogue.")).toBeVisible();
  await page.getByRole("button", { name: "Browse products" }).click();
  await page.getByLabel("Find by article or name").fill("000123");
  await expect(page.getByText("Saved basin", { exact: true })).toBeVisible();
});
