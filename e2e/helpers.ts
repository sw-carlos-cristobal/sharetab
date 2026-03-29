import { type Page, expect } from "@playwright/test";

// Demo users from seed.ts
export const users = {
  alice: { email: "alice@example.com", password: "password123", name: "Alice Johnson" },
  bob: { email: "bob@example.com", password: "password123", name: "Bob Smith" },
  charlie: { email: "charlie@example.com", password: "password123", name: "Charlie Brown" },
};

/**
 * Login as a user via the UI.
 */
export async function login(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  // Wait for redirect to dashboard
  await page.waitForURL("**/dashboard", { timeout: 15000 });
}

/**
 * Register a new user via the UI.
 */
export async function register(page: Page, name: string, email: string, password: string) {
  await page.goto("/register");
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("**/dashboard", { timeout: 15000 });
}

/**
 * Generate a unique email for test isolation.
 */
export function uniqueEmail(prefix = "test") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`;
}
