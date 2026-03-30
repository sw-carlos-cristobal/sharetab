import { test, expect } from "@playwright/test";
import { login, users, authedContext, trpcMutation, createTestGroup } from "./helpers";

test.describe("Back button navigation", () => {
  test("back button on expense edit page navigates to expense detail", async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);

    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email, users.alice.password, [], "Back Button Edit Test"
    );
    const aliceId = memberIds[users.alice.email];
    const expenseRes = await trpcMutation(owner, "expenses.create", {
      groupId,
      title: "Test Expense",
      amount: 1000,
      splitMode: "EQUAL",
      paidById: aliceId,
      shares: [{ userId: aliceId, amount: 1000 }],
    });
    const expense = (await expenseRes.json()).result?.data?.json;

    await page.goto(`/groups/${groupId}/expenses/${expense.id}/edit`);
    await expect(page.getByRole("heading", { name: "Edit Expense" })).toBeVisible();

    // Click the back link next to heading
    await page.getByRole("heading", { name: "Edit Expense" }).locator("..").locator("a").first().click();

    // Should navigate to expense detail page
    await expect(page.getByRole("heading", { name: "Test Expense" })).toBeVisible({ timeout: 10000 });
    expect(page.url()).not.toContain("/edit");

    await dispose();
  });

  test("back button on add expense page navigates to group detail", async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);

    const { groupId, dispose } = await createTestGroup(
      users.alice.email, users.alice.password, [], "Back Button Add Test"
    );

    await page.goto(`/groups/${groupId}/expenses/new`);
    await expect(page.getByRole("heading", { name: "Add Expense" })).toBeVisible();

    // Click the back link next to heading
    await page.getByRole("heading", { name: "Add Expense" }).locator("..").locator("a").first().click();

    // Should navigate to group detail page
    await expect(page.getByRole("heading", { name: "Back Button Add Test" })).toBeVisible({ timeout: 10000 });
    expect(page.url()).not.toContain("/expenses/new");

    await dispose();
  });

  test("back button on group settings page navigates to group detail", async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);

    const { groupId, dispose } = await createTestGroup(
      users.alice.email, users.alice.password, [], "Back Button Settings Test"
    );

    await page.goto(`/groups/${groupId}/settings`);
    await expect(page.getByText("Group Settings")).toBeVisible();

    await page.locator(`a[href="/groups/${groupId}"]`).first().click();

    await expect(page.getByRole("heading", { name: "Back Button Settings Test" })).toBeVisible({ timeout: 10000 });
    expect(page.url()).not.toContain("/settings");

    await dispose();
  });

  test("back button on scan page navigates to group detail", async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);

    const { groupId, dispose } = await createTestGroup(
      users.alice.email, users.alice.password, [], "Back Button Scan Test"
    );

    await page.goto(`/groups/${groupId}/scan`);
    await expect(page.getByRole("heading", { name: "Scan Receipt" })).toBeVisible();

    await page.locator(`a[href="/groups/${groupId}"]`).first().click();

    await expect(page.getByRole("heading", { name: "Back Button Scan Test" })).toBeVisible({ timeout: 10000 });
    expect(page.url()).not.toContain("/scan");

    await dispose();
  });

  test.fixme("sidebar Dashboard link works on expense edit page", async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);

    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email, users.alice.password, [], "Sidebar Nav Test"
    );
    const aliceId = memberIds[users.alice.email];
    const expenseRes = await trpcMutation(owner, "expenses.create", {
      groupId,
      title: "Sidebar Test Expense",
      amount: 500,
      splitMode: "EQUAL",
      paidById: aliceId,
      shares: [{ userId: aliceId, amount: 500 }],
    });
    const expense = (await expenseRes.json()).result?.data?.json;

    await page.goto(`/groups/${groupId}/expenses/${expense.id}/edit`);
    await expect(page.getByRole("heading", { name: "Edit Expense" })).toBeVisible();

    // Click Dashboard in the sidebar
    await page.locator("aside").getByRole("link", { name: "Dashboard" }).click();
    await page.waitForURL("**/dashboard", { timeout: 10000 });

    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible({ timeout: 10000 });

    await dispose();
  });

  test("sidebar Groups link works on add expense page", async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);

    const { groupId, dispose } = await createTestGroup(
      users.alice.email, users.alice.password, [], "Sidebar Groups Test"
    );

    await page.goto(`/groups/${groupId}/expenses/new`);
    await expect(page.getByRole("heading", { name: "Add Expense" })).toBeVisible();

    // Click Groups in the sidebar
    await page.getByRole("link", { name: "Groups" }).click();

    await expect(page.getByRole("heading", { name: "Groups" })).toBeVisible({ timeout: 10000 });
    expect(page.url()).toContain("/groups");

    await dispose();
  });
});
