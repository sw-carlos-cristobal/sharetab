// Postgres aborts a transaction with a serialization failure (SQLSTATE 40001) when it cannot
// order it against concurrent transactions (under Repeatable Read: a concurrent committed
// write to a row it then updates), and with 40P01 on a deadlock. Either way nothing was
// committed, so the transaction can be re-run from the start. TRANSACTION_RETRY_ATTEMPTS
// counts runs, including the first. Backoff is capped exponential with full jitter, so a
// burst of writers to the same row spreads out instead of colliding again on every retry.
export const TRANSACTION_RETRY_ATTEMPTS = 10;
export const TRANSACTION_RETRY_BASE_DELAY_MS = 5;
export const TRANSACTION_RETRY_MAX_DELAY_MS = 100;

/** Walks nested properties of an untrusted value; undefined at the first missing step. */
function getPath(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (typeof current !== 'object' || current === null || !(key in current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * When the error means Postgres aborted the transaction with a serialization failure or
 * deadlock (so the whole transaction can be retried), returns its SQLSTATE (40001 / 40P01),
 * or the error's own code ('P2034' / 'TransactionWriteConflict') if it carries none;
 * otherwise undefined. With @prisma/adapter-pg the error takes one of two forms:
 * - a conflict raised by a query inside the transaction is a P2034 known request error,
 *   with the adapter's error in meta.driverAdapterError;
 * - a failure at COMMIT is rethrown as the raw DriverAdapterError, whose cause.kind is
 *   TransactionWriteConflict.
 */
export function transactionConflictCode(error: unknown): string | undefined {
  if (getPath(error, 'code') === 'P2034') {
    const sqlState = getPath(error, 'meta', 'driverAdapterError', 'cause', 'originalCode');
    return typeof sqlState === 'string' ? sqlState : 'P2034';
  }
  if (
    getPath(error, 'name') === 'DriverAdapterError' &&
    getPath(error, 'cause', 'kind') === 'TransactionWriteConflict'
  ) {
    const sqlState = getPath(error, 'cause', 'originalCode');
    return typeof sqlState === 'string' ? sqlState : 'TransactionWriteConflict';
  }
  return undefined;
}

/** True when the transaction was aborted by a serialization failure or deadlock and can be re-run. */
export function isTransactionConflict(error: unknown) {
  return transactionConflictCode(error) !== undefined;
}

/** Full-jitter exponential backoff: a random wait in [1, min(max, base * 2^attempt)] ms. */
export function retryDelayMs(attempt: number, random: () => number = Math.random) {
  const window = Math.min(TRANSACTION_RETRY_MAX_DELAY_MS, TRANSACTION_RETRY_BASE_DELAY_MS * 2 ** attempt);
  return Math.floor(random() * window) + 1;
}

/** Run a transaction, re-running it when Postgres aborts it with a serialization conflict. */
export async function withTransactionRetry<T>(run: () => Promise<T>): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= TRANSACTION_RETRY_ATTEMPTS - 1 || !isTransactionConflict(error)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
      attempt += 1;
    }
  }
}
