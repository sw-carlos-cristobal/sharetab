import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/server/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Every logger call of the current test, at every level, as one string
async function loggedText(): Promise<string> {
  const { logger } = await import('@/server/lib/logger');
  return JSON.stringify(
    [logger.info, logger.warn, logger.error, logger.debug].flatMap((fn) => vi.mocked(fn).mock.calls),
  );
}

// A 200 response a JSON parser rejects; its error message can quote the body
const MALFORMED_TOKEN_BODY = 'sk-ant-oat01-LEAKYACCESSTOKEN is not JSON';

// Fails if any 6-character stretch of `secret` appears in `text`, well under
// the 10-character code prefix that used to be logged
function expectNoPartOf(secret: string, text: string | undefined) {
  if (secret.length < 6) throw new Error('expectNoPartOf needs a secret of 6+ characters');
  for (let i = 0; i + 6 <= secret.length; i++) {
    expect(text ?? '').not.toContain(secret.slice(i, i + 6));
  }
}

describe('MeridianLoginManager', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.useFakeTimers();
    process.env = { ...originalEnv, CLAUDE_DIR: '/tmp/test-claude', NEXTAUTH_URL: 'http://localhost:3000' };
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('isLoginInProgress returns false initially', async () => {
    const { isLoginInProgress } = await import('./meridian-login');
    expect(isLoginInProgress()).toBe(false);
  });

  test('startLogin returns an OAuth URL with PKCE params', async () => {
    const { startLogin, cancelLogin } = await import('./meridian-login');
    const url = await startLogin();
    expect(url).toContain('https://claude.com/cai/oauth/authorize');
    expect(url).toContain('code_challenge=');
    expect(url).toContain('code_challenge_method=S256');
    expect(url).toContain('client_id=');
    expect(url).toContain('response_type=code');
    expect(url).toContain('redirect_uri=https%3A%2F%2Fplatform.claude.com');
    expect(url).not.toContain('code=true');
    cancelLogin();
  });

  test('startLogin sets loginInProgress', async () => {
    const { startLogin, isLoginInProgress, cancelLogin } = await import('./meridian-login');
    await startLogin();
    expect(isLoginInProgress()).toBe(true);
    cancelLogin();
  });

  test('startLogin throws if login already in progress', async () => {
    const { startLogin, cancelLogin } = await import('./meridian-login');
    await startLogin();
    expect(() => startLogin()).toThrow('A login is already in progress');
    cancelLogin();
  });

  test('submitCode exchanges code for tokens and saves credentials', async () => {
    const mockWriteFileSync = vi.fn();
    vi.doMock('fs', () => ({
      unlinkSync: vi.fn(),
      writeFileSync: mockWriteFileSync,
    }));

    const { startLogin, submitCode } = await import('./meridian-login');
    await startLogin();

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'sk-ant-oat01-ACCESSTOKEN',
          refresh_token: 'sk-ant-ort01-REFRESHTOKEN',
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    );

    const result = await submitCode('test-auth-code');
    expect(result.success).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);

    const [url, opts] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('https://platform.claude.com/v1/oauth/token');
    expect(opts?.method).toBe('POST');
    expect(opts?.headers).toEqual({ 'Content-Type': 'application/json' });
    const body = JSON.parse(opts?.body as string);
    expect(body.grant_type).toBe('authorization_code');
    expect(body.code).toBe('test-auth-code');
    expect(body.code_verifier).toBeDefined();

    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const written = JSON.parse(mockWriteFileSync.mock.calls[0]![1]);
    expect(written.claudeAiOauth.accessToken).toBe('sk-ant-oat01-ACCESSTOKEN');
    expect(written.claudeAiOauth.refreshToken).toBe('sk-ant-ort01-REFRESHTOKEN');
    // The tokens go to the credentials file, never to the logs
    expectNoPartOf('sk-ant-oat01-ACCESSTOKEN', await loggedText());
    expectNoPartOf('sk-ant-ort01-REFRESHTOKEN', await loggedText());
  });

  test('submitCode logs no part of the authorization code', async () => {
    vi.doMock('fs', () => ({ unlinkSync: vi.fn(), writeFileSync: vi.fn() }));
    const { logger } = await import('@/server/lib/logger');
    const { startLogin, submitCode } = await import('./meridian-login');
    const code = 'QWERTYUIOPasdfghjkl-zxcvbnm';

    // A successful exchange, then a failed one whose error body echoes the code
    await startLogin();
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }), { status: 200 }),
    );
    await submitCode(code);
    await startLogin();
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'invalid_grant', error_description: `Unknown code ${code}` }), {
        status: 400,
      }),
    );
    const failed = await submitCode(code);

    expect(logger.info).toHaveBeenCalledWith('meridian.login.exchangingCode', {
      codeLength: code.length,
      redirectUri: expect.any(String),
      clientId: expect.any(String),
    });
    // Nor does the returned error, which the admin audit log stores
    expectNoPartOf(code, await loggedText());
    expectNoPartOf(code, failed.error);
  });

  test('submitCode reports only the status and OAuth error code of a failed exchange', async () => {
    const { logger } = await import('@/server/lib/logger');
    const { startLogin, submitCode, isLoginInProgress } = await import('./meridian-login');

    await startLogin();
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'anything', debug: 'x' }), {
        status: 400,
      }),
    );
    expect(await submitCode('some-code')).toEqual({
      success: false,
      error: 'Token exchange failed (400): invalid_grant',
    });
    expect(isLoginInProgress()).toBe(false);
    expect(logger.error).toHaveBeenCalledWith('meridian.login.tokenExchangeFailed', {
      status: 400,
      error: 'invalid_grant',
    });

    // A body that isn't an OAuth error (a proxy's error page) is left out entirely
    await startLogin();
    vi.mocked(fetch).mockResolvedValueOnce(new Response('<html>Bad Gateway</html>', { status: 502 }));
    expect((await submitCode('some-code')).error).toBe('Token exchange failed (502)');
    expect(logger.error).toHaveBeenCalledWith('meridian.login.tokenExchangeFailed', { status: 502 });
  });

  test('submitCode drops an error value that is not a known OAuth error code', async () => {
    const { startLogin, submitCode } = await import('./meridian-login');
    // Lowercase letters and underscores only, so it has the shape of an error code
    const code = 'authcode_abcdefgh_ijklmnop_secretvalue';

    await startLogin();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: code }), { status: 400 }));
    const result = await submitCode(code);
    expect(result).toEqual({ success: false, error: 'Token exchange failed (400)' });
    expectNoPartOf(code, await loggedText());
  });

  test('submitCode keeps request details and tokens out of network and file errors', async () => {
    const code = 'NETWORKCODE-1234567890';
    const writeFileSync = vi.fn(() => {
      throw new Error("ENOENT: no such file or directory, open '/missing/.credentials.json'");
    });
    vi.doMock('fs', () => ({ unlinkSync: vi.fn(), writeFileSync }));
    const { startLogin, submitCode } = await import('./meridian-login');

    // fetch keeps the failure's details in err.cause, which is never logged
    await startLogin();
    vi.mocked(fetch).mockRejectedValueOnce(
      new TypeError('fetch failed', { cause: new Error(`connect ECONNREFUSED while sending ${code}`) }),
    );
    expect(await submitCode(code)).toEqual({ success: false, error: 'fetch failed' });

    // A failed credentials write reports the path, not the tokens
    await startLogin();
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ access_token: 'sk-ant-oat01-WRITEFAILACCESS', refresh_token: 'r', expires_in: 3600 }),
        { status: 200 },
      ),
    );
    const failedWrite = await submitCode(code);
    expect(failedWrite.success).toBe(false);
    expectNoPartOf(code, await loggedText());
    expectNoPartOf('sk-ant-oat01-WRITEFAILACCESS', await loggedText());
    expectNoPartOf('sk-ant-oat01-WRITEFAILACCESS', failedWrite.error);
  });

  test('submitCode keeps a malformed token response out of the logs and the error', async () => {
    vi.doMock('fs', () => ({ unlinkSync: vi.fn(), writeFileSync: vi.fn() }));
    const { startLogin, submitCode } = await import('./meridian-login');
    await startLogin();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(MALFORMED_TOKEN_BODY, { status: 200 }));
    expect(await submitCode('some-code')).toEqual({ success: false, error: 'Malformed token response' });
    expectNoPartOf(MALFORMED_TOKEN_BODY, await loggedText());

    // So does a JSON body whose fields have the wrong types
    const crafted = 'sk-ant-oat01-CRAFTEDEXPIRESIN';
    await startLogin();
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: crafted }), { status: 200 }),
    );
    expect(await submitCode('some-code')).toEqual({ success: false, error: 'Malformed token response' });
    expectNoPartOf(crafted, await loggedText());
  });

  test('submitCode throws if no login in progress', async () => {
    const { submitCode } = await import('./meridian-login');
    await expect(submitCode('code')).rejects.toThrow('No login in progress');
  });

  test('cancelLogin clears state', async () => {
    const { startLogin, cancelLogin, isLoginInProgress } = await import('./meridian-login');
    await startLogin();
    expect(isLoginInProgress()).toBe(true);
    cancelLogin();
    expect(isLoginInProgress()).toBe(false);
  });

  test('logout clears pending login and removes credentials', async () => {
    const mockUnlinkSync = vi.fn();
    vi.doMock('fs', () => ({
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      unlinkSync: mockUnlinkSync,
    }));

    const { startLogin, isLoginInProgress, logout } = await import('./meridian-login');
    await startLogin();
    expect(isLoginInProgress()).toBe(true);

    const result = logout();
    expect(result.success).toBe(true);
    expect(isLoginInProgress()).toBe(false);
    expect(mockUnlinkSync.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  test('logout succeeds when credentials file is already absent', async () => {
    vi.doMock('fs', () => ({
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      unlinkSync: () => {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      },
    }));

    const { logout } = await import('./meridian-login');
    expect(logout()).toEqual({ success: true });
  });

  test('refreshIfNeeded refreshes expired token', async () => {
    const expiredCreds = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'old-access',
        refreshToken: 'test-refresh-token',
        expiresAt: Date.now() - 1000, // expired
      },
    });

    const mockWriteFileSync = vi.fn();
    vi.doMock('fs', () => ({
      readFileSync: () => expiredCreds,
      writeFileSync: mockWriteFileSync,
      unlinkSync: vi.fn(),
    }));

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    );

    const { refreshIfNeeded } = await import('./meridian-login');
    const result = await refreshIfNeeded();
    expect(result).toBe(true);

    const [url, opts] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('https://platform.claude.com/v1/oauth/token');
    const body = JSON.parse(opts?.body as string);
    expect(body.grant_type).toBe('refresh_token');
    expect(body.refresh_token).toBe('test-refresh-token');

    const written = JSON.parse(mockWriteFileSync.mock.calls[0]![1]);
    expect(written.claudeAiOauth.accessToken).toBe('new-access');
    expect(written.claudeAiOauth.refreshToken).toBe('new-refresh');
  });

  test('refreshIfNeeded logs only the status and OAuth error code of a failed refresh', async () => {
    const refreshToken = 'sk-ant-ort01-SECRETREFRESH';
    vi.doMock('fs', () => ({
      readFileSync: () =>
        JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken, expiresAt: Date.now() - 1000 } }),
      writeFileSync: vi.fn(),
      unlinkSync: vi.fn(),
    }));
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'invalid_grant', error_description: `Unknown token ${refreshToken}` }), {
        status: 400,
      }),
    );
    const { logger } = await import('@/server/lib/logger');
    const { refreshIfNeeded } = await import('./meridian-login');

    expect(await refreshIfNeeded()).toBe(false);
    expect(logger.error).toHaveBeenCalledWith('meridian.refresh.failed', { status: 400, error: 'invalid_grant' });
    expectNoPartOf(refreshToken, await loggedText());
  });

  test('refreshIfNeeded keeps a malformed token response out of the logs', async () => {
    vi.doMock('fs', () => ({
      readFileSync: () =>
        JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() - 1000 } }),
      writeFileSync: vi.fn(),
      unlinkSync: vi.fn(),
    }));
    const crafted = 'sk-ant-oat01-CRAFTEDEXPIRESIN';
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(MALFORMED_TOKEN_BODY, { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'a', expires_in: crafted }), { status: 200 }));
    const { refreshIfNeeded } = await import('./meridian-login');

    expect(await refreshIfNeeded()).toBe(false);
    // A JSON body whose fields have the wrong types (refresh logs expires_in)
    expect(await refreshIfNeeded()).toBe(false);
    expectNoPartOf(MALFORMED_TOKEN_BODY, await loggedText());
    expectNoPartOf(crafted, await loggedText());
  });

  test('refreshIfNeeded skips if token still valid', async () => {
    const validCreds = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'valid-access',
        refreshToken: 'test-refresh-token',
        expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour from now
      },
    });

    vi.doMock('fs', () => ({
      readFileSync: () => validCreds,
      writeFileSync: vi.fn(),
      unlinkSync: vi.fn(),
    }));

    const { refreshIfNeeded } = await import('./meridian-login');
    const result = await refreshIfNeeded();
    expect(result).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('refreshIfNeeded returns false with no credentials file', async () => {
    vi.doMock('fs', () => ({
      readFileSync: () => {
        throw new Error('ENOENT');
      },
      writeFileSync: vi.fn(),
      unlinkSync: vi.fn(),
    }));

    const { refreshIfNeeded } = await import('./meridian-login');
    const result = await refreshIfNeeded();
    expect(result).toBe(false);
  });

  test('parseOAuthUrl extracts URL from text', async () => {
    const { parseOAuthUrl } = await import('./meridian-login');
    expect(parseOAuthUrl('visit: https://claude.ai/oauth?foo=bar\n')).toBe('https://claude.ai/oauth?foo=bar');
    expect(parseOAuthUrl('visit: https://claude.com/cai/oauth?x=1')).toBe('https://claude.com/cai/oauth?x=1');
    expect(parseOAuthUrl('visit: https://platform.claude.com/oauth?y=2')).toBe('https://platform.claude.com/oauth?y=2');
    expect(parseOAuthUrl('no url')).toBeNull();
  });
});
