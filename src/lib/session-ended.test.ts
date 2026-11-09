import { describe, expect, it, vi } from 'vitest';
import {
  SIGNED_OUT_PARAM,
  createSessionEndedHandler,
  isSessionEndedError,
  retryCheckingSession,
  sessionEndpointSaysSignedOut,
  signInAgainUrl,
} from './session-ended';

/** The shape of a tRPC client error, as the query and mutation caches see it */
function trpcError(code: string, messageKey: string | null = null) {
  return Object.assign(new Error('x'), { data: { code, messageKey, httpStatus: 401 } });
}

describe('isSessionEndedError', () => {
  it('is the UNAUTHORIZED a procedure that needs a session answers without one', () => {
    expect(isSessionEndedError(trpcError('UNAUTHORIZED'))).toBe(true);
  });

  it('is not a wrong current password, which is UNAUTHORIZED with a key of its own', () => {
    expect(isSessionEndedError(trpcError('UNAUTHORIZED', 'wrongPassword'))).toBe(false);
  });

  it('is not any other error', () => {
    expect(isSessionEndedError(trpcError('FORBIDDEN', 'accountSuspended'))).toBe(false);
    expect(isSessionEndedError(trpcError('SERVICE_UNAVAILABLE'))).toBe(false);
    expect(isSessionEndedError(new Error('Failed to fetch'))).toBe(false);
    expect(isSessionEndedError(null)).toBe(false);
    expect(isSessionEndedError('UNAUTHORIZED')).toBe(false);
  });
});

describe('signInAgainUrl', () => {
  it('goes to sign-in in the page language, back to this page, with the notice', () => {
    const url = signInAgainUrl({ pathname: '/de/groups/g1', search: '?tab=balances' }, 'de');
    expect(url).not.toBeNull();
    const parsed = new URL(url!, 'http://localhost');
    expect(parsed.pathname).toBe('/de/login');
    expect(parsed.searchParams.get('callbackUrl')).toBe('/de/groups/g1?tab=balances');
    expect(parsed.searchParams.get(SIGNED_OUT_PARAM)).toBe('1');
  });

  it('leaves the pages the middleware lets through signed out alone', () => {
    for (const pathname of [
      '/en',
      '/en/login',
      '/en/register',
      '/en/forgot-password',
      '/en/reset-password',
      '/en/verify-request',
      '/en/split',
      '/en/split/abc123',
      '/en/split/abc123/claim',
      '/en/invite/xyz',
    ]) {
      expect(signInAgainUrl({ pathname, search: '' }, 'en'), pathname).toBeNull();
    }
  });

  it('treats a page whose name only starts like a public one as needing a session', () => {
    expect(signInAgainUrl({ pathname: '/en/splits', search: '' }, 'en')).not.toBeNull();
  });
});

describe('sessionEndpointSaysSignedOut', () => {
  const answer = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

  it('is false when the session endpoint takes too long', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort());
    try {
      const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.signal?.aborted) throw new DOMException('The operation timed out.', 'TimeoutError');
        return new Response('null', { status: 200 });
      });
      await expect(sessionEndpointSaysSignedOut(fetchImpl)).resolves.toBe(false);
    } finally {
      timeout.mockRestore();
    }
  });

  it('is true when the session endpoint answers with no session', async () => {
    const fetchImpl = answer(200, null);
    await expect(sessionEndpointSaysSignedOut(fetchImpl)).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/auth/session',
      expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) }),
    );
  });

  it('is false while someone is still signed in', async () => {
    await expect(sessionEndpointSaysSignedOut(answer(200, { user: { email: 'a@b.c' } }))).resolves.toBe(false);
  });

  it('is false when the session endpoint keeps the session because the database is down (503)', async () => {
    await expect(sessionEndpointSaysSignedOut(answer(503, { error: 'Service unavailable' }))).resolves.toBe(false);
  });

  it('is false when the request fails or the answer is not JSON', async () => {
    await expect(
      sessionEndpointSaysSignedOut(
        vi.fn(async () => {
          throw new TypeError('Failed to fetch');
        }),
      ),
    ).resolves.toBe(false);
    await expect(
      sessionEndpointSaysSignedOut(vi.fn(async () => new Response('<html>', { status: 200 }))),
    ).resolves.toBe(false);
  });
});

