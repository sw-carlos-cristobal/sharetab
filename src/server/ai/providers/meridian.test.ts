import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.mock factories are hoisted above these declarations, so the mocks they
// return come from vi.hoisted.
const { startProxyServer, refreshIfNeeded, proxyClose } = vi.hoisted(() => ({
  startProxyServer: vi.fn(),
  refreshIfNeeded: vi.fn(),
  proxyClose: vi.fn(async () => undefined),
}));
const proxyInstance = () => ({ close: proxyClose });

vi.mock('@rynfar/meridian', () => ({ startProxyServer }));
vi.mock('../../lib/meridian-login', () => ({ refreshIfNeeded }));
vi.mock('@/server/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Meridian refuses to start without a machine-id; once the file exists, a
// retry succeeds. (A missing module can't recover this way: Node caches the
// failed import.)
const MISSING_MACHINE_ID = new Error('[PROXY] Refusing to start: cannot capture a process incarnation on this host');

describe('MeridianProvider proxy start', () => {
  beforeEach(() => {
    vi.resetModules();
    startProxyServer.mockReset();
    proxyClose.mockClear();
    refreshIfNeeded.mockReset().mockResolvedValue(false);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"status":"healthy"}', { status: 200 })),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test('tries to start the proxy again after a failed start', async () => {
    startProxyServer.mockRejectedValueOnce(MISSING_MACHINE_ID);
    startProxyServer.mockResolvedValueOnce(proxyInstance());
    const { MeridianProvider } = await import('./meridian');

    expect(await new MeridianProvider().isAvailable()).toBe(false);
    expect(await new MeridianProvider().isAvailable()).toBe(true);
    expect(startProxyServer).toHaveBeenCalledTimes(2);
  });

  test('concurrent callers share one start attempt', async () => {
    startProxyServer.mockRejectedValueOnce(MISSING_MACHINE_ID);
    startProxyServer.mockResolvedValueOnce(proxyInstance());
    const { MeridianProvider } = await import('./meridian');

    const results = await Promise.all([new MeridianProvider().isAvailable(), new MeridianProvider().isAvailable()]);

    expect(results).toEqual([false, false]);
    expect(startProxyServer).toHaveBeenCalledTimes(1);
    expect(await new MeridianProvider().isAvailable()).toBe(true);
    expect(startProxyServer).toHaveBeenCalledTimes(2);
  });

  test('logs why the proxy failed to start', async () => {
    startProxyServer.mockRejectedValueOnce(MISSING_MACHINE_ID);
    const { MeridianProvider } = await import('./meridian');
    const { logger } = await import('@/server/lib/logger');

    await new MeridianProvider().isAvailable();

    expect(logger.error).toHaveBeenCalledWith(
      'meridian.start.failed',
      expect.objectContaining({ error: MISSING_MACHINE_ID.message }),
    );
  });

  test('logs a rejection that is not an Error', async () => {
    startProxyServer.mockRejectedValueOnce('listen EADDRINUSE');
    const { MeridianProvider } = await import('./meridian');
    const { logger } = await import('@/server/lib/logger');

    await new MeridianProvider().isAvailable();

    expect(logger.error).toHaveBeenCalledWith('meridian.start.failed', { error: 'listen EADDRINUSE' });
  });

  test('treats a proxy that never answers as a failed start and stops it', async () => {
    // startProxyServer resolves before the server listens; a failed listen
    // only shows up as /health never answering. The half-started proxy's
    // timers must not outlive the attempt.
    vi.useFakeTimers();
    startProxyServer.mockResolvedValue(proxyInstance());
    vi.mocked(fetch).mockRejectedValue(new TypeError('fetch failed'));
    const { MeridianProvider } = await import('./meridian');

    const first = new MeridianProvider().isAvailable();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await first).toBe(false);
    expect(proxyClose).toHaveBeenCalledTimes(1);

    vi.mocked(fetch).mockResolvedValue(new Response('{"status":"healthy"}', { status: 200 }));
    expect(await new MeridianProvider().isAvailable()).toBe(true);
    expect(startProxyServer).toHaveBeenCalledTimes(2);
  });

  test('waits up to 10 seconds for the proxy to answer', async () => {
    vi.useFakeTimers();
    startProxyServer.mockResolvedValue(proxyInstance());
    let calls = 0;
    vi.mocked(fetch).mockImplementation(async () => {
      calls += 1;
      if (calls < 30) throw new TypeError('fetch failed'); // ~7.5s of refusals
      return new Response('{"status":"healthy"}', { status: 200 });
    });
    const { MeridianProvider } = await import('./meridian');

    const available = new MeridianProvider().isAvailable();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await available).toBe(true);
  });

  test('fails the start when something other than Meridian answers on the port', async () => {
    startProxyServer.mockResolvedValue(proxyInstance());
    vi.mocked(fetch).mockResolvedValueOnce(new Response('<html>Not Found</html>', { status: 404 }));
    const { MeridianProvider, getMeridianStartError } = await import('./meridian');

    expect(await new MeridianProvider().isAvailable()).toBe(false);
    expect(getMeridianStartError()).toMatch(/other than Meridian/);
    expect(proxyClose).toHaveBeenCalledTimes(1);

    expect(await new MeridianProvider().isAvailable()).toBe(true);
    expect(startProxyServer).toHaveBeenCalledTimes(2);
  });

  test('records a message for an Error that has none', async () => {
    startProxyServer.mockRejectedValueOnce(new Error(''));
    const { MeridianProvider, getMeridianStartError } = await import('./meridian');

    await new MeridianProvider().isAvailable();

    expect(getMeridianStartError()).toBe('Meridian proxy failed to start');
  });

  test('counts a proxy that answers /health with an error status as started', async () => {
    // Meridian answers 503 when unhealthy (e.g. draining, or no boot
    // identity); it is listening, so restarting it would not help.
    startProxyServer.mockResolvedValue(proxyInstance());
    vi.mocked(fetch).mockResolvedValue(new Response('{"status":"unhealthy"}', { status: 503 }));
    const { MeridianProvider } = await import('./meridian');

    expect(await new MeridianProvider().isAvailable()).toBe(false);
    expect(await new MeridianProvider().isAvailable()).toBe(false);
    expect(startProxyServer).toHaveBeenCalledTimes(1);
  });

  test('starts the proxy once when it is healthy', async () => {
    startProxyServer.mockResolvedValue(proxyInstance());
    const { MeridianProvider } = await import('./meridian');

    await new MeridianProvider().isAvailable();
    await new MeridianProvider().isAvailable();

    expect(startProxyServer).toHaveBeenCalledTimes(1);
  });
});

