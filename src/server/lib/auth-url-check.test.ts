import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('./logger', () => ({ logger: { warn: vi.fn() } }));

function request(proto?: string) {
  return new Headers(proto === undefined ? {} : { 'x-forwarded-proto': proto });
}

async function load() {
  vi.resetModules();
  const { logger } = await import('./logger');
  const check = await import('./auth-url-check');
  return { warn: vi.mocked(logger.warn), ...check };
}

beforeEach(() => {
  // Unset, not empty: Auth.js treats an empty AUTH_URL as set
  vi.stubEnv('AUTH_URL', undefined);
  vi.stubEnv('NEXTAUTH_URL', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('authUrlSchemeMismatch', () => {
  test('is null when the browser uses the configured scheme', async () => {
    const { authUrlSchemeMismatch } = await load();
    vi.stubEnv('NEXTAUTH_URL', 'https://sharetab.example.com');
    expect(authUrlSchemeMismatch(request('https'))).toBeNull();
    vi.stubEnv('NEXTAUTH_URL', 'http://192.168.1.10:3000');
    expect(authUrlSchemeMismatch(request('http'))).toBeNull();
  });

  test('reports an https request against an http NEXTAUTH_URL', async () => {
    const { authUrlSchemeMismatch } = await load();
    vi.stubEnv('NEXTAUTH_URL', 'http://192.168.1.10:3000');
    expect(authUrlSchemeMismatch(request('https'))).toEqual({
      setting: 'NEXTAUTH_URL',
      configured: 'http://192.168.1.10:3000',
      requestScheme: 'https',
    });
  });

  test('reports an http request against an https NEXTAUTH_URL', async () => {
    const { authUrlSchemeMismatch } = await load();
    vi.stubEnv('NEXTAUTH_URL', 'https://sharetab.example.com/');
    expect(authUrlSchemeMismatch(request('http'))).toEqual({
      setting: 'NEXTAUTH_URL',
      configured: 'https://sharetab.example.com',
      requestScheme: 'http',
    });
  });

  test('names AUTH_URL when it is the one in effect', async () => {
    const { authUrlSchemeMismatch } = await load();
    vi.stubEnv('AUTH_URL', 'https://sharetab.example.com');
    vi.stubEnv('NEXTAUTH_URL', 'http://192.168.1.10:3000');
    expect(authUrlSchemeMismatch(request('http'))?.setting).toBe('AUTH_URL');
    expect(authUrlSchemeMismatch(request('https'))).toBeNull();
  });

  test('takes any x-forwarded-proto that includes https as https, as Next.js does', async () => {
    const { authUrlSchemeMismatch } = await load();
    vi.stubEnv('NEXTAUTH_URL', 'https://sharetab.example.com');
    expect(authUrlSchemeMismatch(request('https,http'))).toBeNull();
  });

  test('is null with no configured URL, or one that can’t be parsed', async () => {
    const { authUrlSchemeMismatch } = await load();
    expect(authUrlSchemeMismatch(request('https'))).toBeNull();
    vi.stubEnv('NEXTAUTH_URL', 'not a url');
    expect(authUrlSchemeMismatch(request('https'))).toBeNull();
  });

  test('is null when the request carries no scheme', async () => {
    const { authUrlSchemeMismatch } = await load();
    vi.stubEnv('NEXTAUTH_URL', 'https://sharetab.example.com');
    expect(authUrlSchemeMismatch(request())).toBeNull();
  });

  test('never reports the URL’s user info or path', async () => {
    const { authUrlSchemeMismatch } = await load();
    vi.stubEnv('NEXTAUTH_URL', 'http://admin:hunter2@192.168.1.10:3000/sharetab');
    expect(authUrlSchemeMismatch(request('https'))?.configured).toBe('http://192.168.1.10:3000');
  });
});

describe('warnOnAuthUrlSchemeMismatch', () => {
  test('logs a mismatch once per direction, with what to change', async () => {
    const { warn, warnOnAuthUrlSchemeMismatch } = await load();
    vi.stubEnv('NEXTAUTH_URL', 'http://192.168.1.10:3000');
    warnOnAuthUrlSchemeMismatch(request('https'));
    warnOnAuthUrlSchemeMismatch(request('https'));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('auth.url_scheme_mismatch', {
      setting: 'NEXTAUTH_URL',
      configured: 'http://192.168.1.10:3000',
      requestScheme: 'https',
      hint: expect.stringContaining('Set NEXTAUTH_URL to the https address') as unknown,
    });

    vi.stubEnv('NEXTAUTH_URL', 'https://sharetab.example.com');
    warnOnAuthUrlSchemeMismatch(request('http'));
    warnOnAuthUrlSchemeMismatch(request('http'));
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith(
      'auth.url_scheme_mismatch',
      expect.objectContaining({
        requestScheme: 'http',
        hint: expect.stringContaining('sign-in fails') as unknown,
      }),
    );
  });

  test('logs nothing when the schemes agree', async () => {
    const { warn, warnOnAuthUrlSchemeMismatch } = await load();
    vi.stubEnv('NEXTAUTH_URL', 'https://sharetab.example.com');
    warnOnAuthUrlSchemeMismatch(request('https'));
    expect(warn).not.toHaveBeenCalled();
  });
});
