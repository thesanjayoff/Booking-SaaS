import { defineConfig, devices } from "@playwright/test";

const PORT = 3210;
const BASE = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1, // one shared server + database; also keeps the in-memory rate limiter predictable
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: { baseURL: BASE, timezoneId: "Asia/Kolkata", locale: "en-US", trace: "retain-on-failure" },
  webServer: {
    // Fresh demo database on every run, then a real production build of the app (own dist dir,
    // so it never collides with a running `next dev`).
    command: `npx tsx scripts/seed.ts --reset && npx next build && npx next start -p ${PORT}`,
    url: BASE,
    reuseExistingServer: false,
    timeout: 300_000,
    env: {
      NEXT_DIST_DIR: process.env.E2E_DIST_DIR || ".next-e2e",
      DATABASE_PATH: "./data/e2e.db",
      APP_SECRET: "e2e-secret-e2e-secret-e2e-secret-1234567",
      ADMIN_PASSWORD: "e2e-admin-password",
      APP_URL: BASE,
      RUN_WORKER: "0",
      PAYMENTS_ENABLED: "0",
    },
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    { name: "chromium", dependencies: ["setup"], testIgnore: /auth\.setup\.ts/, use: { ...devices["Desktop Chrome"], storageState: "tests/e2e/.auth.json" } },
  ],
});
