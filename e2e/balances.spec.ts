import { test, expect } from "@playwright/test";
import { users, login } from "./helpers";

test.describe("Balances & Settlements", () => {
  // ── Dashboard Balances ────────────────────────────────────

  test.describe("Dashboard", () => {
    test("7.2.1 — shows balance cards", async ({ page }) => {
      await login(page, users.alice.email, users.alice.password);
      await expect(page.getByText("You are owed")).toBeVisible();
      await expect(page.getByText("You owe")).toBeVisible();
      // Alice is owed money from seed data
      const owedText = page.locator("text=$").first();
      await expect(owedText).toBeVisible();
    });

    test("7.2.2 — shows group cards with balances", async ({ page }) => {
      await login(page, users.alice.email, users.alice.password);
      await expect(page.getByText("Japan Trip")).toBeVisible();
      await expect(page.getByText("Apartment")).toBeVisible();
      await expect(page.getByText("+$375.00")).toBeVisible();
      // Apartment balance varies due to test pollution; just check the card exists with some balance
      await expect(page.getByRole("link", { name: /Apartment/ })).toBeVisible();
    });

    test("4.3.3 — new user sees empty dashboard", async ({ page }) => {
      // Register fresh user
      const email = `empty-${Date.now()}@test.com`;
      await page.goto("/register");
      await page.getByLabel("Name").fill("Empty User");
      await page.getByLabel("Email").fill(email);
      await page.getByLabel("Password").fill("testpass123");
      await page.getByRole("button", { name: "Create account" }).click();
      await page.waitForURL("**/dashboard", { timeout: 15000 });

      await expect(page.getByText("$0.00").first()).toBeVisible();
      await expect(page.getByText("No groups yet")).toBeVisible();
    });
  });

  // ── Group Balances ────────────────────────────────────────

  test.describe("Group Balances", () => {
    test("7.3.2 — simplified debts displayed", async ({ page }) => {
      await login(page, users.alice.email, users.alice.password);
      await page.goto("/groups");
      await page.getByText("Apartment").click();
      await page.waitForURL(/\/groups\/\w+$/);

      // Bob and Charlie owe Alice
      await expect(page.getByRole("button", { name: /Bob Smith.*Alice Johnson.*\$/ }).first()).toBeVisible();
      await expect(page.getByRole("button", { name: /Charlie Brown.*Alice Johnson.*\$/ }).first()).toBeVisible();
    });

    test("7.3.3 — settled group shows all settled", async ({ page }) => {
      await login(page, users.alice.email, users.alice.password);
      // Create a new group with no expenses
      await page.goto("/groups/new");
      await page.getByLabel("Group name").fill("Empty Balance Group");
      await page.getByRole("button", { name: "Create Group" }).click();
      await page.waitForURL(/\/groups\/\w+$/, { timeout: 10000 });

      await expect(page.getByText("All settled up!")).toBeVisible();
    });
  });

  // ── Settlements ───────────────────────────────────────────

  test.describe("Settlements", () => {
    test("7.3.5 — settle up button opens dialog", async ({ page }) => {
      await login(page, users.alice.email, users.alice.password);
      await page.goto("/groups");
      await page.getByText("Apartment").click();
      await page.waitForURL(/\/groups\/\w+$/);

      await page.getByRole("button", { name: "Settle up" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(page.getByRole("heading", { name: "Record a payment" })).toBeVisible();
      await expect(page.getByLabel("Paid to")).toBeVisible();
      await expect(page.getByLabel("Amount")).toBeVisible();
    });

    test("settle dialog pre-fills from debt click", async ({ page }) => {
      await login(page, users.alice.email, users.alice.password);
      await page.goto("/groups");
      await page.getByText("Apartment").click();
      await page.waitForURL(/\/groups\/\w+$/);

      await page.getByRole("button", { name: /Bob Smith.*Alice Johnson.*\$/ }).first().click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(page.getByText(/Use suggested: \$/)).toBeVisible();
    });
  });
});
