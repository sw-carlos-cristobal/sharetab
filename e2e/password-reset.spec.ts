import { test, expect, request, type Browser, type Page } from '@playwright/test';
import {
  users,
  login,
  uniqueEmail,
  authedContext,
  trpcMutation,
  trpcQuery,
  trpcResult,
  trpcError,
  removeTestUser,
} from './helpers';
import { outbox, mailTo, readResetLink, expectOnePasswordChangedEmail } from './mock-smtp-outbox';

// #397: a forgotten password can be reset, by an emailed link (with SMTP) or a link an admin makes
const hasEmailConfig = !!process.env.EMAIL_SERVER_HOST;
const BASE = process.env.BASE_URL || 'http://localhost:3001';

const OLD_PASSWORD = 'password123';
const NEW_PASSWORD = 'reset-pass-456';

/** Registers a user with OLD_PASSWORD and returns their id. */
async function registerUser(email: string): Promise<string> {
  const admin = await authedContext(users.alice.email, users.alice.password);
  try {
    const res = await trpcMutation(admin, 'auth.register', { name: 'Reset Test', email, password: OLD_PASSWORD });
    expect(res.ok()).toBe(true);
    return (await res.json()).result.data.json.id;
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
    // The used token leaves the address bar
    await expect(page).toHaveURL(/\/reset-password#done$/);

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
    // Not `response`: its headers carry the unpatched body's length and encoding
    await route.fulfill({ status: response.status(), json: body });
    stubbed.count += 1;
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

  test('a link used while another is pasted into the tab leaves the other one ready to use', async ({ page }) => {
    const email = uniqueEmail('pwswap');
    const userId = await registerUser(email);
    let admin: Awaited<ReturnType<typeof authedContext>> | undefined;
    try {
      admin = await authedContext(users.alice.email, users.alice.password);
      const made = await trpcMutation(admin, 'admin.createPasswordResetLink', { userId });
      const { token } = (await made.json()).result.data.json;
      const otherToken = 'z'.repeat(43);

      await page.goto(`/en/reset-password#token=${token}`);
      // Held until the other link is in the address bar
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      await page.route('**/api/trpc/auth.resetPassword**', async (route) => {
        await held;
        await route.continue();
      });
      await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
      await page.getByLabel('Confirm new password').fill(NEW_PASSWORD);
      await page.getByRole('button', { name: 'Set password' }).click();
      await page.evaluate((other) => {
        window.location.hash = `token=${other}`;
      }, otherToken);
      // Still filled in while the first link's request is out
      await expect(page.getByLabel('New password', { exact: true })).toHaveValue(NEW_PASSWORD);
      const answered = page.waitForResponse('**/api/trpc/auth.resetPassword**');
      release();
      expect((await answered).ok()).toBe(true);

      // The first link did its job, but the page still offers the second one, with nothing filled in
      await expect(page.getByLabel('New password', { exact: true })).toHaveValue('');
      await expect(page.getByLabel('Confirm new password')).toHaveValue('');
      await expect(page).toHaveURL(new RegExp(`#token=${otherToken}$`));
      await expect(page.getByTestId('reset-password-done')).toHaveCount(0);
      expect(await signsIn(email, NEW_PASSWORD)).toBe(true);
    } finally {
      await admin?.dispose();
      await removeTestUser(email);
    }
  });

  test('a request for an unknown address looks the same as for a known one', async ({ page }) => {
    // CI runs a mock SMTP server: a missing setting there must fail, not skip
    if (process.env.CI) expect(hasEmailConfig && !!outbox, 'EMAIL_SERVER_HOST and MOCK_SMTP_OUTBOX').toBe(true);
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

      // The server's answers themselves are the same, not just the page built from them
      const anonymous = await request.newContext({ baseURL: BASE });
      try {
        const answers = [];
        for (const email of [uniqueEmail('nobody'), knownEmail]) {
          const res = await trpcMutation(anonymous, 'auth.requestPasswordReset', { email });
          answers.push({ status: res.status(), body: await res.json() });
        }
        expect(answers[0]).toEqual({ status: 200, body: { result: { data: { json: { ok: true } } } } });
        expect(answers[1]).toEqual(answers[0]);
      } finally {
        await anonymous.dispose();
      }

      // Only the known address got mail, and the unknown one still has none a moment later
      if (outbox) {
        await expect.poll(() => readResetLink(knownEmail), { timeout: 15000 }).not.toBeNull();
        await new Promise((resolve) => setTimeout(resolve, 1000));
        expect(mailTo(unknownEmail)).toHaveLength(0);
      }
    } finally {
      await removeTestUser(knownEmail);
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
      await expectOnePasswordChangedEmail(email);
    } finally {
      await removeTestUser(email);
    }
  });

  test('an admin makes a reset link for a locked-out user, who sets a password with it', async ({ page, browser }) => {
    // Several sign-ins, two extra browsers and the admin page
    test.setTimeout(120_000);
    const email = uniqueEmail('pwadmin');
    await registerUser(email);
    let earlierSession: Awaited<ReturnType<typeof authedContext>> | undefined;
    let earlierBrowser: Awaited<ReturnType<Browser['newContext']>> | undefined;
    try {
      // Sessions signed in before the reset, e.g. someone else's: the reset ends them
      earlierSession = await authedContext(email, OLD_PASSWORD);
      earlierBrowser = await browser.newContext({ baseURL: BASE });
      expect((await trpcResult(await trpcQuery(earlierSession, 'auth.getProfile')))?.email).toBe(email);
      const earlierPage = await earlierBrowser.newPage();
      await login(earlierPage, email, OLD_PASSWORD);

      // As on an instance without email, where this is the way back in
      const stubbed = await withLoginOptions(page, { passwordLogin: true, passwordReset: false });
      await login(page, users.alice.email, users.alice.password);
      await page.goto('/en/admin');
      const userSection = page.locator('section', { has: page.getByRole('heading', { name: 'User Management' }) });
      await expect(userSection).toBeVisible({ timeout: 30000 });
      await userSection.getByPlaceholder('Search by name or email...').fill(email);
      const row = userSection.locator('tr', { hasText: email }).first();
      // By its test id too: the test with password sign-in off looks for it by that
      await expect(row.getByTestId('reset-password-link')).toBeVisible();
      await row.getByRole('button', { name: /^Create a password reset link for / }).click();
      // Asked first, naming the account: the link replaces any they have
      const confirm = page.getByRole('alertdialog');
      await expect(confirm).toContainText(email);
      await confirm.getByRole('button', { name: 'Make link' }).click();

      const dialog = page.getByRole('dialog', { name: 'Password reset link' });
      await expect(dialog).toBeVisible();
      expect(stubbed.count).toBeGreaterThan(0);
      const linkField = dialog.getByTestId('reset-password-link-url');
      await expect(linkField).toHaveValue(/\/en\/reset-password#token=[A-Za-z0-9_-]{43}$/);
      const link = await linkField.inputValue();

      await setPasswordWithLink(browser, link, NEW_PASSWORD);
      expect(await signsIn(email, NEW_PASSWORD)).toBe(true);
      expect(await signsIn(email, OLD_PASSWORD)).toBe(false);
      // Ended: refused as signed out, not some other failure
      const ended = await trpcQuery(earlierSession, 'auth.getProfile');
      expect((await trpcError(ended))?.data?.code).toBe('UNAUTHORIZED');
      // The browser signed in before is sent to the sign-in page
      await earlierPage.goto('/en/dashboard');
      await expect(earlierPage).toHaveURL(/\/en\/login/);
      // With email configured, the account is told its password changed
      await expectOnePasswordChangedEmail(email);

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
      await earlierSession?.dispose();
      await earlierBrowser?.close();
      await removeTestUser(email);
    }
  });

  test('with password sign-in off, the admin page offers no reset link', async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
    // After signing in: the stub also hides the login page's password form
    const stubbed = await withLoginOptions(page, { passwordLogin: false, passwordReset: false });
    await page.goto('/en/admin');
    const userSection = page.locator('section', { has: page.getByRole('heading', { name: 'User Management' }) });
    await expect(userSection.getByRole('button', { name: /^Impersonate / }).first()).toBeVisible({ timeout: 30000 });
    // The stubbed options have arrived, so the missing button is their doing, not a load still running
    await expect.poll(() => stubbed.count).toBeGreaterThan(0);
    await expect(userSection.getByTestId('reset-password-link')).toHaveCount(0);
  });

  test('a link sent many times at once works once', async () => {
    const email = uniqueEmail('pwrace');
    const userId = await registerUser(email);
    let admin: Awaited<ReturnType<typeof authedContext>> | undefined;
    const clients: Awaited<ReturnType<typeof request.newContext>>[] = [];
    try {
      admin = await authedContext(users.alice.email, users.alice.password);
      for (let i = 0; i < 8; i++) clients.push(await request.newContext({ baseURL: BASE }));
      const made = await trpcMutation(admin, 'admin.createPasswordResetLink', { userId });
      expect(made.ok()).toBe(true);
      const { token } = (await made.json()).result.data.json;

      const answers = await Promise.all(
        clients.map((client, i) =>
          trpcMutation(client, 'auth.resetPassword', { token, password: `race-pass-${i}` }).then(async (res) => ({
            ok: res.ok(),
            body: await res.json(),
          })),
        ),
      );

      const winners = answers.flatMap((answer, i) => (answer.ok ? [i] : []));
      expect(winners).toHaveLength(1);
      for (const answer of answers.filter((a) => !a.ok)) {
        // Refused as a used link, or, under load, as busy: never set
        expect(['resetLinkInvalid', 'serverBusy']).toContain(answer.body.error.json.data.messageKey);
      }
      // The one that got through set its password, and only it
      const winner = winners[0]!;
      expect(await signsIn(email, `race-pass-${winner}`)).toBe(true);
      expect(await signsIn(email, `race-pass-${(winner + 1) % 8}`)).toBe(false);
      await expectOnePasswordChangedEmail(email);
    } finally {
      for (const client of clients) await client.dispose();
      await admin?.dispose();
      await removeTestUser(email);
    }
  });
});
