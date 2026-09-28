import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@/server/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

async function loggedText(): Promise<string> {
  const { logger } = await import('@/server/lib/logger');
  return JSON.stringify(
    [logger.info, logger.warn, logger.error, logger.debug].flatMap((fn) => vi.mocked(fn).mock.calls),
  );
}

// Fails if any 6-character stretch of `secret` appears in `text` (as in meridian-login.test.ts)
function expectNoPartOf(secret: string, text: string | undefined) {
  if (secret.length < 6) throw new Error('expectNoPartOf needs a secret of 6+ characters');
  for (let i = 0; i + 6 <= secret.length; i++) {
    expect(text ?? '').not.toContain(secret.slice(i, i + 6));
  }
}

/** A JWT-shaped token the login code can decode, expiring `inSeconds` from now */
function jwtExpiringIn(inSeconds: number) {
  return [
    'header',
    Buffer.from(
      JSON.stringify({
        exp: Math.floor(Date.now() / 1000) + inSeconds,
        'https://api.openai.com/auth': { chatgpt_account_id: 'acct_123' },
      }),
    ).toString('base64url'),
    'sig',
  ].join('.');
}

const CODE = 'ac_CODESECRET0123456789';
const REFRESH_TOKEN = 'rt_REFRESHSECRET0123456789';
const LEAKY_TOKEN = 'eyLEAKYACCESSTOKEN0123456789';