describe('startMeridianProxy / getMeridianStartError', () => {
  beforeEach(() => {
    vi.resetModules();
    startProxyServer.mockReset();
    proxyClose.mockClear();
    refreshIfNeeded.mockReset().mockResolvedValue(false);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"status":"healthy"}', { status: 200 })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('reports the last start error until a start succeeds', async () => {
    startProxyServer.mockRejectedValueOnce(MISSING_MACHINE_ID);
    startProxyServer.mockResolvedValueOnce(proxyInstance());
    const { MeridianProvider, getMeridianStartError } = await import('./meridian');

    expect(getMeridianStartError()).toBeNull();
    await new MeridianProvider().isAvailable();
    expect(getMeridianStartError()).toBe(MISSING_MACHINE_ID.message);
    await new MeridianProvider().isAvailable();
    expect(getMeridianStartError()).toBeNull();
  });

  test('startMeridianProxy settles after a failed start without rejecting', async () => {
    startProxyServer.mockRejectedValueOnce(MISSING_MACHINE_ID);
    const { startMeridianProxy, getMeridianStartError } = await import('./meridian');

    await expect(startMeridianProxy()).resolves.toBeUndefined();
    expect(getMeridianStartError()).toBe(MISSING_MACHINE_ID.message);
    expect(startProxyServer).toHaveBeenCalledTimes(1);
  });

  test('startMeridianProxy settles once the proxy answers', async () => {
    startProxyServer.mockResolvedValue(proxyInstance());
    const { startMeridianProxy, getMeridianStartError } = await import('./meridian');

    await expect(startMeridianProxy()).resolves.toBeUndefined();
    expect(getMeridianStartError()).toBeNull();
    expect(vi.mocked(fetch)).toHaveBeenCalled();
  });
});
