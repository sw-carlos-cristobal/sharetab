import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 4 : "50%",
  timeout: 60000,
  expect: { timeout: 15000 },
  reporter: process.env.CI ? "github" : "list",
  outputDir: "./tmp-screenshots",
  use: {
    baseURL: process.env.BASE_URL || "http://localhost:3001",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    navigationTimeout: 30000,
    actionTimeout: 15000,
  },
  projects: [
    // Tests that mutate or depend on shared seed data — run serially first
    {
      name: "serial",
      testMatch: [
        "admin-ai-provider-ui.spec.ts",
        "admin-features.spec.ts",
        "admin-meridian.spec.ts",
        "ai-provider-test.spec.ts",
        "balances.spec.ts",
        "expenses.spec.ts",
        "groups.spec.ts",
        "sidebar.spec.ts",
        "receipt-ui.spec.ts",
      ],
      fullyParallel: false,
      workers: 1,
      use: { browserName: "chromium" },
    },
    // Everything else — fully parallel, runs after serial completes
    {
      name: "parallel",
      testIgnore: [
        "admin-ai-provider-ui.spec.ts",
        "admin-features.spec.ts",
        "admin-meridian.spec.ts",
        "ai-provider-test.spec.ts",
        "balances.spec.ts",
        "expenses.spec.ts",
        "groups.spec.ts",
        "sidebar.spec.ts",
        "receipt-ui.spec.ts",
      ],
      dependencies: ["serial"],
      use: { browserName: "chromium" },
    },
  ],
});
