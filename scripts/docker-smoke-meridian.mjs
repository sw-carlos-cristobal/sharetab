// Run by scripts/docker-smoke.sh inside the container under test: signs in
// as an admin and runs the admin "Test Receipt Extraction" endpoint with the
// meridian provider, the path the app takes (ensureMeridian() in the server
// process, as the app user).
//
// Environment:
//   ADMIN_EMAIL     the container's ADMIN_EMAIL; this script registers it
//   ADMIN_PASSWORD  the password to register it with
//   RECEIPT         path to the receipt image inside the container
//   LIVE            set when a Claude login is mounted: the extraction must
//                   succeed and return the sample receipt's total. Unset,
//                   the extraction must fail with Meridian's authentication
//                   error, or (Meridian 1.83 and later) the provider must be
//                   unavailable because Meridian reports no Claude login.

import { readFileSync } from 'node:fs';

const base = 'http://127.0.0.1:3000';
const email = process.env.ADMIN_EMAIL;
const password = process.env.ADMIN_PASSWORD;
const expectedTotal = 37668; // e2e/test-receipt.png, in cents

const jar = new Map();
const keepCookies = (res) => {
  for (const cookie of res.headers.getSetCookie()) {
    const [pair] = cookie.split(';');
    const i = pair.indexOf('=');
    jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
};
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
const trpcMutation = (path, input) =>
  fetch(`${base}/api/trpc/${path}?batch=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookieHeader() },
    body: JSON.stringify({ 0: { json: input } }),
  });
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

let res = await trpcMutation('auth.register', { name: 'Smoke Admin', email, password });
if (!res.ok) fail(`register: ${res.status} ${await res.text()}`);

// Auth.js credentials sign-in: the CSRF token from /api/auth/csrf must come
// back both as a form field and as the cookie it was issued with.
res = await fetch(`${base}/api/auth/csrf`);
keepCookies(res);
const { csrfToken } = await res.json();
res = await fetch(`${base}/api/auth/callback/credentials`, {
  method: 'POST',
  redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader() },
  body: new URLSearchParams({ csrfToken, email, password, callbackUrl: base }),
});
keepCookies(res);
if (![...jar.keys()].some((name) => name.endsWith('session-token'))) {
  fail(`sign-in failed: ${res.status} ${res.headers.get('location')}`);
}

res = await trpcMutation('admin.testAIProvider', {
  providerName: 'meridian',
  imageBase64: readFileSync(process.env.RECEIPT).toString('base64'),
  mimeType: 'image/png',
});
const body = await res.text();
console.log(`testAIProvider: ${res.status} ${body.slice(0, 600)}`);

if (process.env.LIVE) {
  if (res.status !== 200) fail('expected the extraction to succeed');
  const total = JSON.parse(body)[0]?.result?.data?.json?.result?.total;
  if (total !== expectedTotal) fail(`expected a total of ${expectedTotal} cents, got ${total}`);
} else if (res.status === 412) {
  // Meridian 1.83 and later answer /health with 503 "unhealthy" when Claude
  // Code says there is no login, so the app counts the provider unavailable
  // (and would fall back to the next one). Check that this is the reason:
  // Meridian reports loggedIn: false only from the Claude binary's own answer,
  // so the binary is in the image and runs. A failed proxy start, or any other
  // health problem, is a real failure.
  const meridian = `http://127.0.0.1:${process.env.MERIDIAN_PORT || 3457}`;
  let health;
  try {
    const healthRes = await fetch(`${meridian}/health`);
    const healthBody = await healthRes.text();
    console.log(`meridian /health: ${healthRes.status} ${healthBody.slice(0, 600)}`);
    health = { status: healthRes.status, body: JSON.parse(healthBody) };
  } catch (err) {
    fail(`the provider reported itself unavailable, and Meridian's /health gave no answer: ${err}`);
  }
  if (health.status !== 503 || health.body?.status !== 'unhealthy' || health.body?.auth?.loggedIn !== false) {
    fail('the provider reported itself unavailable, but not because Meridian reports no Claude login');
  }

  // The request the app's extraction makes, sent to the proxy the app started:
  // Meridian runs it through Claude Code and rejects it for the missing login.
  const messageRes = await fetch(`${meridian}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'x', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
  const messageBody = await messageRes.text();
  console.log(`meridian /v1/messages: ${messageRes.status} ${messageBody.slice(0, 600)}`);
  if (!messageBody.includes('authentication_error')) {
    fail("expected Meridian's authentication_error for a request without a Claude login");
  }
} else if (res.status !== 503 || !body.includes('authentication_error')) {
  // Without a login the proxy runs but Meridian rejects the request; any
  // other failure is a real one.
  fail("expected a 503 carrying Meridian's authentication_error");
}
