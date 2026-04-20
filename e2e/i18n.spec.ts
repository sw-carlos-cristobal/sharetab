import { test, expect } from "@playwright/test";
import { users, login } from "./helpers";

test.describe("i18n Language Switching", () => {
  test("switch from English to Spanish and back on login page", async ({ page }) => {
    await page.goto("/en/login");
    await expect(page.getByText("Welcome back")).toBeVisible();

    // Open language switcher and pick Spanish
    await page.getByRole("button", { name: "Change language" }).click();
    await page.getByRole("menuitem", { name: "🇪🇸 Español" }).click();
    await page.waitForURL("**/es/login");

    // Verify Spanish translations
    await expect(page.getByText("Bienvenido de nuevo")).toBeVisible();
    await expect(page.getByText("Inicia sesión en tu cuenta de ShareTab")).toBeVisible();
    await expect(page.getByLabel("Correo electrónico")).toBeVisible();
    await expect(page.getByLabel("Contraseña")).toBeVisible();
    await expect(page.getByRole("button", { name: "Iniciar sesión", exact: true })).toBeVisible();

    // Switch back to English
    await page.getByRole("button", { name: "Change language" }).click();
    await page.getByRole("menuitem", { name: "🇺🇸 English" }).click();
    await page.waitForURL("**/en/login");

    // Verify English restored
    await expect(page.getByText("Welcome back")).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  });

  test("switch from English to Spanish and back on register page", async ({ page }) => {
    await page.goto("/en/register");
    await expect(page.getByText("Create your account")).toBeVisible();

    // Switch to Spanish
    await page.getByRole("button", { name: "Change language" }).click();
    await page.getByRole("menuitem", { name: "🇪🇸 Español" }).click();
    await page.waitForURL("**/es/register");

    await expect(page.getByText("Crea tu cuenta")).toBeVisible();
    await expect(page.getByText("Empieza a dividir gastos con amigos")).toBeVisible();
    await expect(page.getByLabel("Nombre")).toBeVisible();
    await expect(page.getByRole("button", { name: "Crear cuenta" })).toBeVisible();

    // Switch back to English
    await page.getByRole("button", { name: "Change language" }).click();
    await page.getByRole("menuitem", { name: "🇺🇸 English" }).click();
    await page.waitForURL("**/en/register");

    await expect(page.getByText("Create your account")).toBeVisible();
    await expect(page.getByRole("button", { name: "Create account" })).toBeVisible();
  });

  test("switch language on authenticated dashboard page", async ({ page }) => {
    // Use desktop viewport so sidebar language switcher is directly accessible
    await page.setViewportSize({ width: 1280, height: 720 });
    await login(page, users.alice.email, users.alice.password);
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

    // Click sidebar language switcher
    await page.getByRole("button", { name: "Change language" }).click();
    await page.getByRole("menuitem", { name: "🇪🇸 Español" }).click();
    await page.waitForURL("**/es/dashboard");

    // Verify Spanish dashboard
    await expect(page.getByRole("heading", { name: "Panel" })).toBeVisible();
    await expect(page.getByText("Te deben").first()).toBeVisible();
    await expect(page.getByText("Debes").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Grupos" })).toBeVisible();

    // Switch back to English
    await page.getByRole("button", { name: "Change language" }).click();
    await page.getByRole("menuitem", { name: "🇺🇸 English" }).click();
    await page.waitForURL("**/en/dashboard");

    // Verify English restored
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByText("You are owed").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Groups" })).toBeVisible();
  });

  test("locale prefix is preserved in navigation links", async ({ page }) => {
    await page.goto("/es/login");
    await expect(page.getByText("Bienvenido de nuevo")).toBeVisible();

    const createLink = page.getByRole("link", { name: "Crear una" });
    await expect(createLink).toHaveAttribute("href", "/es/register");

    const splitLink = page.getByRole("link", { name: "Dividir sin cuenta" });
    await expect(splitLink).toHaveAttribute("href", "/es/split");
  });

  test("root URL redirects to locale-prefixed URL", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/(en|es)\//);
  });
});
