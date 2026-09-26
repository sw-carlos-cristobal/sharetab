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
//                   error.

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
  fail('the provider reported itself unavailable (a failed proxy start, or /health not answering 2xx)');
} else if (res.status !== 503 || !body.includes('authentication_error')) {
  // Without a login the proxy runs but Meridian rejects the request; any
  // other failure is a real one.
  fail("expected a 503 carrying Meridian's authentication_error");
}
