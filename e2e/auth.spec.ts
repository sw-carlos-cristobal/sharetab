import { test, expect } from "@playwright/test";
import { users, login, uniqueEmail } from "./helpers";

test.describe("Authentication", () => {
  // ── Registration ──────────────────────────────────────────

  test.describe("Registration", () => {
    test("1.1.1 — register new user", async ({ page }) => {
      const email = uniqueEmail("reg");
      await page.goto("/register");
      await page.getByLabel("Name").fill("New Test User");
      await page.getByLabel("Email").fill(email);
      await page.getByLabel("Password").fill("testpass123");
      await page.getByRole("button", { name: "Create account" }).click();
      await page.waitForURL("**/dashboard", { timeout: 15000 });
      await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    });

    test("1.1.2 — register duplicate email shows error", async ({ page }) => {
      await page.goto("/register");
      await page.getByLabel("Name").fill("Duplicate");
      await page.getByLabel("Email").fill(users.alice.email);
      await page.getByLabel("Password").fill("testpass123");
      await page.getByRole("button", { name: "Create account" }).click();
      await expect(page.getByText(/already exists/i)).toBeVisible({ timeout: 10000 });
    });

    test("1.1.3 — short password prevented by HTML validation", async ({ page }) => {
      await page.goto("/register");
      await page.getByLabel("Name").fill("Short");
      await page.getByLabel("Email").fill(uniqueEmail("short"));
      await page.getByLabel("Password").fill("abc");
      await page.getByRole("button", { name: "Create account" }).click();
      // Should stay on register page (HTML minlength=6 prevents submission)
      await expect(page).toHaveURL(/register/);
    });
  });

  // ── Login ─────────────────────────────────────────────────

  test.describe("Login", () => {
    test("7.1.1 — successful login redirects to dashboard", async ({ page }) => {
      await login(page, users.alice.email, users.alice.password);
      await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
      await expect(page.getByText("Alice Johnson")).toBeVisible();
    });

    test("7.1.2 — wrong password shows error", async ({ page }) => {
      await page.goto("/login");
      await page.getByLabel("Email").fill(users.alice.email);
      await page.getByLabel("Password").fill("wrongpassword");
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page.getByText("Invalid email or password")).toBeVisible({ timeout: 15000 });
      await expect(page).toHaveURL(/login/);
    });

    test("1.2.3 — non-existent email shows error", async ({ page }) => {
      await page.goto("/login");
      await page.getByLabel("Email").fill("nobody@nobody.com");
      await page.getByLabel("Password").fill("whatever123");
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page.getByText("Invalid email or password")).toBeVisible({ timeout: 15000 });
    });

    test("7.1.3 — navigate to register page", async ({ page }) => {
      await page.goto("/login");
      await page.getByRole("link", { name: "Create one" }).click();
      await expect(page).toHaveURL(/register/);
      await expect(page.getByText("Create an account")).toBeVisible();
    });
  });

  // ── Session & Middleware ──────────────────────────────────

  test.describe("Session & Middleware", () => {
    test("1.3.1 — dashboard redirects to login without auth", async ({ page }) => {
      await page.goto("/dashboard");
      await expect(page).toHaveURL(/login/);
    });

    test("1.3.2 — groups redirects to login without auth", async ({ page }) => {
      await page.goto("/groups");
      await expect(page).toHaveURL(/login/);
    });

    test("1.3.3 — login page is accessible", async ({ page }) => {
      await page.goto("/login");
      await expect(page.getByText("Welcome back")).toBeVisible();
    });
  });
});
