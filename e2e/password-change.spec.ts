import { test, expect } from '@playwright/test';
import {
  users,
  testUsers,
  login,
  uniqueEmail,
  register,
  authedContext,
  deleteTestUser,
  trpcQuery,
  trpcResult,
  trpcError,
} from './helpers';
import { outbox, passwordChangedEmails } from './mock-smtp-outbox';

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
      if (process.env.EMAIL_SERVER_HOST && outbox) {
        await expect.poll(() => passwordChangedEmails(email), { timeout: 15000 }).toBe(1);
      }
    } finally {
      await otherDevice.dispose();
      await removeUser(email);
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
      await removeUser(email);
    }
  });
});

async function removeUser(email: string) {
  const admin = await authedContext(users.alice.email, users.alice.password);
  try {
    await deleteTestUser(admin, email);
  } finally {
    await admin.dispose();
  }
}

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
