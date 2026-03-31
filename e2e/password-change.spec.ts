import { test, expect } from "@playwright/test";
import { users, login, uniqueEmail, register } from "./helpers";

test.describe("Password Change — Settings Page", () => {
  // Use fresh users to avoid login rate limiting from other test runs
  const password = "testpass123";

  test("settings page shows change password form", async ({ page }) => {
    const email = uniqueEmail("pwform");
    await register(page, "PW Form User", email, password);
    await page.goto("/settings");
    await expect(page.getByText("Change Password", { exact: true })).toBeVisible();
    await expect(page.locator("#currentPassword")).toBeVisible();
    await expect(page.locator("#newPassword")).toBeVisible();
    await expect(page.locator("#confirmPassword")).toBeVisible();
    await expect(page.getByRole("button", { name: "Change password" })).toBeVisible();
  });

  test("wrong current password shows error", async ({ page }) => {
    const email = uniqueEmail("pwwrong");
    await register(page, "PW Wrong User", email, password);
    await page.goto("/settings");

    await page.locator("#currentPassword").fill("wrongpassword");
    await page.locator("#newPassword").fill("newpass123");
    await page.locator("#confirmPassword").fill("newpass123");
    await page.getByRole("button", { name: "Change password" }).click();

    await expect(page.getByText("Current password is incorrect")).toBeVisible({ timeout: 10000 });
  });

  test("mismatched passwords shows inline warning", async ({ page }) => {
    const email = uniqueEmail("pwmismatch");
    await register(page, "PW Mismatch User", email, password);
    await page.goto("/settings");

    await page.locator("#newPassword").fill("newpass123");
    await page.locator("#confirmPassword").fill("different456");

    await expect(page.getByText("Passwords do not match")).toBeVisible();
  });

  test("successful password change and login with new password", async ({ page }) => {
    // Register a fresh user so we don't break seed data
    const email = uniqueEmail("pwchange");
    await register(page, "PW Test User", email, "oldpass123");

    await page.goto("/settings");
    await page.locator("#currentPassword").fill("oldpass123");
    await page.locator("#newPassword").fill("newpass456");
    await page.locator("#confirmPassword").fill("newpass456");
    await page.getByRole("button", { name: "Change password" }).click();

    await expect(page.getByText("Password changed!")).toBeVisible({ timeout: 10000 });

    // Sign out and login with new password
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill("newpass456");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL("**/dashboard", { timeout: 15000 });
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  });
});

test.describe("Forgot Password — Login Page", () => {
  test("login page shows forgot password link", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByText("Forgot password?")).toBeVisible();
  });

  test("clicking forgot password switches to magic link mode", async ({ page }) => {
    await page.goto("/login");
    await page.getByText("Forgot password?").click();

    await expect(page.getByText("We'll send you a magic link")).toBeVisible();
    await expect(page.getByText("change your password from Settings")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send magic link" })).toBeVisible();
    await expect(page.getByLabel("Password")).not.toBeVisible();
  });
});
