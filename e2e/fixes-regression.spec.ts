import { test, expect } from "@playwright/test";
import { login, users, createTestGroup, trpcMutation } from "./helpers";

test.describe("Regression: not-found pages", () => {
  test("group not found shows styled empty state with back link", async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
    await page.goto("/groups/nonexistent-group-id");

    await expect(page.getByRole("heading", { name: "Group not found" })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("doesn't exist or you don't have access")).toBeVisible();
    const backBtn = page.getByRole("button", { name: "Back to Groups" });
    await expect(backBtn).toBeVisible();
    await backBtn.click();
    await page.waitForURL("**/groups", { timeout: 10000 });
  });

  test("expense not found shows styled empty state with back link", async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
    const { groupId, dispose } = await createTestGroup(
      users.alice.email, users.alice.password, [], "Expense Not Found Test"
    );

    await page.goto(`/groups/${groupId}/expenses/nonexistent-expense-id`);

    await expect(page.getByRole("heading", { name: "Expense not found" })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("doesn't exist or has been deleted")).toBeVisible();
    const backBtn = page.getByRole("button", { name: "Back to Group" });
    await expect(backBtn).toBeVisible();
    await backBtn.click();
    await page.waitForURL(/\/groups\/\w+$/, { timeout: 10000 });

    await dispose();
  });

  test("edit expense not found shows styled empty state", async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
    const { groupId, dispose } = await createTestGroup(
      users.alice.email, users.alice.password, [], "Edit Not Found Test"
    );

    await page.goto(`/groups/${groupId}/expenses/nonexistent-expense-id/edit`);

    await expect(page.getByRole("heading", { name: "Expense not found" })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("button", { name: "Back to Group" })).toBeVisible();

    await dispose();
  });
});

test.describe("Regression: settle dialog pre-population", () => {
  test("clicking debt row pre-fills From, To, and Amount", async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
    await page.goto("/groups");
    await page.getByText("Apartment").first().click();
    await page.waitForURL(/\/groups\/\w+$/);

    // Click the Bob → Alice debt row
    await page.getByRole("button", { name: /Bob Smith.*Alice Johnson.*\$/ }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // From should be pre-selected to Bob Smith
    const fromText = await page.getByLabel("From").locator("option:checked").textContent();
    expect(fromText).toBe("Bob Smith");

    // To should be pre-selected to Alice Johnson
    const toText = await page.getByLabel("To").locator("option:checked").textContent();
    expect(toText).toBe("Alice Johnson");

    // Amount should be pre-filled
    await expect(page.getByLabel("Amount")).not.toHaveValue("");
  });

  test("settle dialog resets fields when opened with different debt", async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
    await page.goto("/groups");
    await page.getByText("Apartment").first().click();
    await page.waitForURL(/\/groups\/\w+$/);

    // Click Bob → Alice debt row
    await page.getByRole("button", { name: /Bob Smith.*Alice Johnson.*\$/ }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    let fromText = await page.getByLabel("From").locator("option:checked").textContent();
    expect(fromText).toBe("Bob Smith");

    // Close and click Charlie → Alice debt row
    await page.getByRole("button", { name: "Close" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await page.getByRole("button", { name: /Charlie Brown.*Alice Johnson.*\$/ }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();

    fromText = await page.getByLabel("From").locator("option:checked").textContent();
    expect(fromText).toBe("Charlie Brown");
  });
});

test.describe("Regression: no console errors", () => {
  test("group detail page has no nativeButton or re-render errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    await login(page, users.alice.email, users.alice.password);
    await page.goto("/groups");
    await page.getByText("Apartment").first().click();
    await page.waitForURL(/\/groups\/\w+$/);
    await page.waitForTimeout(2000);

    const nativeButtonErrors = errors.filter((e) => e.includes("nativeButton"));
    const maxDepthErrors = errors.filter((e) => e.includes("Maximum update depth"));
    expect(nativeButtonErrors).toHaveLength(0);
    expect(maxDepthErrors).toHaveLength(0);
  });

  test("add expense page has no re-render errors when switching split modes", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    await login(page, users.alice.email, users.alice.password);
    const { groupId, dispose } = await createTestGroup(
      users.alice.email, users.alice.password, [], "Split Mode Error Test"
    );

    await page.goto(`/groups/${groupId}/expenses/new`);
    await page.getByLabel("Amount").fill("100.00");

    // Cycle through all split modes
    await page.getByRole("button", { name: /Exact/ }).click();
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: /Percentage/ }).click();
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: /Shares/ }).click();
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: /Equal/ }).click();
    await page.waitForTimeout(300);

    const maxDepthErrors = errors.filter((e) => e.includes("Maximum update depth"));
    expect(maxDepthErrors).toHaveLength(0);

    await dispose();
  });
});

