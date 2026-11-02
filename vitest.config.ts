import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: "forks",
    env: {
      APP_SECRET: "test-secret-test-secret-test-secret-123456",
      ADMIN_PASSWORD: "test-admin-password",
      APP_URL: "http://localhost:3000",
    },
  },
});
