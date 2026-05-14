import { test, expect } from "@playwright/test";

const hasEmailConfig = !!process.env.EMAIL_SERVER_HOST;

test.describe("Magic Link Auth", () => {
  test("login page shows magic link option", async ({ page }) => {
    await page.goto("/en/login");
    await expect(page.getByRole("button", { name: "Sign in with email link" })).toBeVisible();
  });

  test("clicking magic link button switches to email-only mode", async ({ page }) => {
    await page.goto("/en/login");
    await page.getByRole("button", { name: "Sign in with email link" }).click();

    // Should show magic link form
    await expect(page.getByText("We'll send you a magic link")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send magic link" })).toBeVisible();

    // Password field should be hidden
    await expect(page.getByLabel("Password")).not.toBeVisible();

    // Should show option to switch back
    await expect(page.getByRole("button", { name: "Sign in with password" })).toBeVisible();
  });

  test("switching back to password mode restores password field", async ({ page }) => {
    await page.goto("/en/login");

    // Switch to magic link mode
    await page.getByRole("button", { name: "Sign in with email link" }).click();
    await expect(page.getByLabel("Password")).not.toBeVisible();

    // Switch back to password mode
    await page.getByRole("button", { name: "Sign in with password" }).click();
    await expect(page.getByLabel("Password")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  });

  test("magic link requires email field", async ({ page }) => {
    await page.goto("/en/login");
    await page.getByRole("button", { name: "Sign in with email link" }).click();

    // Try to submit without email
    await page.getByRole("button", { name: "Send magic link" }).click();

    // Should stay on login page (HTML validation prevents submission)
    expect(page.url()).toContain("/login");
  });

  // This test only runs when email is configured — it actually sends an email
  test("sending magic link redirects to verify-request page", async ({ page }) => {
    test.skip(!hasEmailConfig, "Email server not configured — set EMAIL_SERVER_HOST to enable");

    await page.goto("/en/login");
    await page.getByRole("button", { name: "Sign in with email link" }).click();
    await page.getByLabel("Email").fill("auth.cristobal@gmail.com");
    await page.getByRole("button", { name: "Send magic link" }).click();

    // Should redirect to verify-request page
    await page.waitForURL("**/verify-request", { timeout: 15000 });
    await expect(page.getByText("Check your email")).toBeVisible();
    await expect(page.getByText("sign-in link")).toBeVisible();
  });

  test("verify-request page has back to sign in link", async ({ page }) => {
    test.skip(!hasEmailConfig, "Email server not configured — set EMAIL_SERVER_HOST to enable");

    await page.goto("/en/login");
    await page.getByRole("button", { name: "Sign in with email link" }).click();
    await page.getByLabel("Email").fill("auth.cristobal@gmail.com");
    await page.getByRole("button", { name: "Send magic link" }).click();
    await page.waitForURL("**/verify-request", { timeout: 15000 });

    await expect(page.getByText("Back to sign in")).toBeVisible();
  });
});
