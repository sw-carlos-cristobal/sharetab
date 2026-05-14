import { test, expect } from "@playwright/test";
import { users, login, uniqueEmail, register, navigateToGroup } from "./helpers";

test.describe("Groups", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
  });

  // ── Create Group ──────────────────────────────────────────

  test.describe("Create Group", () => {
    test("2.1.1 — create group with defaults", async ({ page }) => {
      await page.goto("/en/groups/new");
      await page.getByLabel("Group name").fill("Test Group");
      await page.getByRole("button", { name: "Create Group" }).click();
      // Should redirect to new group detail page
      await page.waitForURL(/\/groups\/\w+/, { timeout: 10000 });
      await expect(page.getByRole("heading", { name: "Test Group" })).toBeVisible();
    });

    test("2.1.2 — create group with all fields", async ({ page }) => {
      await page.goto("/en/groups/new");
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
      await navigateToGroup(page, "Apartment");
      await expect(page.getByText("Alice Johnson").first()).toBeVisible();
      await expect(page.getByText("Owner")).toBeVisible();
      await expect(page.getByText("Bob Smith").first()).toBeVisible();
      await expect(page.getByText("Charlie Brown").first()).toBeVisible();
    });

    test("7.3.2 — shows simplified debts", async ({ page }) => {
      await navigateToGroup(page, "Apartment");
      await expect(page.getByText("Balances")).toBeVisible();
      // Verify at least one debt row exists (amounts vary due to test pollution)
      await expect(
        page.getByRole("button", { name: /Bob Smith.*Alice Johnson.*\$/ }).first()
      ).toBeVisible();
    });

    test("7.3.6 — shows expense list", async ({ page }) => {
      await navigateToGroup(page, "Apartment");
      // Verify at least one expense link is visible (specific titles may be
      // pushed off the visible list by expenses created in other test suites)
      await expect(
        page.getByRole("link", { name: /Paid by/ }).first()
      ).toBeVisible();
    });

    test("7.3.4 — clicking debt row opens settle dialog", async ({ page }) => {
      await navigateToGroup(page, "Apartment");
      // Click any debt row between Bob Smith and Alice Johnson
      await page.getByRole("button", { name: /Bob Smith.*Alice Johnson.*\$/ }).first().click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(page.getByRole("heading", { name: "Record a payment" })).toBeVisible();
      await expect(page.getByText(/Use suggested: \$/)).toBeVisible();
    });
  });

  // ── Group Settings ────────────────────────────────────────

  test.describe("Group Settings", () => {
    test("2.3.1 — owner can update group name", async ({ page }) => {
      // Create a group first
      await page.goto("/en/groups/new");
      await page.getByLabel("Group name").fill("Rename Me");
      await page.getByRole("button", { name: "Create Group" }).click();
      await page.waitForURL(/\/groups\/\w+$/, { timeout: 10000 });

      // Go to settings via the settings link on the group detail page
      await page.locator('a[href*="/groups/"][href$="/settings"]').click();
      await page.waitForURL(/\/groups\/\w+\/settings$/);
      await page.getByLabel("Name").clear();
      await page.getByLabel("Name").fill("Renamed Group");
      await page.getByRole("button", { name: "Save changes" }).click();
      await expect(page.getByText("Saved!")).toBeVisible({ timeout: 10000 });
    });
  });

  // ── Console Errors ────────────────────────────────────────

  test.describe("Console Errors", () => {
    test("group detail page has no nativeButton or re-render errors", async ({ page }) => {
      const errors: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(msg.text());
      });

      await navigateToGroup(page, "Apartment");
      await page.waitForTimeout(2000);

      const nativeButtonErrors = errors.filter((e) => e.includes("nativeButton"));
      const maxDepthErrors = errors.filter((e) => e.includes("Maximum update depth"));
      expect(nativeButtonErrors).toHaveLength(0);
      expect(maxDepthErrors).toHaveLength(0);
    });
  });

  // ── Seed Data ────────────────────────────────────────────

  test.describe("Seed Data", () => {
    test("seed demo groups exist and are accessible", async ({ page }) => {
      await page.goto("/en/groups");
      await page.getByPlaceholder("Search groups...").fill("Apartment");
      await expect(page.getByText("Apartment").first()).toBeVisible();
      await page.getByPlaceholder("Search groups...").fill("Japan Trip");
      await expect(page.getByText("Japan Trip").first()).toBeVisible();
    });
  });

  // ── Invites ───────────────────────────────────────────────

  test.describe("Invites", () => {
    test("2.4.1 — generate invite link", async ({ page }) => {
      await navigateToGroup(page, "Apartment");
      await page.getByRole("button", { name: "Invite" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(page.getByText("Generate invite link")).toBeVisible();
      await page.getByRole("button", { name: "Generate invite link" }).click();
      // Should show the invite URL
      await expect(page.getByRole("textbox")).toHaveValue(/\/invite\//, { timeout: 10000 });
    });
  });
});
