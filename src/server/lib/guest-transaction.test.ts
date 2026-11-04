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

// Prisma's transaction manager raises P2028 (TransactionManagerError) when no pool connection
// frees up within maxWait, or when the transaction runs past its timeout. The runtime throws
// it as an Error subclass carrying the code, not necessarily a PrismaClientKnownRequestError.
function transactionManagerError(message: string) {
  return Object.assign(new Error(`Transaction API error: ${message}`), {
    name: 'TransactionManagerError',
    code: 'P2028',
    meta: {},
  });
}
const poolTimeout = () => transactionManagerError('Unable to start a transaction in the given time.');
const expired = () =>
  transactionManagerError(
    'A commit cannot be executed on an expired transaction. The timeout for this transaction was 5000 ms, however 5012 ms passed since the start of the transaction. Consider increasing the interactive transaction timeout or doing less work in the transaction.',
  );

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

  test.each([
    ['no pool connection frees up in time', poolTimeout],
    ['the transaction runs past its timeout', expired],
  ])('fails fast with SERVICE_UNAVAILABLE when %s (P2028), and logs it (#203)', async (_case, makeError) => {
    const busy = makeError();
    const { $transaction, db } = mockDb([busy]);

    const error = await guestTransaction(db, async () => 'never').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe('SERVICE_UNAVAILABLE');
    expect((error as TRPCError).cause).toBe(busy);
    expect((error as TRPCError).message).not.toMatch(/Transaction API error|P2028|timeout/i);
    // Retrying would add load while the pool is already full
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('guest.transaction.unavailable', {
      code: 'P2028',
      message: busy.message,
    });
  });

  test('treats a P2028 known request error the same way', async () => {
    const { Prisma } = await import('@/generated/prisma/client');
    const busy = new Prisma.PrismaClientKnownRequestError(
      'Transaction API error: Unable to start a transaction in the given time.',
      { code: 'P2028', clientVersion: 'test' },
    );
    const { db } = mockDb([busy]);
    await expect(guestTransaction(db, async () => 'never')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  test('passes application errors through without retrying or logging', async () => {
    const notFound = new TRPCError({ code: 'NOT_FOUND', message: 'Session not found' });
    const { $transaction, db } = mockDb([notFound]);
    await expect(guestTransaction(db, async () => 'never')).rejects.toBe(notFound);
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
