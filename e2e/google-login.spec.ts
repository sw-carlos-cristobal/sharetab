import { test, expect, type Page } from '@playwright/test';

// The login page's Google button and the messages it shows for the Google
// denial codes. The decisions themselves are unit-tested in
// src/server/lib/google-sign-in.test.ts.

/** Whether the server under test has Google configured (its env, not this process's). */
async function googleConfigured(page: Page): Promise<boolean> {
  const response = await page.request.get('/api/trpc/auth.getLoginOptions');
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { result: { data: { json: { google: boolean } } } };
  return body.result.data.json.google;
}

/** Answers the page's getLoginOptions calls as if the server had Google configured. */
async function reportGoogleConfigured(page: Page) {
  await page.route(
    (url) => url.pathname.startsWith('/api/trpc/') && url.pathname.includes('auth.getLoginOptions'),
    async (route) => {
      const response = await route.fetch();
      const body: unknown = await response.json();
      // Batched answers are an array; set google on the getLoginOptions result in it.
      for (const item of Array.isArray(body) ? body : [body]) {
        const json = (item as { result?: { data?: { json?: Record<string, unknown> } } }).result?.data?.json;
        if (json && 'google' in json) json.google = true;
      }
      await route.fulfill({ response, json: body });
    },
  );
}

test.describe('Google login page', () => {
  test('shows the Google button only when Google is configured', async ({ page }) => {
    const configured = await googleConfigured(page);

    await page.goto('/en/login');
    await expect(page.getByLabel('Password')).toBeVisible();
    await expect(page.getByTestId('google-sign-in')).toHaveCount(configured ? 1 : 0);
  });

  test('shows the Google button, with the password form, when the server reports Google', async ({ page }) => {
    await reportGoogleConfigured(page);

    await page.goto('/en/login');
    await expect(page.getByTestId('google-sign-in')).toHaveText('Sign in with Google');
    await expect(page.getByLabel('Password')).toBeVisible();
  });

  // Needs Google configured on the server, and the server able to reach
  // accounts.google.com: Auth.js fetches Google's discovery document before
  // redirecting, and without it lands back on /login?error=Configuration.
  test("the Google button goes to Google's account chooser", async ({ page }) => {
    test.skip(!(await googleConfigured(page)), 'Google is not configured on the server under test');

    await page.route('https://accounts.google.com/**', (route) => route.fulfill({ status: 200, body: 'stub' }));
    await page.goto('/en/login');
    const [request] = await Promise.all([
      page.waitForRequest((r) => r.url().startsWith('https://accounts.google.com/')),
      page.getByTestId('google-sign-in').click(),
    ]);
    const url = new URL(request.url());
    expect(url.searchParams.get('prompt')).toBe('select_account');
    expect(url.searchParams.get('redirect_uri')).toMatch(/\/api\/auth\/callback\/google$/);
  });

  test('maps the GoogleAccountExists code to the sign-in-as-usual message', async ({ page }) => {
    await page.goto('/en/login?error=GoogleAccountExists');
    await expect(page.getByTestId('login-error')).toContainText('Sign in the way you usually do');
  });
});
