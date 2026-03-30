import { test, expect } from "@playwright/test";
import { users, login } from "./helpers";

test.describe("Expenses", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
  });

  // ── Expense Detail ────────────────────────────────────────

  test.describe("Expense Detail", () => {
    test("expense detail shows all fields", async ({ page }) => {
      // Create a known expense so the test is immune to pollution
      await page.goto("/groups");
      await page.getByText("Apartment").click();
      await page.waitForURL(/\/groups\/\w+$/);
      const groupUrl = page.url();
      await page.goto(groupUrl + "/expenses/new");

      await page.getByLabel("Description").fill("Detail Test Expense");
      await page.getByLabel("Amount").fill("85.47");
      await page.getByLabel("Category (optional)").fill("Food");
      await page.getByLabel("Paid by").selectOption({ label: "Alice Johnson" });
      await page.getByRole("button", { name: "Add Expense" }).click();
      await page.waitForURL(/\/groups\/\w+$/, { timeout: 15000 });

      // Navigate to the newly created expense
      await page.getByRole("link", { name: /Detail Test Expense/ }).first().click();
      await page.waitForURL(/\/expenses\/\w+$/);

      await expect(page.getByRole("heading", { name: "Detail Test Expense" })).toBeVisible();
      await expect(page.getByText("$85.47")).toBeVisible();
      await expect(page.getByText("EQUAL")).toBeVisible();
      await expect(page.getByText("Alice Johnson").first()).toBeVisible();
      await expect(page.getByText("Food")).toBeVisible();
      // Split breakdown
      await expect(page.getByText("$28.49").first()).toBeVisible();
    });
  });

  // ── Add Expense ───────────────────────────────────────────

  test.describe("Add Expense", () => {
    test("7.4.1 — equal split UI with all members", async ({ page }) => {
      await page.goto("/groups");
      await page.getByText("Apartment").click();
      await page.waitForURL(/\/groups\/\w+$/);
      const groupUrl = page.url();
      await page.goto(groupUrl + "/expenses/new");

      // Form fields visible
      await expect(page.getByLabel("Description")).toBeVisible();
      await expect(page.getByLabel("Amount")).toBeVisible();
      await expect(page.getByLabel("Paid by")).toBeVisible();

      // 4 split mode buttons
      await expect(page.getByRole("button", { name: /Equal/ })).toBeVisible();
      await expect(page.getByRole("button", { name: /Exact/ })).toBeVisible();
      await expect(page.getByRole("button", { name: /Percentage/ })).toBeVisible();
      await expect(page.getByRole("button", { name: /Shares/ })).toBeVisible();

      // Default is EQUAL with all members checked
      await expect(page.getByLabel("Alice Johnson")).toBeChecked();
      await expect(page.getByLabel("Bob Smith")).toBeChecked();
      await expect(page.getByLabel("Charlie Brown")).toBeChecked();
    });

    test("7.4.5 — create equal split expense", async ({ page }) => {
      await page.goto("/groups");
      await page.getByText("Apartment").click();
      await page.waitForURL(/\/groups\/\w+$/);
      const groupUrl = page.url();
      await page.goto(groupUrl + "/expenses/new");

      await page.getByLabel("Description").fill("Coffee run");
      await page.getByLabel("Amount").fill("15.00");
      await page.getByLabel("Paid by").selectOption({ label: "Alice Johnson" });

      // All 3 members checked by default (EQUAL)
      await page.getByRole("button", { name: "Add Expense" }).click();

      // Should redirect back to group page
      await page.waitForURL(/\/groups\/\w+$/, { timeout: 15000 });
      await expect(page.getByText("Coffee run").first()).toBeVisible();
      await expect(page.getByText("$15.00").first()).toBeVisible();
    });

    test("7.4.2 — exact split UI shows remaining", async ({ page }) => {
      await page.goto("/groups");
      await page.getByText("Apartment").click();
      await page.waitForURL(/\/groups\/\w+$/);
      const groupUrl = page.url();
      await page.goto(groupUrl + "/expenses/new");

      await page.getByLabel("Amount").fill("30.00");
      // Switch to Exact mode
      await page.getByRole("button", { name: /Exact/ }).click();

      // Should show input fields for each member
      await expect(page.getByText("remaining")).toBeVisible();
    });

    test("7.4.3 — percentage split UI shows total", async ({ page }) => {
      await page.goto("/groups");
      await page.getByText("Apartment").click();
      await page.waitForURL(/\/groups\/\w+$/);
      const groupUrl = page.url();
      await page.goto(groupUrl + "/expenses/new");

      await page.getByLabel("Amount").fill("100.00");
      await page.getByRole("button", { name: /Percentage/ }).click();

      await expect(page.getByText(/Total:.*%/)).toBeVisible();
    });

    test("7.4.4 — shares split UI shows share units", async ({ page }) => {
      await page.goto("/groups");
      await page.getByText("Apartment").click();
      await page.waitForURL(/\/groups\/\w+$/);
      const groupUrl = page.url();
      await page.goto(groupUrl + "/expenses/new");

      await page.getByLabel("Amount").fill("90.00");
      await page.getByRole("button", { name: /Shares/ }).click();

      await expect(page.getByText(/Total:.*shares/)).toBeVisible();
    });
  });

  // ── Delete Expense ────────────────────────────────────────

  test.describe("Delete Expense", () => {
    test("delete expense from detail page", async ({ page }) => {
      // Use unique name to avoid collision with previous test runs
      const expenseName = `Delete me ${Date.now()}`;

      // First create an expense to delete
      await page.goto("/groups");
      await page.getByText("Apartment").click();
      await page.waitForURL(/\/groups\/\w+$/);
      const groupUrl = page.url();
      await page.goto(groupUrl + "/expenses/new");

      await page.getByLabel("Description").fill(expenseName);
      await page.getByLabel("Amount").fill("10.00");
      await page.getByLabel("Paid by").selectOption({ label: "Alice Johnson" });
      await page.getByRole("button", { name: "Add Expense" }).click();
      await page.waitForURL(/\/groups\/\w+$/, { timeout: 15000 });

      // Click into the new expense
      await page.getByText(expenseName).first().click();
      await page.waitForURL(/\/expenses\/\w+$/);

      // Confirm delete
      page.on("dialog", (dialog) => dialog.accept());
      await page.getByRole("button", { name: /Delete/i }).click();

      // Should redirect back to group
      await page.waitForURL(/\/groups\/\w+$/, { timeout: 10000 });
      // Expense should be gone
      await expect(page.getByText(expenseName)).not.toBeVisible();
    });
  });
});
