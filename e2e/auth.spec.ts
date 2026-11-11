import { test, expect } from '@playwright/test';
import { users, login, uniqueEmail, trpcMutation, trpcError, removeTestUser } from './helpers';

test.describe('Authentication', () => {
  // ── Registration ──────────────────────────────────────────

  test.describe('Registration', () => {
    test('1.1.1 — register new user', async ({ page }) => {
      const email = uniqueEmail('reg');
      await page.goto('/en/register');
      await page.getByLabel('Name').fill('New Test User');
      await page.getByLabel('Email').fill(email);
      await page.getByLabel('Password').fill('testpass123');
      await page.getByRole('button', { name: 'Create account' }).click();
      await page.waitForURL(/\/en\/dashboard$/, { timeout: 15000 });
      await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    });

    test('1.1.2 — register duplicate email shows error', async ({ page }) => {
      await page.goto('/en/register');
      await page.getByLabel('Name').fill('Duplicate');
      await page.getByLabel('Email').fill(users.alice.email);
      await page.getByLabel('Password').fill('testpass123');
      await page.getByRole('button', { name: 'Create account' }).click();
      await expect(page.getByText(/already exists/i)).toBeVisible({ timeout: 10000 });
    });

    test('1.1.3 — short password prevented by HTML validation', async ({ page }) => {
      await page.goto('/en/register');
      await page.getByLabel('Name').fill('Short');
      await page.getByLabel('Email').fill(uniqueEmail('short'));
      await page.getByLabel('Password').fill('abc');
      await page.getByRole('button', { name: 'Create account' }).click();
      // Should stay on register page (HTML minlength=6 prevents submission)
      await expect(page).toHaveURL(/register/);
    });

    // #265: the server refuses a name that's only spaces (#270), and the form said only
    // "Registration failed. Please try again.", which no retry fixes
    test('a name that is only spaces is refused on the name field', async ({ page }) => {
      await page.goto('/en/register');
      await page.getByLabel('Name').fill('   ');
      await page.getByLabel('Email').fill(uniqueEmail('blank'));
      await page.getByLabel('Password').fill('testpass123');
      await page.getByRole('button', { name: 'Create account' }).click();

      await expect(page.getByText('Enter your name.')).toBeVisible();
      await expect(page.getByLabel('Name')).toHaveAttribute('aria-invalid', 'true');
      await expect(page.getByText('Registration failed')).toHaveCount(0);
      await expect(page).toHaveURL(/register/);

      await page.getByLabel('Name').fill('Real Name');
      await expect(page.getByText('Enter your name.')).toHaveCount(0);
    });

    // #456: bcrypt reads only a password's first 72 bytes, and a character outside ASCII takes 2 to 4 bytes
    test('a password over 72 bytes is refused with its own message; 72 bytes of multi-byte characters work', async ({
      page,
    }) => {
      const email = uniqueEmail('long');
      // 25 characters of 3 bytes each: fewer than the 100 characters the form used to take
      const tooLong = 'パ'.repeat(25);
      // Registrations the page sends (the direct API call below doesn't go through the page)
      let registerRequests = 0;
      await page.route(
        (url) =>
          url.pathname
            .replace(/^.*\/api\/trpc\//, '')
            .split(',')
            .includes('auth.register'),
        (route) => {
          registerRequests += 1;
          return route.continue();
        },
      );
      try {
        await page.goto('/en/register');
        await page.getByLabel('Name').fill('Long Password');
        await page.getByLabel('Email').fill(email);
        await page.getByLabel('Password').fill(tooLong);
        await expect(page.getByText(/^Use a shorter password: at most 72 bytes\./)).toBeVisible();
        await expect(page.getByLabel('Password')).toHaveAttribute('aria-invalid', 'true');
        // Not sent, as the request count at the end checks: the server would refuse it, and the
        // form would say only "Registration failed"
        await page.getByRole('button', { name: 'Create account' }).click();

        // The server refuses it with the same message
        const error = await trpcError(
          await trpcMutation(page.request, 'auth.register', { name: 'Long Password', email, password: tooLong }),
        );
        expect(error?.data?.messageKey).toBe('passwordTooLong');
        expect(error?.message).toMatch(/^Use a shorter password: at most 72 bytes\./);

        // 24 of them: 72 bytes. The form signs in with it once the account is made
        await page.getByLabel('Password').fill('パ'.repeat(24));
        await expect(page.getByText(/at most 72 bytes/)).toHaveCount(0);
        await page.getByRole('button', { name: 'Create account' }).click();
        await page.waitForURL(/\/en\/dashboard$/, { timeout: 15000 });
        // Only this one reached the server: the refused click above sent nothing
        expect(registerRequests).toBe(1);
      } finally {
        await removeTestUser(email);
      }
    });
  });

  // ── Login ─────────────────────────────────────────────────

  test.describe('Login', () => {
    test('7.1.1 — successful login redirects to dashboard', async ({ page }) => {
      await login(page, users.alice.email, users.alice.password);
      await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
      await expect(page.getByText('Alice Johnson')).toBeVisible();
    });

    test('7.1.2 — wrong password shows error', async ({ page }) => {
      await page.goto('/en/login');
      await page.getByLabel('Email').fill(users.alice.email);
      await page.getByLabel('Password').fill('wrongpassword');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.getByText('Invalid email or password')).toBeVisible({ timeout: 15000 });
      await expect(page).toHaveURL(/\/en\/login/);
    });

    test('1.2.3 — non-existent email shows error', async ({ page }) => {
      await page.goto('/en/login');
      await page.getByLabel('Email').fill('nobody@nobody.com');
      await page.getByLabel('Password').fill('whatever123');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.getByText('Invalid email or password')).toBeVisible({ timeout: 15000 });
    });

    test('a sign-in refused by the login limit says how long to wait (#401)', async ({ page }) => {
      await page.goto('/en/login');
      // Auth.js's answer when the limit refuses: CI's limits are too high to reach for real
      await page.route('**/api/auth/callback/credentials**', (route) =>
        route.fulfill({
          status: 200,
          json: { url: new URL('/login?error=CredentialsSignin&code=rate_limited%3A5', page.url()).href },
        }),
      );
      await page.getByLabel('Email').fill(users.alice.email);
      await page.getByLabel('Password').fill(users.alice.password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.getByText('Too many sign-in attempts. Try again in 5 minutes.')).toBeVisible({
        timeout: 15000,
      });
      await expect(page.getByText('Invalid email or password')).toHaveCount(0);
      await expect(page).toHaveURL(/\/en\/login/);
    });

    test('7.1.3 — navigate to register page', async ({ page }) => {
      await page.goto('/en/login');
      await page.getByRole('link', { name: 'Create one' }).click();
      await expect(page).toHaveURL(/\/en\/register/);
      await expect(page.getByText('Create your account')).toBeVisible();
    });
  });

  // ── Session & Middleware ──────────────────────────────────

  test.describe('Session & Middleware', () => {
    test('1.3.1 — dashboard redirects to login without auth', async ({ page }) => {
      await page.goto('/en/dashboard');
      await expect(page).toHaveURL(/\/(en|es)\/login/);
    });

    test('1.3.2 — groups redirects to login without auth', async ({ page }) => {
      await page.goto('/en/groups');
      await expect(page).toHaveURL(/\/(en|es)\/login/);
    });

    test('1.3.3 — login page is accessible', async ({ page }) => {
      await page.goto('/en/login');
      await expect(page.getByText('Welcome back')).toBeVisible();
    });
  });
});
