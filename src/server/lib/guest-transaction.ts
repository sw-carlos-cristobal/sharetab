import { TRPCError } from '@trpc/server';
import { Prisma, type PrismaClient } from '@/generated/prisma/client';
import { logger } from './logger';
import { transactionConflictCode, withTransactionRetry, TRANSACTION_RETRY_ATTEMPTS } from './transaction-retry';

// Every claim-session transaction in the guest router reads one GuestSplit row by
// shareToken and writes back only that row. Under Repeatable Read, a concurrent committed
// write to that row makes the later writer's UPDATE fail with a serialization failure,
// which guestTransaction re-runs, so no update is lost. Serializable also aborted
// transactions on *different* sessions, which surfaced as random join/claim failures
// under load (#196).
// Read Committed + SELECT ... FOR UPDATE would queue writers instead of retrying them,
// but needs raw SQL; this keeps plain Prisma queries.
// Repeatable Read allows write skew across rows: if a transaction here ever writes a row
// other than the one it read, revisit this choice.
export const GUEST_TRANSACTION_ISOLATION = Prisma.TransactionIsolationLevel.RepeatableRead;

/**
 * Run a guest claim-session transaction, re-running it on serialization conflicts.
 * `fn` must read and write only the one GuestSplit row it looks up (see
 * GUEST_TRANSACTION_ISOLATION), and may run more than once, so keep side effects
 * such as logging outside it.
 * A conflict that outlasts the retry budget becomes a CONFLICT error with a generic
 * message, so the raw database error never reaches the client.
 */
export async function guestTransaction<T>(
  db: Pick<PrismaClient, '$transaction'>,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  try {
    return await withTransactionRetry(() => db.$transaction(fn, { isolationLevel: GUEST_TRANSACTION_ISOLATION }));
  } catch (error) {
    const code = transactionConflictCode(error);
    if (code === undefined) throw error;
    logger.warn('guest.transaction.retries_exhausted', { attempts: TRANSACTION_RETRY_ATTEMPTS, code });
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Someone else is updating this split right now. Please try again.',
      cause: error,
    });
  }
}
