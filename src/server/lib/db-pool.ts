import pg from 'pg';
import { logger } from './logger';

// Prisma keeps ShareTab's tables in the public schema and names it in its own
// queries, but the raw SQL in the routers (row locks, for one) and the
// entrypoint's SQL files use unqualified names. A role's default search_path
// or an options= in DATABASE_URL can point those elsewhere, so every
// connection sets it back.
export const SEARCH_PATH_SQL = 'SET search_path TO public';

// The app's connection pool. node-postgres runs a client's queries in order,
// so the SET sent on 'connect' runs before the first query the pool hands the
// client out for.
export function createPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({ connectionString });
  pool.on('connect', (client) => {
    // A connection that fails here fails the query queued after it, which
    // reports the error; an unhandled rejection would crash the server
    client.query(SEARCH_PATH_SQL).catch(() => undefined);
  });
  // An idle connection the server or the network drops is reported here; an
  // 'error' event nobody listens for would take the server down. The pool
  // replaces the connection on the next query.
  pool.on('error', (err) => {
    logger.warn('db.pool.idleClientError', { error: err.message });
  });
  return pool;
}
