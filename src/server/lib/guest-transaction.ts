import { TRPCError } from '@trpc/server';
import { Prisma, type PrismaClient } from '@/generated/prisma/client';
import { logger } from './logger';
import { transactionConflictCode, withTransactionRetry, TRANSACTION_RETRY_ATTEMPTS } from './transaction-retry';

// Every claim-session transaction in the guest router reads one GuestSplit row (by
// shareToken, or by id when saving person ids) and writes back only that row. Under Repeatable Read, a concurrent committed
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
 *
 * Prisma's transaction manager errors (P2028) become SERVICE_UNAVAILABLE without a retry
 * (#203). P2028 covers several transaction lifecycle failures, e.g. no pool connection
 * freeing up within maxWait, the transaction running past its timeout, or a transaction
 * already closed or not found; retrying the pool case would add load while the pool is
 * full. They all get the same handling rather than being told apart by message, which
 * isn't a stable API; the log keeps Prisma's message.
 */
export async function guestTransaction<T>(
  db: Pick<PrismaClient, '$transaction'>,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  try {
    return await withTransactionRetry(() => db.$transaction(fn, { isolationLevel: GUEST_TRANSACTION_ISOLATION }));
  } catch (error) {
    if (isTransactionManagerError(error)) {
      logger.warn('guest.transaction.unavailable', { code: 'P2028', message: error.message });
      throw new TRPCError({
        code: 'SERVICE_UNAVAILABLE',
        message: 'ShareTab is busy right now. Please try again in a moment.',
        cause: error,
      });
    }
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

/**
 * Prisma's transaction manager error (P2028). The runtime throws it as an Error subclass
 * carrying the code, and it may also arrive as a PrismaClientKnownRequestError, so match
 * on the code.
 */
function isTransactionManagerError(error: unknown): error is Error {
  return error instanceof Error && (error as { code?: unknown }).code === 'P2028';
}
