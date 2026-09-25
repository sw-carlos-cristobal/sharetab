import { afterEach, beforeEach, describe, test, expect, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import {
  isTransactionConflict,
  retryDelayMs,
  transactionConflictCode,
  withTransactionRetry,
  TRANSACTION_RETRY_ATTEMPTS,
  TRANSACTION_RETRY_BASE_DELAY_MS,
  TRANSACTION_RETRY_MAX_DELAY_MS,
} from './transaction-retry';

// Prisma 7 with @prisma/adapter-pg surfaces a Postgres serialization failure at COMMIT
// of an interactive transaction as a raw DriverAdapterError instead of a
// PrismaClientKnownRequestError with code P2034. Shape (see DriverAdapterError in
// @prisma/driver-adapter-utils and convertDriverError in @prisma/adapter-pg):
// { name: 'DriverAdapterError', cause: { kind, originalCode, originalMessage } }.
function driverAdapterError(kind: string, originalCode: string) {
  const error = new Error(kind);
  error.name = 'DriverAdapterError';
  (error as Error & { cause: unknown }).cause = {
    kind,
    originalCode,
    originalMessage: 'could not serialize access due to read/write dependencies among transactions',
  };
  return error;
}

function p2034Error() {
  return Object.assign(new Error('Transaction failed due to a write conflict or a deadlock'), { code: 'P2034' });
}

// A conflict raised by a query inside the transaction (e.g. a Repeatable Read UPDATE) is
// mapped to P2034 and keeps the adapter error in meta. Shape captured from a real
// PrismaClientKnownRequestError (Prisma 7.10.0, @prisma/adapter-pg, PostgreSQL 18).
function p2034WithSqlState(originalCode: string) {
  return Object.assign(p2034Error(), {
    meta: {
      modelName: 'GuestSplit',
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          originalCode,
          originalMessage: 'could not serialize access due to concurrent update',
          kind: 'TransactionWriteConflict',
        },
      },
    },
  });
}

describe('transactionConflictCode', () => {
  test('reports the SQLSTATE a P2034 error carries from the driver adapter', () => {
    expect(transactionConflictCode(p2034WithSqlState('40001'))).toBe('40001');
    expect(transactionConflictCode(p2034WithSqlState('40P01'))).toBe('40P01');
  });

  test('falls back to P2034 when the error carries no SQLSTATE', () => {
    expect(transactionConflictCode(p2034Error())).toBe('P2034');
  });

  test('reports the SQLSTATE of a raw DriverAdapterError conflict', () => {
    expect(transactionConflictCode(driverAdapterError('TransactionWriteConflict', '40001'))).toBe('40001');
  });

  test('is undefined for anything that is not a transaction conflict', () => {
    expect(transactionConflictCode(driverAdapterError('UniqueConstraintViolation', '23505'))).toBeUndefined();
    expect(transactionConflictCode(new TRPCError({ code: 'NOT_FOUND', message: 'Session not found' }))).toBeUndefined();
    expect(transactionConflictCode(undefined)).toBeUndefined();
  });
});

describe('isTransactionConflict', () => {
  test('recognizes a P2034 error that carries the SQLSTATE in meta', () => {
    expect(isTransactionConflict(p2034WithSqlState('40001'))).toBe(true);
  });

  test('recognizes a Prisma P2034 known request error', () => {
    expect(isTransactionConflict(p2034Error())).toBe(true);
  });

  test('recognizes a DriverAdapterError with kind TransactionWriteConflict (serialization failure)', () => {
    expect(isTransactionConflict(driverAdapterError('TransactionWriteConflict', '40001'))).toBe(true);
  });

  test('recognizes a DriverAdapterError for a deadlock (40P01 maps to TransactionWriteConflict)', () => {
    expect(isTransactionConflict(driverAdapterError('TransactionWriteConflict', '40P01'))).toBe(true);
  });

  test('ignores a DriverAdapterError of another kind', () => {
    expect(isTransactionConflict(driverAdapterError('UniqueConstraintViolation', '23505'))).toBe(false);
  });

  test('ignores application errors and non-objects', () => {
    expect(isTransactionConflict(new TRPCError({ code: 'NOT_FOUND', message: 'Session not found' }))).toBe(false);
    expect(isTransactionConflict(new Error('TransactionWriteConflict'))).toBe(false);
    expect(isTransactionConflict(null)).toBe(false);
    expect(isTransactionConflict('P2034')).toBe(false);
  });
});

describe('retryDelayMs', () => {
  test('first retry waits at most the base delay', () => {
    expect(retryDelayMs(0, () => 0)).toBe(1);
    expect(retryDelayMs(0, () => 0.999)).toBe(TRANSACTION_RETRY_BASE_DELAY_MS);
  });

  test('the jitter window doubles with each retry', () => {
    expect(retryDelayMs(1, () => 0.999)).toBe(TRANSACTION_RETRY_BASE_DELAY_MS * 2);
    expect(retryDelayMs(2, () => 0.999)).toBe(TRANSACTION_RETRY_BASE_DELAY_MS * 4);
  });

  test('the jitter window is capped at the max delay', () => {
    expect(retryDelayMs(30, () => 0.999)).toBe(TRANSACTION_RETRY_MAX_DELAY_MS);
  });

  test('always waits at least 1ms', () => {
    for (let attempt = 0; attempt < TRANSACTION_RETRY_ATTEMPTS; attempt++) {
      expect(retryDelayMs(attempt, () => 0)).toBe(1);
    }
  });
});

describe('withTransactionRetry', () => {
  // Shortest backoff so the retry tests stay fast and deterministic.
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('returns the result without retrying when the first attempt succeeds', async () => {
    const run = vi.fn().mockResolvedValue('ok');
    await expect(withTransactionRetry(run)).resolves.toBe('ok');
    expect(run).toHaveBeenCalledTimes(1);
  });

  test('retries after a DriverAdapterError serialization conflict and returns the retry result', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(driverAdapterError('TransactionWriteConflict', '40001'))
      .mockResolvedValueOnce('ok');
    await expect(withTransactionRetry(run)).resolves.toBe('ok');
    expect(run).toHaveBeenCalledTimes(2);
  });

  test('retries after a P2034 conflict', async () => {
    const run = vi.fn().mockRejectedValueOnce(p2034Error()).mockResolvedValueOnce('ok');
    await expect(withTransactionRetry(run)).resolves.toBe('ok');
    expect(run).toHaveBeenCalledTimes(2);
  });

  test('does not retry a non-conflict error', async () => {
    const notFound = new TRPCError({ code: 'NOT_FOUND', message: 'Session not found' });
    const run = vi.fn().mockRejectedValue(notFound);
    await expect(withTransactionRetry(run)).rejects.toBe(notFound);
    expect(run).toHaveBeenCalledTimes(1);
  });

  test('gives up after the attempt budget and rethrows the last conflict', async () => {
    const conflict = driverAdapterError('TransactionWriteConflict', '40001');
    const run = vi.fn().mockRejectedValue(conflict);
    await expect(withTransactionRetry(run)).rejects.toBe(conflict);
    expect(run).toHaveBeenCalledTimes(TRANSACTION_RETRY_ATTEMPTS);
  });
});
