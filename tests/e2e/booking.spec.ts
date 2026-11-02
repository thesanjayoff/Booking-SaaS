import { test, expect, type Page } from "@playwright/test";

/** Pick the first/last enabled date and its first/last time slot. Returns the slot's ISO value. */
async function pickSlot(page: Page, which: "first" | "last" = "first") {
  await page.waitForSelector("button[data-date]:not([disabled])");
  const dates = page.locator("button[data-date]:not([disabled])");
  await (which === "first" ? dates.first() : dates.last()).click();
  const slots = page.locator("button[data-slot]");
  const slot = which === "first" ? slots.first() : slots.last();
  const iso = (await slot.getAttribute("data-slot"))!;
  await slot.click();
  return iso;
}

async function fillAndSubmit(page: Page, who: { name: string; email: string; phone?: string }) {
  await page.getByRole("button", { name: "Continue" }).click();
  await page.fill("#name", who.name);
  await page.fill("#email", who.email);
  if (who.phone) await page.fill("#phone", who.phone);
  await page.getByRole("button", { name: "Confirm booking" }).click();
}

test.describe("public booking flow", () => {
  test("service picker -> slot -> details -> confirmation, and the slot disappears", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Sunrise Family Clinic" })).toBeVisible();
    await page.getByRole("link", { name: /General Consultation/ }).click();
    await expect(page).toHaveURL(/\/book\/general-consultation/);

    const slot = await pickSlot(page, "first");
    await expect(page.getByTestId("selected-summary")).toBeVisible();
    await fillAndSubmit(page, { name: "E2E Person", email: "e2e.person@example.com", phone: "+91 98765 43210" });

    await expect(page.getByText("You're booked!")).toBeVisible();
    await expect(page.getByTestId("status")).toHaveText("Confirmed");
    await expect(page.getByTestId("when")).not.toBeEmpty();
    await expect(page.getByRole("link", { name: "Add to calendar" })).toBeVisible();

    // The slot is gone for the next visitor.
    await page.goto("/book/general-consultation");
    await page.waitForSelector("button[data-date]:not([disabled])");
    const date = new Date(slot).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    await page.locator(`button[data-date="${date}"]`).click();
    await expect(page.locator(`button[data-slot="${slot}"]`)).toHaveCount(0);
  });

  test("validation errors are shown inline and nothing is booked", async ({ page }) => {
    await page.goto("/book/general-consultation");
    await pickSlot(page, "last");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.fill("#name", "No Email");
    await page.fill("#email", "not-an-email");
    await page.getByRole("button", { name: "Confirm booking" }).click();
    await expect(page.getByText("Enter a valid email address")).toBeVisible();
    await expect(page).toHaveURL(/\/book\//);
  });

  test("the customer can reschedule and then cancel from the emailed link", async ({ page }) => {
    await page.goto("/book/paediatric-visit");
    await pickSlot(page, "last");
    await fillAndSubmit(page, { name: "Move Me", email: "move.me@example.com" });
    await expect(page.getByTestId("status")).toHaveText("Confirmed");
    const before = await page.getByTestId("when").innerText();

    await page.getByRole("link", { name: "Reschedule" }).click();
    await expect(page).toHaveURL(/reschedule/);
    await page.waitForSelector("button[data-date]:not([disabled])");
    await page.locator("button[data-date]:not([disabled])").first().click();
    await page.locator("button[data-slot]").first().click();
    await page.getByRole("button", { name: "Confirm new time" }).click();
    await expect(page.getByText("Your appointment was moved.")).toBeVisible();
    expect(await page.getByTestId("when").innerText()).not.toBe(before);

    await page.getByRole("button", { name: "Cancel appointment" }).click();
    await page.getByRole("button", { name: "Yes, cancel it" }).click();
    await expect(page.getByTestId("status")).toHaveText("Cancelled");
    await expect(page.getByRole("link", { name: "Book again" })).toBeVisible();
  });

  test("a manage link with a tampered token is a 404", async ({ page }) => {
    await page.goto("/book/general-consultation");
    await pickSlot(page, "last");
    await fillAndSubmit(page, { name: "Token Test", email: "token.test@example.com" });
    await expect(page.getByTestId("status")).toBeVisible();
    const url = new URL(page.url());
    url.searchParams.set("t", url.searchParams.get("t")!.slice(0, -2) + "xx");
    const res = await page.goto(url.toString());
    expect(res?.status()).toBe(404);
  });

  test("two visitors race for the same slot: exactly one wins, the other is told and returns to the picker", async ({ browser }) => {
    const mk = async () => {
      const ctx = await browser.newContext({ timezoneId: "Asia/Kolkata", locale: "en-US" });
      const page = await ctx.newPage();
      await page.goto("/book/video-consultation");
      await pickSlot(page, "last");
      await page.getByRole("button", { name: "Continue" }).click();
      return { ctx, page };
    };
    const [a, b] = [await mk(), await mk()];
    for (const [p, who] of [[a.page, "racer-a"], [b.page, "racer-b"]] as const) {
      await p.fill("#name", who);
      await p.fill("#email", `${who}@example.com`);
    }
    await Promise.all([a.page.getByRole("button", { name: "Confirm booking" }).click(), b.page.getByRole("button", { name: "Confirm booking" }).click()]);

    const outcome = async (p: Page) =>
      Promise.race([
        p.getByTestId("status").waitFor().then(() => "booked" as const),
        p.getByText(/not available|just taken/i).waitFor().then(() => "lost" as const),
      ]);
    const results = (await Promise.all([outcome(a.page), outcome(b.page)])).sort();
    expect(results).toEqual(["booked", "lost"]);
    const loser = (await outcome(a.page)) === "lost" ? a.page : b.page;
    await expect(loser.getByRole("button", { name: "Continue" })).toHaveCount(0); // sent back to the picker
    await a.ctx.close();
    await b.ctx.close();
  });

  test("times are shown in the visitor's time zone", async ({ page }) => {
    await page.goto("/book/general-consultation");
    await page.waitForSelector("button[data-date]:not([disabled])");
    await page.locator("button[data-date]:not([disabled])").first().click();
    const ist = await page.locator("button[data-slot]").first().innerText();
    await page.selectOption("#tz", "America/New_York");
    await page.locator("button[data-date]:not([disabled])").first().click();
    const ny = await page.locator("button[data-slot]").first().innerText();
    expect(ny).not.toBe(ist);
    await expect(page.getByText("Clinic time zone: Asia/Kolkata")).toBeVisible();
  });
});