describe('OpenAICodexLogin', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    process.env = { ...originalEnv, OPENAI_CODEX_DIR: '/tmp/test-chatgpt' };
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('startLogin returns an OAuth URL with Codex params', async () => {
    const { startLogin, cancelLogin } = await import('./openai-codex-login');
    const url = await startLogin();
    expect(url).toContain('https://auth.openai.com/oauth/authorize');
    expect(url).toContain('client_id=app_EMoamEEZ73f0CkXaXp7hrann');
    expect(url).toContain('code_challenge=');
    expect(url).toContain('redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback');
    expect(url).toContain('codex_cli_simplified_flow=true');
    cancelLogin();
  });

  test('submitCode exchanges code and saves auth file', async () => {
    const mockWriteFileSync = vi.fn();
    vi.doMock('fs', () => ({
      mkdirSync: vi.fn(),
      readFileSync: vi.fn(),
      writeFileSync: mockWriteFileSync,
      unlinkSync: vi.fn(),
    }));

    const { startLogin, submitCode } = await import('./openai-codex-login');
    await startLogin();

    const jwt = [
      'header',
      Buffer.from(
        JSON.stringify({
          exp: Math.floor(Date.now() / 1000) + 3600,
          'https://api.openai.com/profile': { email: 'test@example.com' },
          'https://api.openai.com/auth': {
            chatgpt_plan_type: 'plus',
            chatgpt_account_id: 'acct_123',
          },
        }),
      ).toString('base64url'),
      'sig',
    ].join('.');

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id_token: jwt,
          access_token: jwt,
          refresh_token: 'refresh-123',
        }),
        { status: 200 },
      ),
    );

    const result = await submitCode('abc');
    expect(result.success).toBe(true);
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(mockWriteFileSync.mock.calls[0]![1]);
    expect(saved.auth_mode).toBe('Chatgpt');
    expect(saved.tokens.account_id).toBe('acct_123');
  });

  test('refreshIfNeeded refreshes expired auth', async () => {
    const expired = [
      'header',
      Buffer.from(
        JSON.stringify({
          exp: Math.floor(Date.now() / 1000) - 60,
          'https://api.openai.com/auth': { chatgpt_account_id: 'acct_123' },
        }),
      ).toString('base64url'),
      'sig',
    ].join('.');
    const fresh = [
      'header',
      Buffer.from(
        JSON.stringify({
          exp: Math.floor(Date.now() / 1000) + 3600,
          'https://api.openai.com/auth': { chatgpt_account_id: 'acct_123' },
        }),
      ).toString('base64url'),
      'sig',
    ].join('.');

    const mockWriteFileSync = vi.fn();
    vi.doMock('fs', () => ({
      mkdirSync: vi.fn(),
      readFileSync: () =>
        JSON.stringify({
          auth_mode: 'Chatgpt',
          tokens: {
            id_token: expired,
            access_token: expired,
            refresh_token: 'refresh-old',
            account_id: 'acct_123',
          },
        }),
      writeFileSync: mockWriteFileSync,
      unlinkSync: vi.fn(),
    }));

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id_token: fresh,
          access_token: fresh,
          refresh_token: 'refresh-new',
        }),
        { status: 200 },
      ),
    );

    const { refreshIfNeeded } = await import('./openai-codex-login');
    expect(await refreshIfNeeded()).toBe(true);
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(init?.headers).toMatchObject({
      'Content-Type': 'application/x-www-form-urlencoded',
      originator: 'codex_cli_rs',
    });
    expect(init?.body).toBeInstanceOf(URLSearchParams);
  });

  test('checkOpenAICodexHealth returns degraded for backend outages', async () => {
    const jwt = [
      'header',
      Buffer.from(
        JSON.stringify({
          exp: Math.floor(Date.now() / 1000) + 3600,
          'https://api.openai.com/auth': { chatgpt_account_id: 'acct_123' },
        }),
      ).toString('base64url'),
      'sig',
    ].join('.');

    vi.doMock('fs', () => ({
      mkdirSync: vi.fn(),
      readFileSync: () =>
        JSON.stringify({
          auth_mode: 'Chatgpt',
          tokens: {
            id_token: jwt,
            access_token: jwt,
            refresh_token: 'refresh-token',
            account_id: 'acct_123',
          },
        }),
      writeFileSync: vi.fn(),
      unlinkSync: vi.fn(),
    }));

    vi.mocked(fetch).mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    const { checkOpenAICodexHealth } = await import('./openai-codex-login');
    await expect(checkOpenAICodexHealth()).resolves.toMatchObject({
      status: 'degraded',
      error: 'connect ECONNREFUSED',
      accountId: 'acct_123',
    });
  });

  test('checkOpenAICodexHealth caches healthy result for four hours on long-lived tokens', async () => {
    const jwt = [
      'header',
      Buffer.from(
        JSON.stringify({
          exp: Math.floor((Date.now() + 12 * 60 * 60 * 1000) / 1000),
          'https://api.openai.com/profile': { email: 'test@example.com' },
          'https://api.openai.com/auth': {
            chatgpt_plan_type: 'plus',
            chatgpt_account_id: 'acct_123',
          },
        }),
      ).toString('base64url'),
      'sig',
    ].join('.');

    vi.doMock('fs', () => ({
      mkdirSync: vi.fn(),
      readFileSync: () =>
        JSON.stringify({
          auth_mode: 'Chatgpt',
          tokens: {
            id_token: jwt,
            access_token: jwt,
            refresh_token: 'refresh-token',
            account_id: 'acct_123',
          },
        }),
      writeFileSync: vi.fn(),
      unlinkSync: vi.fn(),
    }));

    vi.mocked(fetch).mockResolvedValueOnce(new Response('[]', { status: 200 }));

    const { checkOpenAICodexHealth } = await import('./openai-codex-login');
    await checkOpenAICodexHealth();
    vi.advanceTimersByTime(3 * 60 * 60 * 1000 + 59 * 60 * 1000);
    await checkOpenAICodexHealth();

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('checkOpenAICodexHealth refreshes cache every five minutes when token is near expiry', async () => {
    const jwt = [
      'header',
      Buffer.from(
        JSON.stringify({
          exp: Math.floor((Date.now() + 10 * 60 * 1000) / 1000),
          'https://api.openai.com/profile': { email: 'test@example.com' },
          'https://api.openai.com/auth': {
            chatgpt_plan_type: 'plus',
            chatgpt_account_id: 'acct_123',
          },
        }),
      ).toString('base64url'),
      'sig',
    ].join('.');

    vi.doMock('fs', () => ({
      mkdirSync: vi.fn(),
      readFileSync: () =>
        JSON.stringify({
          auth_mode: 'Chatgpt',
          tokens: {
            id_token: jwt,
            access_token: jwt,
            refresh_token: 'refresh-token',
            account_id: 'acct_123',
          },
        }),
      writeFileSync: vi.fn(),
      unlinkSync: vi.fn(),
    }));

    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('[]', { status: 200 }))
      .mockResolvedValueOnce(new Response('[]', { status: 200 }));

    const { checkOpenAICodexHealth } = await import('./openai-codex-login');
    await checkOpenAICodexHealth();
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    await checkOpenAICodexHealth();

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('checkOpenAICodexHealth force option bypasses cache', async () => {
    const jwt = [
      'header',
      Buffer.from(
        JSON.stringify({
          exp: Math.floor((Date.now() + 12 * 60 * 60 * 1000) / 1000),
          'https://api.openai.com/auth': { chatgpt_account_id: 'acct_123' },
        }),
      ).toString('base64url'),
      'sig',
    ].join('.');

    vi.doMock('fs', () => ({
      mkdirSync: vi.fn(),
      readFileSync: () =>
        JSON.stringify({
          auth_mode: 'Chatgpt',
          tokens: {
            id_token: jwt,
            access_token: jwt,
            refresh_token: 'refresh-token',
            account_id: 'acct_123',
          },
        }),
      writeFileSync: vi.fn(),
      unlinkSync: vi.fn(),
    }));

    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('[]', { status: 200 }))
      .mockResolvedValueOnce(new Response('[]', { status: 200 }));

    const { checkOpenAICodexHealth } = await import('./openai-codex-login');
    await checkOpenAICodexHealth();
    await checkOpenAICodexHealth({ force: true });

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  describe('token-endpoint text stays out of errors, logs and stored status (#220)', () => {
    // Stored auth whose access token has expired, so the next use refreshes it
    function expiredStoredAuth() {
      const writeFileSync = vi.fn();
      const expired = jwtExpiringIn(-60);
      vi.doMock('fs', () => ({
        mkdirSync: vi.fn(),
        readFileSync: () =>
          JSON.stringify({
            auth_mode: 'Chatgpt',
            tokens: { id_token: expired, access_token: expired, refresh_token: REFRESH_TOKEN, account_id: 'acct_123' },
          }),
        writeFileSync,
        unlinkSync: vi.fn(),
      }));
      return { writeFileSync };
    }

    async function exchange(response: Response) {
      vi.doMock('fs', () => ({
        mkdirSync: vi.fn(),
        readFileSync: vi.fn(),
        writeFileSync: vi.fn(),
        unlinkSync: vi.fn(),
      }));
      const { startLogin, submitCode } = await import('./openai-codex-login');
      await startLogin();
      vi.mocked(fetch).mockResolvedValueOnce(response);
      return submitCode(CODE);
    }

    test('a failed exchange reports only the status and an RFC 6749 error code, not the body', async () => {
      const result = await exchange(
        new Response(JSON.stringify({ error: 'invalid_grant', error_description: `code ${CODE} was used` }), {
          status: 400,
        }),
      );
      expect(result).toEqual({ success: false, error: 'Token exchange failed (400): invalid_grant' });
      expectNoPartOf(CODE, result.error);
      expectNoPartOf(CODE, await loggedText());
    });

    test('a failed exchange whose body is not JSON reports only the status', async () => {
      const result = await exchange(new Response(`<html>bad code ${CODE}</html>`, { status: 502 }));
      expect(result).toEqual({ success: false, error: 'Token exchange failed (502)' });
      expectNoPartOf(CODE, await loggedText());
    });

    test('a malformed success body on exchange fails with a fixed error', async () => {
      const result = await exchange(new Response(`${LEAKY_TOKEN} is not JSON`, { status: 200 }));
      expect(result).toEqual({ success: false, error: 'Malformed token response' });
      expectNoPartOf(LEAKY_TOKEN, await loggedText());
    });

    test('a wrongly typed success body on exchange saves nothing and quotes nothing', async () => {
      const result = await exchange(
        new Response(JSON.stringify({ id_token: 42, access_token: LEAKY_TOKEN, refresh_token: ['x'] }), {
          status: 200,
        }),
      );
      expect(result).toEqual({ success: false, error: 'Token exchange response did not include all required tokens' });
      expectNoPartOf(LEAKY_TOKEN, result.error);
    });

    // A JWT-shaped token whose payload isn't JSON: a JSON parser's message would quote it
    const UNDECODABLE_JWT = [
      'header',
      Buffer.from('ENDPOINTSECRET0123456789 is not JSON').toString('base64url'),
      'sig',
    ].join('.');

    test('an exchange returning a token whose claims do not decode fails with a fixed error', async () => {
      const result = await exchange(
        new Response(
          JSON.stringify({ id_token: UNDECODABLE_JWT, access_token: UNDECODABLE_JWT, refresh_token: 'rt_x' }),
          { status: 200 },
        ),
      );
      expect(result).toEqual({ success: false, error: 'Malformed token response' });
      expectNoPartOf('ENDPOINTSECRET0123456789', await loggedText());
    });

    test("the health check's refresh returning a token whose claims do not decode is degraded with a fixed error", async () => {
      expiredStoredAuth();
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ id_token: UNDECODABLE_JWT, access_token: UNDECODABLE_JWT }), { status: 200 }),
      );
      const { checkOpenAICodexHealth } = await import('./openai-codex-login');
      const result = await checkOpenAICodexHealth();
      expect(result).toMatchObject({ status: 'degraded', error: 'Malformed token response' });
      expectNoPartOf('ENDPOINTSECRET0123456789', JSON.stringify(result));
      expectNoPartOf('ENDPOINTSECRET0123456789', await loggedText());
    });

    test('a refresh answering an empty refresh_token keeps the stored one', async () => {
      const { writeFileSync } = expiredStoredAuth();
      const fresh = jwtExpiringIn(3600);
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ id_token: fresh, access_token: fresh, refresh_token: '' }), { status: 200 }),
      );
      const { refreshIfNeeded } = await import('./openai-codex-login');
      expect(await refreshIfNeeded()).toBe(true);
      const saved = JSON.parse(writeFileSync.mock.calls[0]![1] as string) as { tokens: { refresh_token: string } };
      expect(saved.tokens.refresh_token).toBe(REFRESH_TOKEN);
    });

    test('a failed refresh logs only the status and an RFC 6749 error code', async () => {
      const { writeFileSync } = expiredStoredAuth();
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'invalid_grant', error_description: `token ${REFRESH_TOKEN}` }), {
          status: 400,
        }),
      );
      const { refreshIfNeeded } = await import('./openai-codex-login');
      expect(await refreshIfNeeded()).toBe(false);
      expect(writeFileSync).not.toHaveBeenCalled();
      const { logger } = await import('@/server/lib/logger');
      expect(logger.warn).toHaveBeenCalledWith('openaiCodex.refresh.failed', { status: 400, error: 'invalid_grant' });
      expectNoPartOf(REFRESH_TOKEN, await loggedText());
    });

    test('a malformed refresh response fails with a fixed error', async () => {
      const { writeFileSync } = expiredStoredAuth();
      vi.mocked(fetch).mockResolvedValueOnce(new Response(`${LEAKY_TOKEN} is not JSON`, { status: 200 }));
      const { refreshIfNeeded } = await import('./openai-codex-login');
      await expect(refreshIfNeeded()).rejects.toThrow(new Error('Malformed token response'));
      expect(writeFileSync).not.toHaveBeenCalled();
    });

    test('a wrongly typed refresh response saves nothing', async () => {
      const { writeFileSync } = expiredStoredAuth();
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ id_token: 42, access_token: LEAKY_TOKEN }), { status: 200 }),
      );
      const { refreshIfNeeded } = await import('./openai-codex-login');
      expect(await refreshIfNeeded()).toBe(false);
      expect(writeFileSync).not.toHaveBeenCalled();
      expectNoPartOf(LEAKY_TOKEN, await loggedText());
    });

    test("the health check's first refresh failing is a degraded status, not an unhandled error", async () => {
      expiredStoredAuth();
      vi.mocked(fetch).mockResolvedValueOnce(new Response(`${LEAKY_TOKEN} is not JSON`, { status: 200 }));
      const { checkOpenAICodexHealth } = await import('./openai-codex-login');
      const result = await checkOpenAICodexHealth();
      expect(result).toMatchObject({ status: 'degraded', error: 'Malformed token response', accountId: 'acct_123' });
      expectNoPartOf(LEAKY_TOKEN, JSON.stringify(result));
      expectNoPartOf(LEAKY_TOKEN, await loggedText());
    });

    test('a malformed response to the refresh after a 401 is a degraded status with a fixed error', async () => {
      const current = jwtExpiringIn(3600);
      vi.doMock('fs', () => ({
        mkdirSync: vi.fn(),
        readFileSync: () =>
          JSON.stringify({
            auth_mode: 'Chatgpt',
            tokens: { id_token: current, access_token: current, refresh_token: REFRESH_TOKEN, account_id: 'acct_123' },
          }),
        writeFileSync: vi.fn(),
        unlinkSync: vi.fn(),
      }));
      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
        .mockResolvedValueOnce(new Response(`${LEAKY_TOKEN} is not JSON`, { status: 200 }));
      const { checkOpenAICodexHealth } = await import('./openai-codex-login');
      const result = await checkOpenAICodexHealth();
      expect(result).toMatchObject({ status: 'degraded', error: 'Malformed token response' });
      expectNoPartOf(LEAKY_TOKEN, JSON.stringify(result));
    });
  });

  test('logout clears pending login and removes auth file', async () => {
    const mockUnlinkSync = vi.fn();
    vi.doMock('fs', () => ({
      mkdirSync: vi.fn(),
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      unlinkSync: mockUnlinkSync,
    }));

    const { startLogin, isLoginInProgress, logout } = await import('./openai-codex-login');
    await startLogin();
    expect(isLoginInProgress()).toBe(true);

    const result = logout();
    expect(result.success).toBe(true);
    expect(isLoginInProgress()).toBe(false);
    expect(mockUnlinkSync.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  test('logout succeeds when auth file is missing', async () => {
    vi.doMock('fs', () => ({
      mkdirSync: vi.fn(),
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      unlinkSync: () => {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      },
    }));

    const { logout } = await import('./openai-codex-login');
    expect(logout()).toEqual({ success: true });
  });
});
