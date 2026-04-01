import { test, expect } from "@playwright/test";
import { users, login } from "./helpers";

test.describe("Groups Search & Filter", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
    await page.goto("/groups");
  });

  test("search input is visible when groups exist", async ({ page }) => {
    await expect(page.getByPlaceholder("Search groups...")).toBeVisible();
  });

  test("search filters groups by name", async ({ page }) => {
    const searchInput = page.getByPlaceholder("Search groups...");
    await searchInput.fill("Apartment");

    // Apartment should be visible
    await expect(page.getByText("Apartment")).toBeVisible();
    // Japan Trip should be hidden
    await expect(page.getByText("Japan Trip")).not.toBeVisible();
  });

  test("search is case insensitive", async ({ page }) => {
    const searchInput = page.getByPlaceholder("Search groups...");
    await searchInput.fill("apartment");
    await expect(page.getByText("Apartment")).toBeVisible();

    await searchInput.fill("JAPAN");
    await expect(page.getByText("Japan Trip")).toBeVisible();
  });

  test("shows no results message when search has no matches", async ({ page }) => {
    const searchInput = page.getByPlaceholder("Search groups...");
    await searchInput.fill("nonexistent group xyz");
    await expect(page.getByText("No groups match your search")).toBeVisible();
  });

  test("clearing search shows all groups again", async ({ page }) => {
    const searchInput = page.getByPlaceholder("Search groups...");

    // Filter to one group
    await searchInput.fill("Apartment");
    await expect(page.getByText("Japan Trip")).not.toBeVisible();

    // Clear search — groups page paginates, so verify via search that both exist
    await searchInput.fill("");
    await expect(page.getByText("Apartment").first()).toBeVisible();

    // Verify Japan Trip is accessible by searching for it
    await searchInput.fill("Japan Trip");
    await expect(page.getByText("Japan Trip").first()).toBeVisible();
  });

  test("search input hidden when user has no groups", async ({ page }) => {
    // Register a fresh user with no groups
    await page.goto("/register");
    const email = `search-test-${Date.now()}@test.com`;
    await page.getByLabel("Name").fill("Search Tester");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill("testpass123");
    await page.getByRole("button", { name: "Create account" }).click();
    await page.waitForURL("**/dashboard", { timeout: 15000 });

    await page.goto("/groups");
    await expect(page.getByText("No groups yet")).toBeVisible();
    await expect(page.getByPlaceholder("Search groups...")).not.toBeVisible();
  });
});
