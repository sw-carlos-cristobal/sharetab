import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const startProxyServer = vi.fn();
const refreshIfNeeded = vi.fn();

vi.mock('@rynfar/meridian', () => ({ startProxyServer }));
vi.mock('../../lib/meridian-login', () => ({ refreshIfNeeded }));
vi.mock('@/server/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('MeridianProvider proxy start', () => {
  beforeEach(() => {
    vi.resetModules();
    startProxyServer.mockReset();
    refreshIfNeeded.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"status":"healthy"}', { status: 200 })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('tries to start the proxy again after a failed start', async () => {
    startProxyServer.mockRejectedValueOnce(new Error("Cannot find module '@libsql/linux-x64-musl'"));
    startProxyServer.mockResolvedValueOnce(undefined);
    const { MeridianProvider } = await import('./meridian');

    expect(await new MeridianProvider().isAvailable()).toBe(false);
    expect(await new MeridianProvider().isAvailable()).toBe(true);
    expect(startProxyServer).toHaveBeenCalledTimes(2);
  });

  test('tries again when the token refresh before the start fails', async () => {
    refreshIfNeeded.mockRejectedValueOnce(new Error('Refresh token expired'));
    startProxyServer.mockResolvedValue(undefined);
    const { MeridianProvider } = await import('./meridian');

    expect(await new MeridianProvider().isAvailable()).toBe(false);
    expect(await new MeridianProvider().isAvailable()).toBe(true);
  });

  test('logs why the proxy failed to start', async () => {
    startProxyServer.mockRejectedValueOnce(new Error("Cannot find module '@libsql/linux-x64-musl'"));
    const { MeridianProvider } = await import('./meridian');
    const { logger } = await import('@/server/lib/logger');

    await new MeridianProvider().isAvailable();

    expect(logger.error).toHaveBeenCalledWith(
      'meridian.start.failed',
      expect.objectContaining({ error: "Cannot find module '@libsql/linux-x64-musl'" }),
    );
  });

  test('starts the proxy once when it is healthy', async () => {
    startProxyServer.mockResolvedValue(undefined);
    const { MeridianProvider } = await import('./meridian');

    await new MeridianProvider().isAvailable();
    await new MeridianProvider().isAvailable();

    expect(startProxyServer).toHaveBeenCalledTimes(1);
  });
});
