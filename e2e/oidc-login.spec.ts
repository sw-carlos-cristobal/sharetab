import { test, expect } from '@playwright/test';

// These run without an identity provider: they cover the login page's
// defaults and how it reports errors that Auth.js redirects back with.
const oidcConfigured = !!(process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID && process.env.OIDC_CLIENT_SECRET);

test.describe('OIDC login page', () => {
  test('no SSO button without OIDC config; password login unchanged', async ({ page }) => {
    test.skip(oidcConfigured, 'OIDC is configured in this environment');

    await page.goto('/en/login');
    await expect(page.getByLabel('Password')).toBeVisible();
    await expect(page.getByTestId('oidc-sign-in')).toHaveCount(0);
    await expect(page.getByTestId('login-error')).toHaveCount(0);
  });

  test('shows the message for an OIDC denial code', async ({ page }) => {
    await page.goto('/en/login?error=OidcSessionActive');
    await expect(page.getByTestId('login-error')).toContainText("You're already signed in");
  });

  test('shows the account-not-linked message for Auth.js OAuthAccountNotLinked', async ({ page }) => {
    await page.goto('/en/login?error=OAuthAccountNotLinked');
    await expect(page.getByTestId('login-error')).toContainText('An account with this email already exists');
  });

  test('shows a generic message for unknown codes', async ({ page }) => {
    await page.goto('/en/login?error=constructor');
    await expect(page.getByTestId('login-error')).toContainText('Sign-in failed');
  });

  test('keeps the error when the locale prefix is added by redirect', async ({ page }) => {
    // Auth.js redirects to the unprefixed pages.error path (/login).
    await page.goto('/login?error=OidcRegistrationDisabled');
    await expect(page).toHaveURL(/\/[a-z]{2}(-[A-Z]{2})?\/login\?error=OidcRegistrationDisabled/);
    await expect(page.getByTestId('login-error')).toBeVisible();
  });
});
