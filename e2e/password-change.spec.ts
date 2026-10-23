import { test, expect } from '@playwright/test';
import {
  users,
  testUsers,
  login,
  uniqueEmail,
  register,
  authedContext,
  trpcQuery,
  trpcResult,
  trpcError,
  removeTestUser,
} from './helpers';
import { expectOnePasswordChangedEmail } from './mock-smtp-outbox';

test.describe('Password Change — Settings Page', () => {
  test('settings page shows change password form', async ({ page }) => {
    await login(page, testUsers.password.email, testUsers.password.password);
    await page.goto('/en/settings');
    await expect(page.getByText('Change Password', { exact: true })).toBeVisible();
    await expect(page.locator('#currentPassword')).toBeVisible();
    await expect(page.locator('#newPassword')).toBeVisible();
    await expect(page.locator('#confirmPassword')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Change password' })).toBeVisible();
  });

  test('wrong current password shows error', async ({ page }) => {
    await login(page, testUsers.password.email, testUsers.password.password);
    await page.goto('/en/settings');
    await page.locator('#currentPassword').fill('wrong-password');
    await page.locator('#newPassword').fill('newpass456');
    await page.locator('#confirmPassword').fill('newpass456');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByText(/incorrect|wrong|invalid/i)).toBeVisible({ timeout: 5000 });
  });

  test('offers a reset for a forgotten current password (#397)', async ({ page }) => {
    await login(page, testUsers.password.email, testUsers.password.password);
    await page.goto('/en/settings');
    await page.getByRole('link', { name: 'Forgot your current password?' }).click();
    await expect(page).toHaveURL(/\/en\/forgot-password$/);
  });

  test('mismatched passwords shows inline warning', async ({ page }) => {
    await login(page, testUsers.password.email, testUsers.password.password);
    await page.goto('/en/settings');
    await page.locator('#newPassword').fill('newpass456');
    await page.locator('#confirmPassword').fill('different789');
    await expect(page.getByText(/match/i)).toBeVisible();
  });

  test('successful password change and login with new password', async ({ page }) => {
    // This test needs its own user since it changes the password
    const email = uniqueEmail('pwchange');
    const oldPassword = 'testpass123';
    const newPassword = 'newpass456';

    await register(page, 'PW Change User', email, oldPassword);
    // Another device signed in before the change (#397)
    const otherDevice = await authedContext(email, oldPassword);
    try {
      expect((await trpcResult(await trpcQuery(otherDevice, 'auth.getProfile')))?.email).toBe(email);
      await page.goto('/en/settings');

      await page.locator('#currentPassword').fill(oldPassword);
      await page.locator('#newPassword').fill(newPassword);
      await page.locator('#confirmPassword').fill(newPassword);
      await page.getByRole('button', { name: 'Change password' }).click();

      await expect(page.getByTestId('password-changed')).toBeVisible();
      await expect(page.getByTestId('password-sign-in-again')).toHaveCount(0);

      // This device signed in again with the new password; the other one was signed out
      const session = await (await page.request.get('/api/auth/session')).json();
      expect(session?.user?.email).toBe(email);
      const ended = await trpcQuery(otherDevice, 'auth.getProfile');
      expect((await trpcError(ended))?.data?.code).toBe('UNAUTHORIZED');

      // Verify new password works by logging in via API and accessing a protected route
      const ctx = await authedContext(email, newPassword);
      try {
        const res = await trpcQuery(ctx, 'groups.list');
        const data = await trpcResult(res);
        expect(data).toBeDefined();
      } finally {
        await ctx.dispose();
      }

      // With email configured, the account is told its password changed
      await expectOnePasswordChangedEmail(email);
    } finally {
      await otherDevice.dispose();
      await removeTestUser(email);
    }
  });

  test('says to sign in again when signing back in after the change fails (#397)', async ({ page }) => {
    const email = uniqueEmail('pwagain');
    await register(page, 'PW Again User', email, 'testpass123');
    try {
      await page.goto('/en/settings');
      // As if the new password were refused: the change itself goes through
      await page.route('**/api/auth/callback/credentials**', (route) =>
        route.fulfill({
          status: 200,
          json: { url: new URL('/api/auth/error?error=CredentialsSignin', page.url()).href },
        }),
      );
      await page.locator('#currentPassword').fill('testpass123');
      await page.locator('#newPassword').fill('newpass456');
      await page.locator('#confirmPassword').fill('newpass456');
      await page.getByRole('button', { name: 'Change password' }).click();

      await expect(page.getByTestId('password-changed')).toBeVisible();
      const notice = page.getByTestId('password-sign-in-again');
      await expect(notice).toBeVisible();
      await expect(notice.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/en/login');
    } finally {
      await removeTestUser(email);
    }
  });

  test('an admin impersonating someone changes their password and stays signed in as the admin (#397)', async ({
    page,
    browser,
  }) => {
    const email = uniqueEmail('pwimpersonated');
    const signUp = await browser.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3001' });
    try {
      await register(await signUp.newPage(), 'PW Impersonated', email, 'testpass123');
    } finally {
      await signUp.close();
    }
    const admin = await authedContext(users.alice.email, users.alice.password);
    try {
      const listed = await trpcResult(await trpcQuery(admin, 'admin.listUsers', { search: email, limit: 1 }));
      const userId = listed.users[0].id;

      await login(page, users.alice.email, users.alice.password);
      const start = await page.request.post('/api/admin/impersonate', { data: { userId } });
      expect(start.ok()).toBe(true);
      try {
        await page.goto('/en/settings');
        // The impersonated user's Settings
        await expect(page.locator('#email')).toHaveValue(email);
        await page.locator('#currentPassword').fill('testpass123');
        await page.locator('#newPassword').fill('newpass456');
        await page.locator('#confirmPassword').fill('newpass456');
        await page.getByRole('button', { name: 'Change password' }).click();

        await expect(page.getByTestId('password-changed')).toBeVisible();
        await expect(page.getByTestId('password-sign-in-again')).toHaveCount(0);
        // Still the admin's own session: the change ended the user's sessions, not this one
        const session = await (await page.request.get('/api/auth/session')).json();
        expect(session?.user?.email).toBe(users.alice.email);
      } finally {
        await page.request.delete('/api/admin/impersonate');
      }
    } finally {
      await admin.dispose();
      await removeTestUser(email);
    }
  });
});

test.describe('Forgot Password — Login Page', () => {
  test('login page shows forgot password link', async ({ page }) => {
    await page.goto('/en/login');
    await expect(page.getByText('Forgot password?')).toBeVisible();
  });

  test('clicking forgot password opens the reset request page (#397)', async ({ page }) => {
    await page.goto('/en/login');
    await page.getByText('Forgot password?').click();
    await expect(page).toHaveURL(/\/en\/forgot-password$/);
    await expect(page.getByText('Forgot your password?')).toBeVisible();
  });
});
