import { test, expect, type Browser, type Page } from '@playwright/test';
import {
  users,
  login,
  uniqueEmail,
  authedContext,
  trpcMutation,
  trpcQuery,
  trpcResult,
  trpcError,
  deleteTestUser,
} from './helpers';
import { outbox, mailTo, readResetLink, passwordChangedEmails } from './mock-smtp-outbox';

// #397: a forgotten password can be reset, by an emailed link (with SMTP) or a link an admin makes
const hasEmailConfig = !!process.env.EMAIL_SERVER_HOST;
const BASE = process.env.BASE_URL || 'http://localhost:3001';

const OLD_PASSWORD = 'password123';
const NEW_PASSWORD = 'reset-pass-456';

async function registerUser(email: string) {
  const admin = await authedContext(users.alice.email, users.alice.password);
  try {
    const res = await trpcMutation(admin, 'auth.register', { name: 'Reset Test', email, password: OLD_PASSWORD });
    expect(res.ok()).toBe(true);
  } finally {
    await admin.dispose();
  }
}

async function removeUser(email: string) {
  const admin = await authedContext(users.alice.email, users.alice.password);
  try {
    await deleteTestUser(admin, email);
  } finally {
    await admin.dispose();
  }
}

/** Whether these credentials sign in: the session can read its own profile. */
async function signsIn(email: string, password: string) {
  const ctx = await authedContext(email, password);
  try {
    const profile = await trpcResult(await trpcQuery(ctx, 'auth.getProfile'));
    return profile?.email === email;
  } finally {
    await ctx.dispose();
  }
}

/** Opens a reset link in a fresh browser (signed out) and sets the new password. */
async function setPasswordWithLink(browser: Browser, link: string, password: string) {
  // On this test run's server, whatever host the link was built with (NEXTAUTH_URL)
  const { pathname, hash } = new URL(link);
  const url = `${pathname}${hash}`;
  const context = await browser.newContext({ baseURL: BASE });
  const page = await context.newPage();
  try {
    await page.goto(url);
    await page.getByLabel('New password', { exact: true }).fill(password);
    await page.getByLabel('Confirm new password').fill(password);
    await page.getByRole('button', { name: 'Set password' }).click();
    await expect(page.getByTestId('reset-password-done')).toBeVisible();

    // The link works once. A new page: going to the same URL again would only change the fragment
    const again = await context.newPage();
    await again.goto(url);
    await again.getByLabel('New password', { exact: true }).fill('another-pass-789');
    await again.getByLabel('Confirm new password').fill('another-pass-789');
    await again.getByRole('button', { name: 'Set password' }).click();
    await expect(again.getByTestId('reset-password-invalid')).toBeVisible();
  } finally {
    await context.close();
  }
}

/**
 * Makes the pages see these sign-in options, as on a server configured that way. Returns how many
 * responses it changed, so a test can tell the stub matched (on a server already set up that way
 * it would pass without it).
 */
