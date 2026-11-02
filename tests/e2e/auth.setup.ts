import { test as setup, expect } from "@playwright/test";

setup("sign in as the owner once", async ({ page }) => {
  await page.goto("/admin/login");
  await page.fill("#password", "e2e-admin-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await page.context().storageState({ path: "tests/e2e/.auth.json" });
});
