import { test, expect } from "@playwright/test";
import { users, authedContext, trpcMutation, trpcQuery, trpcResult, trpcError, createTestGroup, login, navigateToGroup } from "./helpers";

test.describe("Expense Authorization", () => {
  test("non-owner member cannot update another member's expense via API", async () => {
    const { owner, groupId, memberIds, memberContexts, dispose } = await createTestGroup(
      users.alice.email, users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      "Auth Update Test"
    );

    const aliceId = memberIds[users.alice.email];
    const createRes = await trpcMutation(owner, "expenses.create", {
      groupId,
      title: "Alice's expense",
      amount: 2000,
      paidById: aliceId,
      splitMode: "EQUAL",
      shares: [
        { userId: aliceId, amount: 1000 },
        { userId: memberIds[users.bob.email], amount: 1000 },
      ],
    });
    const expense = (await createRes.json()).result?.data?.json;

    const bobCtx = memberContexts[0];
    const updateRes = await trpcMutation(bobCtx, "expenses.update", {
      groupId,
      expenseId: expense.id,
      title: "Bob hijacked this",
    });
    const err = await trpcError(updateRes);
    expect(err?.data?.code).toBe("FORBIDDEN");

    await dispose();
  });

  test("non-owner member cannot delete another member's expense via API", async () => {
    const { owner, groupId, memberIds, memberContexts, dispose } = await createTestGroup(
      users.alice.email, users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      "Auth Delete Test"
    );

    const aliceId = memberIds[users.alice.email];
    const createRes = await trpcMutation(owner, "expenses.create", {
      groupId,
      title: "Alice's protected expense",
      amount: 3000,
      paidById: aliceId,
      splitMode: "EQUAL",
      shares: [
        { userId: aliceId, amount: 1500 },
        { userId: memberIds[users.bob.email], amount: 1500 },
      ],
    });
    const expense = (await createRes.json()).result?.data?.json;

    const bobCtx = memberContexts[0];
    const deleteRes = await trpcMutation(bobCtx, "expenses.delete", {
      groupId,
      expenseId: expense.id,
    });
    const err = await trpcError(deleteRes);
    expect(err?.data?.code).toBe("FORBIDDEN");

    await dispose();
  });

  test("expense creator can still update their own expense", async () => {
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email, users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      "Auth Creator Update"
    );

    const aliceId = memberIds[users.alice.email];
    const createRes = await trpcMutation(owner, "expenses.create", {
      groupId,
      title: "My expense",
      amount: 5000,
      paidById: aliceId,
      splitMode: "EQUAL",
      shares: [
        { userId: aliceId, amount: 2500 },
        { userId: memberIds[users.bob.email], amount: 2500 },
      ],
    });
    const expense = (await createRes.json()).result?.data?.json;

    const updateRes = await trpcMutation(owner, "expenses.update", {
      groupId,
      expenseId: expense.id,
      title: "Updated by creator",
    });
    const updated = (await updateRes.json()).result?.data?.json;
    expect(updated.title).toBe("Updated by creator");

    await dispose();
  });

  test("UI: non-owner sees error when trying to delete another's expense", async ({ page }) => {
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email, users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      "Auth UI Delete"
    );

    const aliceId = memberIds[users.alice.email];
    await trpcMutation(owner, "expenses.create", {
      groupId,
      title: "Protected Expense UI",
      amount: 4200,
      paidById: aliceId,
      splitMode: "EQUAL",
      shares: [
        { userId: aliceId, amount: 2100 },
        { userId: memberIds[users.bob.email], amount: 2100 },
      ],
    });

    // Login as Bob and navigate to the group
    await login(page, users.bob.email, users.bob.password);
    await page.goto(`/en/groups/${groupId}`);
    await page.waitForSelector("text=Protected Expense UI", { timeout: 15000 });

    // Screenshot: Bob sees Alice's expense in the list
    await page.screenshot({ path: "docs/screenshots/expense-auth-bob-sees-expense.png", fullPage: true });

    // Click into the expense detail
    await page.getByText("Protected Expense UI").first().click();
    await page.waitForURL(/\/expenses\/\w+$/);

    // Screenshot: Bob sees the expense detail page with delete button
    await page.screenshot({ path: "docs/screenshots/expense-auth-detail-page.png", fullPage: true });

    // Try to delete — accept the confirm dialog
    page.on("dialog", (dialog) => dialog.accept());
    await expect(page.getByRole("button", { name: /Delete/i })).toBeVisible();
    await page.getByRole("button", { name: /Delete/i }).click();
    // Wait for error toast to appear
    await page.waitForTimeout(2000);
    // Screenshot: Bob sees FORBIDDEN error after trying to delete
    await page.screenshot({ path: "docs/screenshots/expense-auth-forbidden-delete.png", fullPage: true });
    // Should still be on the expense page (not redirected)
    await expect(page.getByText("Protected Expense UI")).toBeVisible();

    await dispose();
  });
});
