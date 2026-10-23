import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { test, expect, type Browser, type Page } from '@playwright/test';
import {
  users,
  login,
  uniqueEmail,
  authedContext,
  trpcMutation,
  trpcQuery,
  trpcResult,
  deleteTestUser,
} from './helpers';

// #397: a forgotten password can be reset, by an emailed link (with SMTP) or a link an admin makes
const hasEmailConfig = !!process.env.EMAIL_SERVER_HOST;
// Where scripts/mock-smtp.mjs writes the mail it accepts (CI sets it)
const outbox = process.env.MOCK_SMTP_OUTBOX;

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
async function setPasswordWithLink(browser: Browser, url: string, password: string) {
  const context = await browser.newContext();
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

/** The newest reset link mock-smtp received for this address. */
function readResetLink(email: string): string | null {
  const files = readdirSync(outbox!)
    .filter((f) => f.endsWith('.eml'))
    .sort()
    .reverse();
  for (const file of files) {
    const raw = readFileSync(join(outbox!, file), 'utf-8');
    if (!raw.includes(`X-Rcpt-To: ${email}`)) continue;
    // Undo quoted-printable: soft line breaks, then =XX escapes
    const decoded = raw
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    const link = decoded.match(/https?:\/\/[^\s"<]+\/reset-password#token=[A-Za-z0-9_-]{43}/);
    if (link) return link[0];
  }
  return null;
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
    test.skip(hasEmailConfig, 'Email is configured — this covers instances without SMTP');
    await openForgotPassword(page);
    await expect(page.getByTestId('forgot-password-ask-admin')).toBeVisible();
  });

  test('a request for an unknown address looks the same as for a known one', async ({ page }) => {
    test.skip(!hasEmailConfig, 'Email server not configured — set EMAIL_SERVER_HOST to enable');
    const knownEmail = uniqueEmail('pwknown');
    await registerUser(knownEmail);
    try {
      await openForgotPassword(page);
      await page.getByLabel('Email').fill(knownEmail);
      await page.getByRole('button', { name: 'Send reset link' }).click();
      const known = page.getByTestId('forgot-password-sent');
      await expect(known).toBeVisible();
      const knownText = (await known.innerText()).replace(knownEmail, '<email>');

      const unknownEmail = uniqueEmail('nobody');
      await openForgotPassword(page);
      await page.getByLabel('Email').fill(unknownEmail);
      await page.getByRole('button', { name: 'Send reset link' }).click();
      const unknown = page.getByTestId('forgot-password-sent');
      await expect(unknown).toBeVisible();
      expect((await unknown.innerText()).replace(unknownEmail, '<email>')).toBe(knownText);
    } finally {
      await removeUser(knownEmail);
    }
  });

  test('a user who forgot their password resets it from the emailed link and signs in', async ({ page, browser }) => {
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
    } finally {
      await removeUser(email);
    }
  });

  test('an admin makes a reset link for a locked-out user, who sets a password with it', async ({ page, browser }) => {
    const email = uniqueEmail('pwadmin');
    await registerUser(email);
    try {
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

      // Recorded in the audit log, with the user it was for
      const admin = await authedContext(users.alice.email, users.alice.password);
      try {
        const log = await trpcResult(await trpcQuery(admin, 'admin.getAuditLog', { limit: 20 }));
        const entry = log?.items?.find(
          (item: { action: string; metadata: { email?: string } | null }) =>
            item.action === 'PASSWORD_RESET_LINK_CREATED' && item.metadata?.email === email,
        );
        expect(entry).toBeDefined();
      } finally {
        await admin.dispose();
      }
    } finally {
      await removeUser(email);
    }
  });
});