async function withLoginOptions(page: Page, options: { passwordLogin: boolean; passwordReset: boolean }) {
  const stubbed = { count: 0 };
  await page.route('**/api/trpc/**', async (route) => {
    const url = new URL(route.request().url());
    const procedures = url.pathname.replace(/^.*\/api\/trpc\//, '').split(',');
    const index = procedures.indexOf('auth.getLoginOptions');
    if (index === -1) return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    Object.assign(body[index].result.data.json, options);
    stubbed.count += 1;
    // Not `response`: its headers carry the unpatched body's length and encoding
    await route.fulfill({ status: response.status(), json: body });
  });
  return stubbed;
}

async function openForgotPassword(page: Page) {
  await page.goto('/en/login');
  await page.getByRole('link', { name: 'Forgot password?' }).click();
  await expect(page).toHaveURL(/\/en\/forgot-password$/);
}

test.describe('Password reset', () => {
  test('a reset link without a token says so and offers a new one', async ({ page }) => {
    await page.goto('/en/reset-password');
    await expect(page.getByTestId('reset-password-invalid')).toBeVisible();
    await page.getByRole('link', { name: 'Request a new link' }).click();
    await expect(page).toHaveURL(/\/en\/forgot-password$/);
  });

  test('an unknown token is refused when the password is submitted', async ({ page }) => {
    await page.goto(`/en/reset-password#token=${'x'.repeat(43)}`);
    await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
    await page.getByLabel('Confirm new password').fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Set password' }).click();
    await expect(page.getByTestId('reset-password-invalid')).toBeVisible();
  });

  test('without email, "Forgot password?" says to ask the administrator', async ({ page }) => {
    const stubbed = await withLoginOptions(page, { passwordLogin: true, passwordReset: false });
    await openForgotPassword(page);
    await expect(page.getByTestId('forgot-password-ask-admin')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send reset link' })).toHaveCount(0);
    expect(stubbed.count).toBeGreaterThan(0);
  });

  test('with password sign-in off, there is no password to reset', async ({ page }) => {
    const stubbed = await withLoginOptions(page, { passwordLogin: false, passwordReset: false });
    await page.goto('/en/forgot-password');
    await expect(page.getByTestId('forgot-password-login-off')).toBeVisible();
    expect(stubbed.count).toBeGreaterThan(0);
  });

  test('switching language on the reset page keeps the link', async ({ page }) => {
    const token = 'y'.repeat(43);
    await page.goto(`/en/reset-password#token=${token}`);
    await expect(page.getByLabel('New password', { exact: true })).toBeVisible();

    await page.getByTestId('language-switcher').first().click();
    await page.getByRole('menuitem', { name: '🇪🇸 Español' }).click();

    await expect(page).toHaveURL(new RegExp(`/es/reset-password#token=${token}$`));
    await expect(page.getByTestId('reset-password-invalid')).toHaveCount(0);
    await expect(page.locator('#newPassword')).toBeVisible();
  });

  test('a request for an unknown address looks the same as for a known one', async ({ page }) => {
    // CI runs a mock SMTP server: a missing setting there must fail, not skip
    if (process.env.CI) expect(hasEmailConfig, 'EMAIL_SERVER_HOST').toBe(true);
    test.skip(!hasEmailConfig, 'Email server not configured — set EMAIL_SERVER_HOST to enable');
    const knownEmail = uniqueEmail('pwknown');
    const unknownEmail = uniqueEmail('nobody');
    await registerUser(knownEmail);
    try {
      // The unknown address first: once the known address's mail has arrived, any mail the
      // earlier request would have sent has had its chance too
      await openForgotPassword(page);
      await page.getByLabel('Email').fill(unknownEmail);
      await page.getByRole('button', { name: 'Send reset link' }).click();
      const unknown = page.getByTestId('forgot-password-sent');
      await expect(unknown).toBeVisible();
      const unknownText = (await unknown.innerText()).replace(unknownEmail, '<email>');

      await openForgotPassword(page);
      await page.getByLabel('Email').fill(knownEmail);
      await page.getByRole('button', { name: 'Send reset link' }).click();
      const known = page.getByTestId('forgot-password-sent');
      await expect(known).toBeVisible();
      expect((await known.innerText()).replace(knownEmail, '<email>')).toBe(unknownText);

      // Only the known address got mail
      if (outbox) {
        await expect.poll(() => readResetLink(knownEmail), { timeout: 15000 }).not.toBeNull();
        expect(mailTo(unknownEmail)).toHaveLength(0);
      }
    } finally {
      await removeUser(knownEmail);
    }
  });

  test('a user who forgot their password resets it from the emailed link and signs in', async ({ page, browser }) => {
    if (process.env.CI) expect(hasEmailConfig && !!outbox, 'EMAIL_SERVER_HOST and MOCK_SMTP_OUTBOX').toBe(true);
    test.skip(!hasEmailConfig || !outbox, 'Needs EMAIL_SERVER_HOST and scripts/mock-smtp.mjs with MOCK_SMTP_OUTBOX');
    const email = uniqueEmail('pwreset');
    await registerUser(email);
    try {
      await openForgotPassword(page);
      await page.getByLabel('Email').fill(email);
      await page.getByRole('button', { name: 'Send reset link' }).click();
      await expect(page.getByTestId('forgot-password-sent')).toBeVisible();

      // The email goes out after the answer
      let link: string | null = null;
      await expect.poll(() => (link = readResetLink(email)), { timeout: 15000 }).not.toBeNull();

      await setPasswordWithLink(browser, link!, NEW_PASSWORD);
      expect(await signsIn(email, NEW_PASSWORD)).toBe(true);
      expect(await signsIn(email, OLD_PASSWORD)).toBe(false);
      // And the account is told its password changed
      await expect.poll(() => passwordChangedEmails(email), { timeout: 15000 }).toBe(1);
    } finally {
      await removeUser(email);
    }
  });

  test('an admin makes a reset link for a locked-out user, who sets a password with it', async ({ page, browser }) => {
    const email = uniqueEmail('pwadmin');
    await registerUser(email);
    // A session signed in before the reset, e.g. someone else's: the reset ends it
    const earlierSession = await authedContext(email, OLD_PASSWORD);
    try {
      expect((await trpcResult(await trpcQuery(earlierSession, 'auth.getProfile')))?.email).toBe(email);

      await login(page, users.alice.email, users.alice.password);
      await page.goto('/en/admin');
      const userSection = page.locator('section', { has: page.getByRole('heading', { name: 'User Management' }) });
      await expect(userSection).toBeVisible({ timeout: 30000 });
      await userSection.getByPlaceholder('Search by name or email...').fill(email);
      const row = userSection.locator('tr', { hasText: email }).first();
      await row.getByRole('button', { name: /^Create a password reset link for / }).click();

      const dialog = page.getByRole('dialog', { name: 'Password reset link' });
      await expect(dialog).toBeVisible();
      const linkField = dialog.getByTestId('reset-password-link-url');
      await expect(linkField).toHaveValue(/\/en\/reset-password#token=[A-Za-z0-9_-]{43}$/);
      const link = await linkField.inputValue();

      await setPasswordWithLink(browser, link, NEW_PASSWORD);
      expect(await signsIn(email, NEW_PASSWORD)).toBe(true);
      expect(await signsIn(email, OLD_PASSWORD)).toBe(false);
      // Ended: refused as signed out, not some other failure
      const ended = await trpcQuery(earlierSession, 'auth.getProfile');
      expect((await trpcError(ended))?.data?.code).toBe('UNAUTHORIZED');
      // With email configured, the account is told its password changed
      if (hasEmailConfig && outbox) {
        await expect.poll(() => passwordChangedEmails(email), { timeout: 15000 }).toBe(1);
      }

      // Recorded in the audit log, with the user it was for
      const admin = await authedContext(users.alice.email, users.alice.password);
      try {
        const log = await trpcResult(
          await trpcQuery(admin, 'admin.getAuditLog', { limit: 20, action: 'PASSWORD_RESET_LINK_CREATED' }),
        );
        const entry = log?.items?.find(
          (item: { action: string; metadata: { email?: string } | null }) =>
            item.action === 'PASSWORD_RESET_LINK_CREATED' && item.metadata?.email === email,
        );
        expect(entry).toBeDefined();
      } finally {
        await admin.dispose();
      }
    } finally {
      await earlierSession.dispose();
      await removeUser(email);
    }
  });
});
