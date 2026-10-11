import { expect, test } from "@playwright/test";

type Profile = {
  name: string;
  email: string | undefined;
  password: string | undefined;
  landingPath: string;
  allowed: string;
  denied: string;
};

const profiles: Profile[] = [
  { name: "Ground tiles quotations/follow-ups", email: process.env.E2E_GROUND_TILES_EMAIL, password: process.env.E2E_GROUND_TILES_PASSWORD, landingPath: "/tiles", allowed: "Tiles", denied: "Payments" },
  { name: "Ground payments/dispatches", email: process.env.E2E_GROUND_PAYMENTS_EMAIL, password: process.env.E2E_GROUND_PAYMENTS_PASSWORD, landingPath: "/payments", allowed: "Payments", denied: "Follow-ups" },
  { name: "Sanitary quotations/follow-ups", email: process.env.E2E_SANITARY_QUOTES_EMAIL, password: process.env.E2E_SANITARY_QUOTES_PASSWORD, landingPath: "/quotations", allowed: "Quotations", denied: "Purchases" },
  { name: "Sanitary purchases", email: process.env.E2E_SANITARY_PURCHASES_EMAIL, password: process.env.E2E_SANITARY_PURCHASES_PASSWORD, landingPath: "/purchases", allowed: "Purchases", denied: "Payments" },
];

// `page` is a worker fixture and would try to launch a browser before a
// callback-level `test.skip()` executes. Pick the skipped test declaration at
// definition time instead, so a developer/CI run with no E2E environment is
// safe and does not require Playwright browser binaries.
const configuredTest = (ready: boolean) => ready ? test : test.skip;

async function signIn(page: import("@playwright/test").Page, profile: Profile) {
  await page.goto("/login");
  await page.getByTestId("login-email").fill(profile.email!);
  await page.getByTestId("login-password").fill(profile.password!);
  await page.getByTestId("login-submit").click();
  await expect(page).toHaveURL(new RegExp(profile.landingPath.replace("/", "\\/")));
}

for (const profile of profiles) {
  configuredTest(Boolean(process.env.E2E_BASE_URL && profile.email && profile.password))(`${profile.name}: assigned workspace and denied modules`, async ({ page }) => {
    await signIn(page, profile);
    await expect(page.getByText(profile.allowed, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(profile.denied, { exact: true })).toHaveCount(0);
  });
}

configuredTest(Boolean(process.env.E2E_BASE_URL && process.env.E2E_GROUND_TILES_EMAIL && process.env.E2E_GROUND_TILES_PASSWORD && process.env.E2E_DELIVERY_CUSTOMER))("Ground tiles profile: delivery lookup is customer-specific and read-only", async ({ page }) => {
  await signIn(page, profiles[0]);
  await page.getByPlaceholder(/search customers/i).fill(process.env.E2E_DELIVERY_CUSTOMER!);
  await page.getByText(process.env.E2E_DELIVERY_CUSTOMER!, { exact: true }).first().click();
  await expect(page.getByText(/Pending|Ready|Partially Dispatched|Dispatched|Delivered/).first()).toBeVisible();
  await expect(page.getByText(/Create dispatch|Mark ready|Dispatch order/i)).toHaveCount(0);
});

configuredTest(Boolean(process.env.E2E_BASE_URL && process.env.E2E_TEMP_STAFF_EMAIL && process.env.E2E_TEMP_STAFF_PASSWORD))("owner-managed staff password reaches workspace without forced change", async ({ page }) => {
  await page.goto("/login");
  await page.getByTestId("login-email").fill(process.env.E2E_TEMP_STAFF_EMAIL!);
  await page.getByTestId("login-password").fill(process.env.E2E_TEMP_STAFF_PASSWORD!);
  await page.getByTestId("login-submit").click();
  await expect(page).not.toHaveURL(/login|set-new-password/);
  await expect(page.getByTestId("force-change-new")).toHaveCount(0);
  await page.goto("/settings-password");
  await expect(page.getByTestId("owner-managed-password")).toBeVisible();
});

configuredTest(Boolean(process.env.E2E_BASE_URL && profiles[0].email && profiles[0].password && profiles[3].email && profiles[3].password))("logout/login does not retain the preceding account floor", async ({ page }) => {
  const first = profiles[0];
  const second = profiles[3];
  await signIn(page, first);
  await page.getByLabel(/sign out|logout/i).click();
  await signIn(page, second);
  await expect(page).toHaveURL(/purchases/);
  await expect(page.getByText(/Ground Floor/i)).toHaveCount(0);
});
