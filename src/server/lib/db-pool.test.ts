import { afterEach, expect, test, vi } from 'vitest';
import type pg from 'pg';
import { createPool, SEARCH_PATH_SQL } from './db-pool';
import { logger } from './logger';

let pool: pg.Pool | undefined;

afterEach(async () => {
  await pool?.end();
  pool = undefined;
});

test('each new connection sets search_path to public, so raw SQL finds the tables Prisma uses', () => {
  pool = createPool('postgresql://u:p@db.invalid:5432/sharetab');
  const query = vi.fn().mockResolvedValue({});
  pool.emit('connect', { query });
  expect(query).toHaveBeenCalledWith(SEARCH_PATH_SQL);
  expect(SEARCH_PATH_SQL).toBe('SET search_path TO public');
});

test('a failed SET does not crash the process (the query after it fails instead)', async () => {
  pool = createPool('postgresql://u:p@db.invalid:5432/sharetab');
  const query = vi.fn().mockRejectedValue(new Error('Connection terminated unexpectedly'));
  pool.emit('connect', { query });
  // An unhandled rejection would fail the run
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(query).toHaveBeenCalledOnce();
});

test('an idle connection dropped by the server is logged, not an unhandled error event', () => {
  pool = createPool('postgresql://u:p@db.invalid:5432/sharetab');
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  // With no 'error' listener, EventEmitter throws (and the server would exit)
  expect(() => pool?.emit('error', new Error('terminating connection due to administrator command'))).not.toThrow();
  expect(warn).toHaveBeenCalledWith('db.pool.idleClientError', {
    error: 'terminating connection due to administrator command',
  });
  warn.mockRestore();
});
