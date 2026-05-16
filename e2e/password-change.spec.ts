import { test, expect } from "@playwright/test";
import { users, testUsers, login, uniqueEmail, register, authedContext, deleteTestUser } from "./helpers";

test.describe("Password Change — Settings Page", () => {
  test("settings page shows change password form", async ({ page }) => {
    await login(page, testUsers.password.email, testUsers.password.password);
    await page.goto("/en/settings");
    await expect(page.getByText("Change Password", { exact: true })).toBeVisible();
    await expect(page.locator("#currentPassword")).toBeVisible();
    await expect(page.locator("#newPassword")).toBeVisible();
    await expect(page.locator("#confirmPassword")).toBeVisible();
    await expect(page.getByRole("button", { name: "Change password" })).toBeVisible();
  });

  test("wrong current password shows error", async ({ page }) => {
    await login(page, testUsers.password.email, testUsers.password.password);
    await page.goto("/en/settings");
    await page.locator("#currentPassword").fill("wrong-password");
    await page.locator("#newPassword").fill("newpass456");
    await page.locator("#confirmPassword").fill("newpass456");
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByText(/incorrect|wrong|invalid/i)).toBeVisible({ timeout: 5000 });
  });

  test("mismatched passwords shows inline warning", async ({ page }) => {
    await login(page, testUsers.password.email, testUsers.password.password);
    await page.goto("/en/settings");
    await page.locator("#newPassword").fill("newpass456");
    await page.locator("#confirmPassword").fill("different789");
    await expect(page.getByText(/match/i)).toBeVisible();
  });

  test("successful password change and login with new password", async ({ page }) => {
    // This test needs its own user since it changes the password
    const email = uniqueEmail("pwchange");
    const oldPassword = "testpass123";
    const newPassword = "newpass456";

    await register(page, "PW Change User", email, oldPassword);
    await page.goto("/en/settings");

    await page.locator("#currentPassword").fill(oldPassword);
    await page.locator("#newPassword").fill(newPassword);
    await page.locator("#confirmPassword").fill(newPassword);
    await page.getByRole("button", { name: "Change password" }).click();

    await expect(page.getByText(/changed|updated|success/i)).toBeVisible({ timeout: 5000 });

    // Sign out
    await page.getByText("Sign out").click();
    await page.waitForURL("**/login", { timeout: 10000 });

    // Login with new password
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(newPassword);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL("**/dashboard", { timeout: 10000 });

    // Clean up the test user
    const admin = await authedContext(users.alice.email, users.alice.password);
    await deleteTestUser(admin, email);
    await admin.dispose();
  });
});

test.describe("Forgot Password — Login Page", () => {
  test("login page shows forgot password link", async ({ page }) => {
    await page.goto("/en/login");
    await expect(page.getByText("Forgot password?")).toBeVisible();
  });

  test("clicking forgot password switches to magic link mode", async ({ page }) => {
    await page.goto("/en/login");
    await page.getByText("Forgot password?").click();
    await expect(page.getByRole("button", { name: "Send magic link" })).toBeVisible();
    await expect(page.locator("#password")).not.toBeVisible();
  });
});
