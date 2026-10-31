import { describe, expect, test, vi } from 'vitest';
// The core's own exports, as in google-provider.test.ts: next-auth's entry can't load in Vitest.
// next-auth hands process.env to this setEnvDefaults the same way.
import { Auth, setEnvDefaults } from '@auth/core';
import Credentials from 'next-auth/providers/credentials';

// auth.ts sets `trustHost: true` (#417; auth.test.ts checks it). This runs that setting through
// the real Auth.js in the production image's environment (NODE_ENV=production): whatever
// AUTH_TRUST_HOST says, the CSRF token the sign-in form sends is answered.

type Env = Record<string, string | undefined>;

function config(trustHost: boolean | undefined) {
  return {
    secret: 'x'.repeat(32),
    basePath: '/api/auth',
    providers: [Credentials({ credentials: {}, authorize: () => null })],
    logger: { error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    ...(trustHost === undefined ? {} : { trustHost }),
  };
}

/** Whether Auth.js answers the sign-in form's CSRF request, with this env and trustHost. */
async function answersCsrf(env: Env, trustHost: boolean | undefined) {
  const c = config(trustHost);
  setEnvDefaults({ NODE_ENV: 'production', ...env }, c);
  const response = await Auth(new Request('http://0.0.0.0:3000/api/auth/csrf'), c);
  if (response.status === 200) return true;
  expect(response.status).toBe(500);
  expect(c.logger.error).toHaveBeenCalledWith(expect.objectContaining({ name: 'UntrustedHost' }));
  return false;
}

describe('trustHost through the real Auth.js', () => {
  // The first is a container started with only the variables the README calls required
  test.each<Env>([{}, { AUTH_TRUST_HOST: 'false' }])('answers with %o', async (env) => {
    expect(await answersCsrf(env, true)).toBe(true);
  });

  // What every sign-in got before #417 with AUTH_TRUST_HOST and AUTH_URL unset: Auth.js left
  // to decide refuses, NEXTAUTH_URL or not
  test.each<Env>([{}, { NEXTAUTH_URL: 'http://192.168.1.8:3000' }])(
    'refuses with trustHost left to Auth.js and %o',
    async (env) => {
      expect(await answersCsrf(env, undefined)).toBe(false);
    },
  );
});
