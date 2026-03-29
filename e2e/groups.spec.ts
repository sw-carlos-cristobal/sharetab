import { test, expect } from "@playwright/test";
import { users, login, uniqueEmail, register } from "./helpers";

test.describe("Groups", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
  });

  // ── Create Group ──────────────────────────────────────────

  test.describe("Create Group", () => {
    test("2.1.1 — create group with defaults", async ({ page }) => {
      await page.goto("/groups/new");
      await page.getByLabel("Group name").fill("Test Group");
      await page.getByRole("button", { name: "Create Group" }).click();
      // Should redirect to new group detail page
      await page.waitForURL(/\/groups\/\w+/, { timeout: 10000 });
      await expect(page.getByRole("heading", { name: "Test Group" })).toBeVisible();
    });

    test("2.1.2 — create group with all fields", async ({ page }) => {
      await page.goto("/groups/new");
      await page.getByLabel("Group name").fill("Vacation Fund");
      await page.getByLabel("Description").fill("For our summer trip");
      // Select airplane emoji
      await page.locator("button", { hasText: "✈️" }).click();
      // Select EUR currency
      await page.getByLabel("Currency").selectOption("EUR");
      await page.getByRole("button", { name: "Create Group" }).click();
      await page.waitForURL(/\/groups\/\w+/, { timeout: 10000 });
      await expect(page.getByRole("heading", { name: "Vacation Fund" })).toBeVisible();
      await expect(page.getByText("For our summer trip")).toBeVisible();
    });
  });

  // ── Group Detail ──────────────────────────────────────────

  test.describe("Group Detail", () => {
    test("7.3.1 — shows member chips with roles", async ({ page }) => {
      await page.goto("/groups");
      await page.getByText("Apartment").click();
      await page.waitForURL(/\/groups\/\w+$/);
      await expect(page.getByText("Alice Johnson")).toBeVisible();
      await expect(page.getByText("Owner")).toBeVisible();
      await expect(page.getByText("Bob Smith")).toBeVisible();
      await expect(page.getByText("Charlie Brown")).toBeVisible();
    });

    test("7.3.2 — shows simplified debts", async ({ page }) => {
      await page.goto("/groups");
      await page.getByText("Apartment").click();
      await page.waitForURL(/\/groups\/\w+$/);
      await expect(page.getByText("Balances")).toBeVisible();
      await expect(page.getByText("$20.65")).toBeVisible();
      await expect(page.getByText("$1.15")).toBeVisible();
    });

    test("7.3.6 — shows expense list", async ({ page }) => {
      await page.goto("/groups");
      await page.getByText("Apartment").click();
      await page.waitForURL(/\/groups\/\w+$/);
      await expect(page.getByText("Groceries")).toBeVisible();
      await expect(page.getByText("Electric bill")).toBeVisible();
      await expect(page.getByText("Internet")).toBeVisible();
      await expect(page.getByText("Dinner out")).toBeVisible();
    });

    test("7.3.4 — clicking debt row opens settle dialog", async ({ page }) => {
      await page.goto("/groups");
      await page.getByText("Apartment").click();
      await page.waitForURL(/\/groups\/\w+$/);
      // Click the debt row with $20.65
      await page.getByRole("button", { name: /Bob Smith.*Alice Johnson.*\$20\.65/ }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(page.getByText("Record a payment")).toBeVisible();
      await expect(page.getByText("Use suggested: $20.65")).toBeVisible();
    });
  });

  // ── Group Settings ────────────────────────────────────────

  test.describe("Group Settings", () => {
    test("2.3.1 — owner can update group name", async ({ page }) => {
      // Create a group first
      await page.goto("/groups/new");
      await page.getByLabel("Group name").fill("Rename Me");
      await page.getByRole("button", { name: "Create Group" }).click();
      await page.waitForURL(/\/groups\/\w+$/, { timeout: 10000 });

      // Go to settings
      const url = page.url();
      await page.goto(url + "/settings");
      await page.getByLabel("Name").clear();
      await page.getByLabel("Name").fill("Renamed Group");
      await page.getByRole("button", { name: "Save changes" }).click();
      await expect(page.getByText("Saved!")).toBeVisible({ timeout: 10000 });
    });
  });

  // ── Invites ───────────────────────────────────────────────

  test.describe("Invites", () => {
    test("2.4.1 — generate invite link", async ({ page }) => {
      await page.goto("/groups");
      await page.getByText("Apartment").click();
      await page.waitForURL(/\/groups\/\w+$/);
      await page.getByRole("button", { name: "Invite" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(page.getByText("Generate invite link")).toBeVisible();
      await page.getByRole("button", { name: "Generate invite link" }).click();
      // Should show the invite URL
      await expect(page.getByRole("textbox")).toHaveValue(/\/invite\//, { timeout: 10000 });
    });
  });
});
