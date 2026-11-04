import { test, expect, type Page } from '@playwright/test';

// The login page's Google button: when it shows, that it and the SSO button
// (which shares its handler) start a sign-in, and that it recovers when that
// fails; the already-signed-in refusal's Sign out button; and the
// GoogleAccountExists message. The decisions are unit-tested in src/server/lib/google-sign-in.test.ts,
// every denial code's message key in src/lib/sign-in-errors.test.ts, and the
// Google sign-in through the real Auth.js in src/server/google-provider.test.ts.

/** Whether the server under test has Google configured (its env, not this process's). */
async function googleConfigured(page: Page): Promise<boolean> {
  const response = await page.request.get('/api/trpc/auth.getLoginOptions');
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { result: { data: { json: { google: boolean } } } };
  return body.result.data.json.google;
}

/** Answers the page's getLoginOptions calls as if the server had these sign-in options. */
async function reportLoginOptions(page: Page, options: Record<string, unknown>) {
  await page.route(
    (url) => url.pathname.startsWith('/api/trpc/') && url.pathname.includes('auth.getLoginOptions'),
    async (route) => {
      const response = await route.fetch();
      const body: unknown = await response.json();
      // Batched answers are an array; patch the getLoginOptions result in it.
      for (const item of Array.isArray(body) ? body : [body]) {
        const json = (item as { result?: { data?: { json?: Record<string, unknown> } } }).result?.data?.json;
        if (json && 'google' in json) Object.assign(json, options);
      }
      // Not `response`: its headers may carry the unpatched body's length.
      await route.fulfill({ status: response.status(), json: body });
    },
  );
}

/**
 * Answers Auth.js' provider list as if the server had this provider. Auth.js'
 * client looks the provider up first; without it, it just reloads the login
 * page (Auth.js' sign-in page) instead of starting a sign-in.
 */
async function reportProvider(page: Page, id: string, name: string) {
  await page.route(
    (url) => url.pathname === '/api/auth/providers',
    async (route) => {
      const response = await route.fetch();
      const providers = (await response.json()) as Record<string, unknown>;
      const provider = { id, name, type: 'oidc', signinUrl: '', callbackUrl: '' };
      await route.fulfill({ status: response.status(), json: { ...providers, [id]: provider } });
    },
  );
}

const SSO_BUTTONS = [
  { id: 'google', name: 'Google', testId: 'google-sign-in', options: { google: true } },
  { id: 'oidc', name: 'Authentik', testId: 'oidc-sign-in', options: { oidc: { name: 'Authentik' } } },
];

test.describe('Google login page', () => {
  test('shows the Google button only when Google is configured', async ({ page }) => {
    const configured = await googleConfigured(page);

    await page.goto('/en/login');
    await expect(page.getByLabel('Password')).toBeVisible();
    await expect(page.getByTestId('google-sign-in')).toHaveCount(configured ? 1 : 0);
  });

  for (const sso of SSO_BUTTONS) {
    test(`the ${sso.name} button starts a ${sso.id} sign-in that returns to the page it came from`, async ({
      page,
    }) => {
      await reportLoginOptions(page, sso.options);
      await reportProvider(page, sso.id, sso.name);
      // Hold Auth.js' answer, so the page can be checked while it waits for it.
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      await page.route(
        (url) => url.pathname === `/api/auth/signin/${sso.id}`,
        async (route) => {
          await held;
          await route.fulfill({ json: { url: '/en/login?from=sso-stub' } });
        },
      );

      await page.goto('/en/login?callbackUrl=%2Fen%2Fgroups');
      const button = page.getByTestId(sso.testId);
      await expect(button).toHaveText(`Sign in with ${sso.name}`);
      await expect(page.getByLabel('Password')).toBeVisible();
      const [request] = await Promise.all([
        page.waitForRequest((r) => new URL(r.url()).pathname === `/api/auth/signin/${sso.id}`),
        button.click(),
      ]);
      expect(request.method()).toBe('POST');
      const body = new URLSearchParams(request.postData() ?? '');
      expect(body.get('callbackUrl')).toMatch(/\/en\/groups$/);
      expect(body.get('csrfToken')).toBeTruthy();
      // No second click while the browser is on its way to the provider.
      await expect(button).toBeDisabled();

      release();
      await expect(page).toHaveURL(/from=sso-stub/);
    });
  }

  test('a sign-in that fails to start shows an error and re-enables the button', async ({ page }) => {
    await reportLoginOptions(page, { google: true });
    await reportProvider(page, 'google', 'Google');
    await page.route(
      (url) => url.pathname === '/api/auth/signin/google',
      (route) => route.abort('failed'),
    );

    await page.goto('/en/login');
    await page.getByTestId('google-sign-in').click();
    await expect(page.getByTestId('login-error')).toContainText('Sign-in failed');
    await expect(page.getByTestId('google-sign-in')).toBeEnabled();
  });

  test('Back from the provider re-enables the button (back/forward cache restore)', async ({ page }) => {
    await reportLoginOptions(page, { google: true });
    await reportProvider(page, 'google', 'Google');
    // Hold Auth.js' answer, so the button stays disabled as when the browser has left for Google.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(
      (url) => url.pathname === '/api/auth/signin/google',
      async (route) => {
        await held;
        await route.abort();
      },
    );

    await page.goto('/en/login');
    const button = page.getByTestId('google-sign-in');
    await button.click();
    await expect(button).toBeDisabled();
    // What the browser fires when Back restores the page from the back/forward cache.
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await expect(button).toBeEnabled();
    release();
  });

  test('a sign-out that fails says so and keeps the Sign out button', async ({ page }) => {
    await page.route(
      (url) => url.pathname === '/api/auth/signout',
      (route) => route.abort('failed'),
    );

    await page.goto('/en/login?error=GoogleSessionActive');
    await page.getByTestId('login-sign-out').click();
    await expect(page.getByTestId('login-sign-out-failed')).toContainText('Something went wrong');
    await expect(page.getByTestId('login-error')).toContainText("You're already signed in");
    await expect(page.getByTestId('login-sign-out')).toBeVisible();
  });

  test('the already-signed-in refusal signs out back to the login page', async ({ page }) => {
    // Answer the sign-out here: the real answer is the same /en/login the page
    // sends as its callbackUrl, so the test couldn't tell whether the page
    // followed the server's answer or its own fallback.
    await page.route(
      (url) => url.pathname === '/api/auth/signout',
      (route) => route.fulfill({ json: { url: '/en/login?from=signout-stub' } }),
    );

    await page.goto('/en/login?error=GoogleSessionActive');
    await expect(page.getByTestId('login-error')).toContainText("You're already signed in");
    const [request] = await Promise.all([
      page.waitForRequest((r) => new URL(r.url()).pathname === '/api/auth/signout'),
      page.getByTestId('login-sign-out').click(),
    ]);
    expect(new URLSearchParams(request.postData() ?? '').get('callbackUrl')).toBe('/en/login');
    await expect(page).toHaveURL(/from=signout-stub/);
  });

  test('maps the GoogleAccountExists code to the sign-in-as-usual message, with no Sign out button', async ({
    page,
  }) => {
    await page.goto('/en/login?error=GoogleAccountExists');
    await expect(page.getByTestId('login-error')).toContainText('Sign in the way you usually do');
    await expect(page.getByTestId('login-sign-out')).toHaveCount(0);
  });
});
