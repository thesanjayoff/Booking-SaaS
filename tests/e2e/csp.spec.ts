import { test, expect, type Page } from "@playwright/test";

/** Collects every CSP violation the browser reports (event + console), for the life of the page. */
async function trackViolations(page: Page) {
  const fromConsole: string[] = [];
  page.on("console", (m) => {
    if (/content security policy|violates the following/i.test(m.text())) fromConsole.push(m.text().slice(0, 200));
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => w.__csp.push(`${e.violatedDirective} <- ${e.blockedURI || "inline"}`));
  });
  return async () => [...(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)), ...fromConsole];
}

test.describe("strict CSP (nonce, no unsafe-inline scripts)", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("every response carries a fresh nonce, and the page's scripts carry the same one", async ({ request }) => {
    const nonces: string[] = [];
    for (const path of ["/", "/book/general-consultation", "/", "/admin/login"]) {
      const res = await request.get(path);
      const csp = res.headers()["content-security-policy"];
      const script = csp.split("; ").find((d) => d.startsWith("script-src "))!;
      expect(script, path).not.toContain("'unsafe-inline'");
      const nonce = /'nonce-([^']+)'/.exec(script)?.[1];
      expect(nonce, `${path} has a nonce`).toBeTruthy();
      expect(await res.text(), `${path} scripts use that nonce`).toContain(`nonce="${nonce}"`);
      nonces.push(nonce!);
    }
    expect(new Set(nonces).size).toBe(nonces.length); // never reused
  });

  test("public pages hydrate and work with zero CSP violations", async ({ page }) => {
    const violations = await trackViolations(page);
    await page.goto("/");
    await page.getByRole("link", { name: /General Consultation/ }).click();
    await page.waitForSelector("button[data-date]:not([disabled])");
    await page.locator("button[data-date]:not([disabled])").first().click();
    await page.locator("button[data-slot]").first().click(); // interactive => hydration really ran
    await expect(page.getByTestId("selected-summary")).toBeVisible();
    await page.goto("/admin/login");
    await page.goto("/this-page-does-not-exist");
    expect(await violations()).toEqual([]);
  });

  test("an injected inline script is blocked by the policy", async ({ page }) => {
    const violations = await trackViolations(page);
    await page.goto("/book/general-consultation");
    await page.waitForSelector("button[data-date]");
    // Simulates an XSS payload landing in the DOM: it must not run.
    const ran = await page.evaluate(() => {
      const s = document.createElement("script");
      s.textContent = "window.__xss = true";
      document.body.appendChild(s);
      return (window as unknown as { __xss?: boolean }).__xss === true;
    });
    expect(ran).toBe(false);
    expect((await violations()).some((v) => v.startsWith("script-src"))).toBe(true);
  });
});

test("owner pages also run without CSP violations", async ({ page }) => {
  const violations = await trackViolations(page);
  for (const path of ["/admin", "/admin/calendar", "/admin/bookings", "/admin/services", "/admin/availability", "/admin/settings"]) {
    await page.goto(path);
    await expect(page.locator("main, h1").first()).toBeVisible();
  }
  expect(await violations()).toEqual([]);
});