describe('retryCheckingSession', () => {
  it("retries like React Query's default: three times", () => {
    const retry = retryCheckingSession(vi.fn());
    expect([0, 1, 2, 3].map((failureCount) => retry(failureCount, new Error('Failed to fetch')))).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it('keeps retrying a request with no session, which a database blip also gives', () => {
    const retry = retryCheckingSession(vi.fn());
    expect(retry(0, trpcError('UNAUTHORIZED'))).toBe(true);
    expect(retry(3, trpcError('UNAUTHORIZED'))).toBe(false);
  });

  it('starts the session check on the first failure with no session, not on the retries', () => {
    const onSessionEnded = vi.fn();
    const retry = retryCheckingSession(onSessionEnded);
    const error = trpcError('UNAUTHORIZED');
    retry(0, error);
    expect(onSessionEnded).toHaveBeenCalledWith(error);
    retry(1, error);
    retry(2, error);
    retry(3, error);
    expect(onSessionEnded).toHaveBeenCalledTimes(1);
  });

  it('starts no check for other errors', () => {
    const onSessionEnded = vi.fn();
    const retry = retryCheckingSession(onSessionEnded);
    retry(0, trpcError('UNAUTHORIZED', 'wrongPassword'));
    retry(0, trpcError('INTERNAL_SERVER_ERROR'));
    retry(0, new Error('Failed to fetch'));
    expect(onSessionEnded).not.toHaveBeenCalled();
  });
});

describe('createSessionEndedHandler', () => {
  function setup(options: { signedOut?: boolean | (() => Promise<boolean>); pathname?: string } = {}) {
    const location = { pathname: options.pathname ?? '/en/settings', search: '' };
    const signedOut = options.signedOut ?? true;
    const checkSession = vi.fn(typeof signedOut === 'function' ? signedOut : async () => signedOut);
    const navigate = vi.fn();
    const handle = createSessionEndedHandler({
      checkSession,
      navigate,
      location: () => location,
      locale: () => 'en',
    });
    return { handle, checkSession, navigate, location };
  }

  it('sends the page to sign-in once the session endpoint confirms the session ended', async () => {
    const { handle, navigate } = setup();
    await handle(trpcError('UNAUTHORIZED'));
    expect(navigate).toHaveBeenCalledWith('/en/login?callbackUrl=%2Fen%2Fsettings&signedOut=1');
  });

  it('stays when the session endpoint does not confirm it (still signed in, database down, offline)', async () => {
    const { handle, navigate, checkSession } = setup({ signedOut: false });
    await handle(trpcError('UNAUTHORIZED'));
    expect(checkSession).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('checks again on a later error after a check that kept the page', async () => {
    let signedOut = false;
    const { handle, navigate, checkSession } = setup({ signedOut: async () => signedOut });
    await handle(trpcError('UNAUTHORIZED'));
    signedOut = true;
    await handle(trpcError('UNAUTHORIZED'));
    expect(checkSession).toHaveBeenCalledTimes(2);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('asks the session endpoint once for errors that arrive together, and navigates once', async () => {
    let finish: (value: boolean) => void = () => {};
    const { handle, navigate, checkSession } = setup({
      signedOut: () => new Promise<boolean>((resolve) => (finish = resolve)),
    });
    const first = handle(trpcError('UNAUTHORIZED'));
    const second = handle(trpcError('UNAUTHORIZED'));
    finish(true);
    await Promise.all([first, second]);
    await handle(trpcError('UNAUTHORIZED'));
    expect(checkSession).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('ignores other errors without asking the session endpoint', async () => {
    const { handle, navigate, checkSession } = setup();
    await handle(trpcError('UNAUTHORIZED', 'wrongPassword'));
    await handle(trpcError('FORBIDDEN'));
    expect(checkSession).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('leaves a public page alone without asking the session endpoint', async () => {
    const { handle, navigate, checkSession } = setup({ pathname: '/en/split/abc123' });
    await handle(trpcError('UNAUTHORIZED'));
    expect(checkSession).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('returns to the page the person is on once the check answers', async () => {
    let finish: (value: boolean) => void = () => {};
    const { handle, navigate, location } = setup({
      signedOut: () => new Promise<boolean>((resolve) => (finish = resolve)),
    });
    const pending = handle(trpcError('UNAUTHORIZED'));
    location.pathname = '/en/groups';
    finish(true);
    await pending;
    expect(navigate).toHaveBeenCalledWith('/en/login?callbackUrl=%2Fen%2Fgroups&signedOut=1');
  });

  it('stays when the person moved to a public page while the check ran', async () => {
    let finish: (value: boolean) => void = () => {};
    const { handle, navigate, location } = setup({
      signedOut: () => new Promise<boolean>((resolve) => (finish = resolve)),
    });
    const pending = handle(trpcError('UNAUTHORIZED'));
    location.pathname = '/en/split';
    finish(true);
    await pending;
    expect(navigate).not.toHaveBeenCalled();
  });
});