test.describe("Regression: percentage split pre-fill", () => {
  test("switching to percentage mode pre-fills equal percentages", async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
    const { groupId, dispose } = await createTestGroup(
      users.alice.email, users.alice.password,
      [
        { email: users.bob.email, password: users.bob.password },
        { email: users.charlie.email, password: users.charlie.password },
      ],
      "Pct Pre-fill New"
    );

    await page.goto(`/groups/${groupId}/expenses/new`);
    await page.getByLabel("Amount").fill("90.00");
    await page.getByRole("button", { name: /Percentage/ }).click();

    // Total should show ~100% without the "(should be 100%)" warning
    await expect(page.getByText(/Total:.*100/)).toBeVisible();
    await expect(page.getByText("should be 100%")).not.toBeVisible();

    await dispose();
  });

  test("percentage split on edit page pre-fills and keeps Save enabled", async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email, users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      "Pct Pre-fill Edit"
    );
    const aliceId = memberIds[users.alice.email];
    const bobId = memberIds[users.bob.email];
    const expRes = await trpcMutation(owner, "expenses.create", {
      groupId,
      title: "Pct Edit Expense",
      amount: 5000,
      splitMode: "EQUAL",
      paidById: aliceId,
      shares: [
        { userId: aliceId, amount: 2500 },
        { userId: bobId, amount: 2500 },
      ],
    });
    const expense = (await expRes.json()).result?.data?.json;

    await page.goto(`/groups/${groupId}/expenses/${expense.id}/edit`);
    await expect(page.getByRole("heading", { name: "Edit Expense" })).toBeVisible();

    // Switch to Percentage
    await page.getByRole("button", { name: /Percentage/ }).click();

    // Save should be enabled (not disabled)
    await expect(page.getByRole("button", { name: "Save Changes" })).toBeEnabled();
    // Total should show 100%
    await expect(page.getByText(/Total:.*100/)).toBeVisible();

    await dispose();
  });
});

test.describe("Regression: back button navigation", () => {
  test("add expense back button navigates to group detail", async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
    const { groupId, dispose } = await createTestGroup(
      users.alice.email, users.alice.password, [], "Back Nav Add Test"
    );

    await page.goto(`/groups/${groupId}/expenses/new`);
    await expect(page.getByRole("heading", { name: "Add Expense" })).toBeVisible();

    // Back button should be a button (Button+Link), not a raw <a>
    const backButton = page.getByRole("heading", { name: "Add Expense" }).locator("..").getByRole("button").first();
    await expect(backButton).toBeVisible();
    await backButton.click();

    await expect(page.getByRole("heading", { name: "Back Nav Add Test" })).toBeVisible({ timeout: 10000 });

    await dispose();
  });

  test("edit expense back button navigates to expense detail", async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email, users.alice.password, [], "Back Nav Edit Test"
    );
    const aliceId = memberIds[users.alice.email];
    const expRes = await trpcMutation(owner, "expenses.create", {
      groupId,
      title: "Back Nav Expense",
      amount: 1000,
      splitMode: "EQUAL",
      paidById: aliceId,
      shares: [{ userId: aliceId, amount: 1000 }],
    });
    const expense = (await expRes.json()).result?.data?.json;

    await page.goto(`/groups/${groupId}/expenses/${expense.id}/edit`);
    await expect(page.getByRole("heading", { name: "Edit Expense" })).toBeVisible();

    const backButton = page.getByRole("heading", { name: "Edit Expense" }).locator("..").getByRole("button").first();
    await expect(backButton).toBeVisible();
    await backButton.click();

    await expect(page.getByRole("heading", { name: "Back Nav Expense" })).toBeVisible({ timeout: 10000 });

    await dispose();
  });
});

test.describe("Regression: seed data", () => {
  test("seed demo groups exist and are accessible", async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
    await page.goto("/groups");
    await expect(page.getByText("Apartment").first()).toBeVisible();
    await expect(page.getByText("Japan Trip").first()).toBeVisible();
  });
});
