import { test, expect } from "@playwright/test";

test.describe("owner dashboard (signed in)", () => {
  test("dashboard shows today, revenue, upcoming and cancellations", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    for (const label of ["Today", "Upcoming"]) await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/Revenue · 30 days/i)).toBeVisible();
    await expect(page.getByText(/Cancellations · 30 days/i)).toBeVisible();
    await expect(page.getByRole("img", { name: /Daily revenue/ })).toBeVisible();
  });

  test("calendar has week and month views", async ({ page }) => {
    await page.goto("/admin/calendar");
    await expect(page.locator("[data-booking]").first()).toBeVisible();
    await page.getByRole("link", { name: "month", exact: true }).click();
    await expect(page).toHaveURL(/view=month/);
    await expect(page.getByText("Mon", { exact: true })).toBeVisible();
  });

  test("bookings can be searched and exported as CSV", async ({ page }) => {
    await page.goto("/admin/bookings?status=all");
    await expect(page.locator("[data-booking]").first()).toBeVisible();
    await page.fill('input[name="q"]', "no-such-person-xyz");
    await page.getByRole("button", { name: "Filter" }).click();
    await expect(page.getByText("No bookings match.")).toBeVisible();

    const res = await page.request.get("/api/admin/export/bookings?status=all");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/csv");
    const body = await res.text();
    expect(body).toContain("Booking ID");
    expect(body.split("\r\n").length).toBeGreaterThan(10);
  });

  test("customers list shows lifetime numbers and exports", async ({ page }) => {
    await page.goto("/admin/customers");
    await expect(page.getByRole("columnheader", { name: "Spent" })).toBeVisible();
    await expect(page.getByRole("row").nth(1)).toBeVisible();
    const res = await page.request.get("/api/admin/export/customers");
    expect(await res.text()).toContain("Total spent");
  });

  test("owner can cancel a booking from the list", async ({ page }) => {
    await page.goto("/admin/bookings?status=upcoming");
    const row = page.locator("[data-booking]").first();
    const id = await row.getAttribute("data-booking");
    await row.getByText("Cancel…").click();
    await row.getByRole("button", { name: "Cancel booking" }).click();
    await expect(page.getByText(/Booking cancelled/)).toBeVisible();
    await page.goto("/admin/bookings?status=cancelled");
    await expect(page.locator(`[data-booking="${id}"]`)).toBeVisible();
  });

  test("a service created by the owner appears on the public site", async ({ page }) => {
    await page.goto("/admin/services");
    const form = page.locator("section", { hasText: "Add a service" });
    await form.getByLabel("Name").fill("E2E Physio Session");
    await form.getByLabel("URL slug").fill("e2e-physio");
    await form.getByLabel("Duration (minutes)").fill("45");
    await form.getByLabel("Price", { exact: true }).fill("900");
    await form.getByRole("button", { name: "Create service" }).click();
    await expect(page.getByText("Service created.")).toBeVisible();

    await page.goto("/");
    await expect(page.getByRole("link", { name: /E2E Physio Session/ })).toBeVisible();
    await page.goto("/book/e2e-physio");
    await expect(page.getByRole("heading", { name: "E2E Physio Session" })).toBeVisible();
  });

  test("closing a date in Availability removes it from the public calendar", async ({ page }) => {
    await page.goto("/book/general-consultation");
    await page.waitForSelector("button[data-date]:not([disabled])");
    const date = (await page.locator("button[data-date]:not([disabled])").last().getAttribute("data-date"))!;

    await page.goto("/admin/availability");
    await page.fill("#ex-from", date);
    await page.fill("#ex-label", "E2E holiday");
    await page.getByRole("button", { name: "Add", exact: true }).first().click();
    await expect(page.getByText("E2E holiday").first()).toBeVisible();

    await page.goto("/book/general-consultation");
    await page.waitForSelector("button[data-date]");
    await expect(page.locator(`button[data-date="${date}"]`)).toBeDisabled();
  });

  test("settings page loads with integration status", async ({ page }) => {
    await page.goto("/admin/settings");
    await expect(page.getByText("Payments are OFF")).toBeVisible();
    await expect(page.getByText("Google Calendar (two-way)")).toBeVisible();
  });
});

test.describe("owner area is private", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("redirects anonymous visitors to the login page", async ({ page }) => {
    for (const path of ["/admin", "/admin/bookings", "/admin/settings", "/admin/calendar"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/admin\/login/);
    }
  });

  test("exports and Google connect refuse anonymous requests", async ({ request }) => {
    expect((await request.get("/api/admin/export/bookings")).status()).toBe(401);
    expect((await request.get("/api/admin/export/customers")).status()).toBe(401);
    expect((await request.get("/api/google/connect", { maxRedirects: 0 })).status()).toBe(401);
  });

  test("a forged session cookie is rejected", async ({ page, context }) => {
    await context.addCookies([{ name: "admin_session", value: `${Date.now() + 1e9}.abc.forged`, domain: "localhost", path: "/" }]);
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/admin\/login/);
  });

  test("a wrong password is refused with a message", async ({ page }) => {
    await page.goto("/admin/login");
    await page.fill("#password", "definitely-wrong");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Incorrect password.")).toBeVisible();
  });
});
