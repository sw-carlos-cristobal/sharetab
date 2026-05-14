import { test, expect } from "@playwright/test";
import { login, users, createTestGroup, trpcMutation, trpcError, authedContext } from "./helpers";

test.describe("Group Archiving", () => {
  // ── API-level tests ──────────────────────────────────────

  test.describe("API", () => {
    test("owner can archive a group", async () => {
      const { owner, groupId, dispose } = await createTestGroup(
        users.alice.email, users.alice.password, [], "Archive API Test"
      );

      const res = await trpcMutation(owner, "groups.archive", { groupId });
      const body = await res.json();
      expect(body.result?.data?.json?.archivedAt).toBeTruthy();

      await dispose();
    });

    test("member cannot archive a group", async () => {
      const { groupId, memberContexts, dispose } = await createTestGroup(
        users.alice.email, users.alice.password,
        [{ email: users.bob.email, password: users.bob.password }],
        "Archive Forbidden Test"
      );

      const res = await trpcMutation(memberContexts[0], "groups.archive", { groupId });
      const body = await res.json();
      expect(body.error).toBeDefined();

      await dispose();
    });

    test("archived group excluded from groups.list", async () => {
      const { owner, groupId, dispose } = await createTestGroup(
        users.alice.email, users.alice.password, [], "Archive List Test"
      );

      await trpcMutation(owner, "groups.archive", { groupId });

      const listRes = await owner.get(
        `/api/trpc/groups.list?batch=1&input=${encodeURIComponent(JSON.stringify({ "0": { json: null, meta: { values: ["undefined"], v: 1 } } }))}`
      );
      const listBody = await listRes.json();
      const groups = listBody[0]?.result?.data?.json ?? [];
      const found = groups.find((g: { id: string }) => g.id === groupId);
      expect(found).toBeUndefined();

      await dispose();
    });

    test("archived group appears in groups.listArchived", async () => {
      const { owner, groupId, dispose } = await createTestGroup(
        users.alice.email, users.alice.password, [], "Archive ListArchived Test"
      );

      await trpcMutation(owner, "groups.archive", { groupId });

      const listRes = await owner.get(
        `/api/trpc/groups.listArchived?batch=1&input=${encodeURIComponent(JSON.stringify({ "0": { json: null, meta: { values: ["undefined"], v: 1 } } }))}`
      );
      const listBody = await listRes.json();
      const groups = listBody[0]?.result?.data?.json ?? [];
      const found = groups.find((g: { id: string }) => g.id === groupId);
      expect(found).toBeDefined();
      expect(found.archivedAt).toBeTruthy();

      await dispose();
    });

    test("owner can unarchive a group", async () => {
      const { owner, groupId, dispose } = await createTestGroup(
        users.alice.email, users.alice.password, [], "Unarchive API Test"
      );

      await trpcMutation(owner, "groups.archive", { groupId });
      const res = await trpcMutation(owner, "groups.unarchive", { groupId });
      const body = await res.json();
      expect(body.result?.data?.json?.archivedAt).toBeNull();

      await dispose();
    });

    test("member cannot unarchive a group", async () => {
      const { owner, groupId, memberContexts, dispose } = await createTestGroup(
        users.alice.email, users.alice.password,
        [{ email: users.bob.email, password: users.bob.password }],
        "Unarchive Forbidden Test"
      );

      await trpcMutation(owner, "groups.archive", { groupId });

      const res = await trpcMutation(memberContexts[0], "groups.unarchive", { groupId });
      const body = await res.json();
      expect(body.error).toBeDefined();

      await dispose();
    });

    test("cannot create expense on archived group", async () => {
      const { owner, groupId, memberIds, dispose } = await createTestGroup(
        users.alice.email, users.alice.password, [], "Archive Expense Block"
      );

      await trpcMutation(owner, "groups.archive", { groupId });

      const res = await trpcMutation(owner, "expenses.create", {
        groupId,
        title: "Should Fail",
        amount: 1000,
        paidById: memberIds[users.alice.email],
        splitMode: "EQUAL",
        shares: [{ userId: memberIds[users.alice.email], amount: 1000 }],
      });
      const error = await trpcError(res);
      expect(error?.data?.code).toBe("BAD_REQUEST");
      expect(error?.message).toContain("archived");

      await dispose();
    });

    test("cannot create settlement on archived group", async () => {
      const { owner, groupId, memberIds, memberContexts, dispose } = await createTestGroup(
        users.alice.email, users.alice.password,
        [{ email: users.bob.email, password: users.bob.password }],
        "Archive Settle Block"
      );

      await trpcMutation(owner, "groups.archive", { groupId });

      const res = await trpcMutation(owner, "settlements.create", {
        groupId,
        fromId: memberIds[users.alice.email],
        toId: memberIds[users.bob.email],
        amount: 500,
      });
      const error = await trpcError(res);
      expect(error?.data?.code).toBe("BAD_REQUEST");
      expect(error?.message).toContain("archived");

      await dispose();
    });

    test("cannot update expense on archived group", async () => {
      const { owner, groupId, memberIds, dispose } = await createTestGroup(
        users.alice.email, users.alice.password, [], "Archive Edit Block"
      );

      // Create expense before archiving
      const expRes = await trpcMutation(owner, "expenses.create", {
        groupId,
        title: "Before Archive",
        amount: 1000,
        paidById: memberIds[users.alice.email],
        splitMode: "EQUAL",
        shares: [{ userId: memberIds[users.alice.email], amount: 1000 }],
      });
      const expense = (await expRes.json()).result?.data?.json;

      await trpcMutation(owner, "groups.archive", { groupId });

      const res = await trpcMutation(owner, "expenses.update", {
        groupId,
        expenseId: expense.id,
        title: "Should Fail",
      });
      const error = await trpcError(res);
      expect(error?.data?.code).toBe("BAD_REQUEST");
      expect(error?.message).toContain("archived");

      await dispose();
    });
  });

  // ── UI tests ─────────────────────────────────────────────

  test.describe("UI", () => {
    test("archive button appears in group settings", async ({ page }) => {
      await login(page, users.alice.email, users.alice.password);

      const { groupId, dispose } = await createTestGroup(
        users.alice.email, users.alice.password, [], "Archive UI Settings"
      );

      await page.goto(`/groups/${groupId}/settings`);
      await expect(page.getByRole("button", { name: /Archive group/ })).toBeVisible();

      await dispose();
    });

    test("archiving a group redirects to groups list", async ({ page }) => {
      await login(page, users.alice.email, users.alice.password);

      const { groupId, dispose } = await createTestGroup(
        users.alice.email, users.alice.password, [], "Archive Redirect Test"
      );

      await page.goto(`/groups/${groupId}/settings`);
      page.on("dialog", (dialog) => dialog.accept());
      await page.getByRole("button", { name: /Archive group/ }).click();
      await page.waitForURL("**/groups", { timeout: 10000 });

      await dispose();
    });

    test("archived group not visible in active groups list", async ({ page }) => {
      await login(page, users.alice.email, users.alice.password);

      const { owner, groupId, dispose } = await createTestGroup(
        users.alice.email, users.alice.password, [], "Archive Hidden Test"
      );

      await trpcMutation(owner, "groups.archive", { groupId });

      await page.goto("/en/groups");
      await page.getByPlaceholder("Search groups...").fill("Archive Hidden Test");
      // Should not appear in active list
      await expect(page.getByText("Archive Hidden Test")).not.toBeVisible();

      await dispose();
    });

    test("archived group visible after clicking Archived button", async ({ page }) => {
      await login(page, users.alice.email, users.alice.password);

      const { owner, groupId, dispose } = await createTestGroup(
        users.alice.email, users.alice.password, [], "Archive Toggle Test"
      );

      await trpcMutation(owner, "groups.archive", { groupId });

      await page.goto("/en/groups");
      await page.getByRole("button", { name: /Archived/ }).click();
      await page.getByPlaceholder("Search groups...").fill("Archive Toggle Test");
      await expect(page.getByText("Archive Toggle Test").first()).toBeVisible();

      await dispose();
    });

    test("archived group detail shows archived banner", async ({ page }) => {
      await login(page, users.alice.email, users.alice.password);

      const { owner, groupId, dispose } = await createTestGroup(
        users.alice.email, users.alice.password, [], "Archive Banner Test"
      );

      await trpcMutation(owner, "groups.archive", { groupId });

      await page.goto(`/groups/${groupId}`);
      await expect(page.getByText("This group is archived")).toBeVisible();
      // Add Expense button should be hidden
      await expect(page.getByRole("button", { name: "Add Expense" })).not.toBeVisible();

      await dispose();
    });

    test("unarchive from settings restores group to active list", async ({ page }) => {
      await login(page, users.alice.email, users.alice.password);

      const { owner, groupId, dispose } = await createTestGroup(
        users.alice.email, users.alice.password, [], "Unarchive UI Test"
      );

      await trpcMutation(owner, "groups.archive", { groupId });

      // Go to settings and unarchive
      await page.goto(`/groups/${groupId}/settings`);
      await expect(page.getByText("This group is archived")).toBeVisible();
      await page.getByRole("button", { name: /Unarchive/ }).click();

      // Banner should disappear
      await expect(page.getByText("This group is archived")).not.toBeVisible({ timeout: 5000 });

      // Should appear back in active groups list
      await page.goto("/en/groups");
      await page.getByPlaceholder("Search groups...").fill("Unarchive UI Test");
      await expect(page.getByText("Unarchive UI Test").first()).toBeVisible();

      await dispose();
    });
  });
});
