import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import type { Prisma, PrismaClient } from '@/generated/prisma/client';

vi.mock('./logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { logger } = await import('./logger');
const { guestTransaction, GUEST_TRANSACTION_ISOLATION } = await import('./guest-transaction');
const { TRANSACTION_RETRY_ATTEMPTS } = await import('./transaction-retry');

const tx = { marker: 'tx' } as unknown as Prisma.TransactionClient;

// A $transaction stand-in: each call either rejects with the next queued error or runs the callback.
function mockDb(failures: unknown[] = []) {
  const queue = [...failures];
  const $transaction = vi.fn(async (fn: (client: Prisma.TransactionClient) => Promise<unknown>) => {
    const failure = queue.shift();
    if (failure !== undefined) throw failure;
    return fn(tx);
  });
  return { $transaction, db: { $transaction } as unknown as Pick<PrismaClient, '$transaction'> };
}

// What a Repeatable Read UPDATE conflict looks like in production: a P2034 known request
// error carrying the adapter's error (and SQLSTATE) in meta.
function serializationFailure() {
  return Object.assign(new Error('Transaction failed due to a write conflict or a deadlock'), {
    code: 'P2034',
    meta: {
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: { kind: 'TransactionWriteConflict', originalCode: '40001' },
      },
    },
  });
}

beforeEach(() => {
  // Shortest backoff so exhausting the retry budget stays fast and deterministic.
  vi.spyOn(Math, 'random').mockReturnValue(0);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(logger.warn).mockClear();
});

describe('guestTransaction', () => {
  test('runs the callback in a Repeatable Read transaction and returns its result', async () => {
    const { $transaction, db } = mockDb();
    await expect(guestTransaction(db, async (client) => ({ sameTx: client === tx }))).resolves.toEqual({
      sameTx: true,
    });
    expect(GUEST_TRANSACTION_ISOLATION).toBe('RepeatableRead');
    expect($transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'RepeatableRead' });
  });

  test('re-runs the transaction after a serialization failure', async () => {
    const { $transaction, db } = mockDb([serializationFailure()]);
    await expect(guestTransaction(db, async () => 'ok')).resolves.toBe('ok');
    expect($transaction).toHaveBeenCalledTimes(2);
  });

  test('turns a conflict that outlasts the retry budget into a CONFLICT error and logs it', async () => {
    const last = serializationFailure();
    const failures = [...Array.from({ length: TRANSACTION_RETRY_ATTEMPTS - 1 }, serializationFailure), last];
    const { $transaction, db } = mockDb(failures);

    const error = await guestTransaction(db, async () => 'never').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe('CONFLICT');
    expect((error as TRPCError).cause).toBe(last);
    // The raw database message must not reach the (unauthenticated) client.
    expect((error as TRPCError).message).not.toMatch(/serializ|write conflict|TransactionWriteConflict/i);
    expect($transaction).toHaveBeenCalledTimes(TRANSACTION_RETRY_ATTEMPTS);
    expect(logger.warn).toHaveBeenCalledWith('guest.transaction.retries_exhausted', {
      attempts: TRANSACTION_RETRY_ATTEMPTS,
      code: '40001',
    });
  });

  test('passes application errors through without retrying or logging', async () => {
    const notFound = new TRPCError({ code: 'NOT_FOUND', message: 'Session not found' });
    const { $transaction, db } = mockDb([notFound]);
    await expect(guestTransaction(db, async () => 'never')).rejects.toBe(notFound);
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
