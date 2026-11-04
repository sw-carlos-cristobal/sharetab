// The logic behind docker/db.mjs, the entrypoint's database steps; see that
// file for the commands. Kept apart so the tests can import it and db.mjs
// itself always runs as a command.
import { isIP } from 'node:net';
import { basename, dirname } from 'node:path';
import pg from 'pg';

const RETRYABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND', // DNS for a service name may not exist until its container starts
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  '57P03', // cannot_connect_now: the server is starting up or shutting down
  '57P01', // admin_shutdown and crash_shutdown: it went down between sign-in
  '57P02', // and the query, a restart or a failover
  '08000', // connection_exception
  '08003', // connection_does_not_exist
  '08006', // connection_failure
  '53300', // too_many_connections: other sessions may end
]);

// node-postgres raises these without a code (pg/lib/client.js): its
// connectionTimeoutMillis, its query_timeout, and a server closing the
// connection.
const RETRYABLE_MESSAGES = /^(timeout expired|Query read timeout|Connection terminated unexpectedly)$/;

const TLS_CERT_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

// Connection settings a driver may take from the query string instead of the
// URL itself (node-postgres reads host, port, user and password there; libpq
// also hostaddr and dbname): with one there, the log could name a different
// server or database than the one used
const CONNECTION_PARAMS = ['host', 'hostaddr', 'port', 'user', 'password', 'dbname'];

const DEFAULT_WAIT_SECONDS = 60;

// Sign-in and SELECT 1 may each take this long in one connection attempt
const ATTEMPT_TIMEOUT_MS = 5000;

export function isRetryable(err) {
  return RETRYABLE_CODES.has(err.code) || RETRYABLE_MESSAGES.test(err.message);
}

// The error's message and code. Node reports a name with several addresses
// (localhost: ::1 and 127.0.0.1) as an AggregateError with an empty message.
export function describeError(err) {
  const message =
    err.message || (Array.isArray(err.errors) ? err.errors.map((e) => e.message).join('; ') : '') || String(err);
  return err.code ? `${message} (${err.code})` : message;
}

// The URL's host, port, database and parameters, or null when it isn't a
// postgresql://user:password@host:port/database URL that parses cleanly.
// A password with an unencoded / ? or # ends the URL's host part early, so the
// rest of the password lands in the path, query or fragment, with the real
// "@host" after it: so any "@" after that point makes it ambiguous, even
// when an "@" came before it ("p@ss/x?y" reads as host "ss"). A stray % (one
// that isn't an escape) can't be decoded. Either way nothing is printed from
// it. In bundled mode bundledUrl built the URL, with the user name and
// password encoded, so an @ or : after the host part is in DB_NAME.
function parseTarget(url, mode = 'external') {
  const afterScheme = /^[a-z][a-z0-9+.-]*:\/\/(.*)$/is.exec(url)?.[1];
  if (afterScheme === undefined) return null;
  const hostPartEnd = afterScheme.search(/[/?#]/);
  const bundled = mode === 'bundled';
  if (!bundled && hostPartEnd !== -1 && afterScheme.slice(hostPartEnd).includes('@')) return null;
  let u, database;
  try {
    u = new URL(url);
    decodeURIComponent(u.username);
    decodeURIComponent(u.password);
    database = decodeURIComponent(u.pathname.slice(1));
  } catch {
    return null;
  }
  if (u.protocol !== 'postgresql:' && u.protocol !== 'postgres:') return null;
  // A postgresql:// URL with no path has an empty pathname, not "/". (A Unix
  // socket, an empty host with ?host=, isn't supported: new URL refuses
  // credentials without a host.)
  if (!u.hostname || !(bundled ? /^(\/[^/?#]*)?$/ : /^(\/[^/@:?#]*)?$/).test(u.pathname)) return null;
  return {
    host: u.hostname.replace(/^\[|\]$/g, ''),
    hostname: u.hostname,
    port: u.port || '5432',
    database,
    params: u.searchParams,
  };
}

// The host, port and database node-postgres (the app's driver) would use, or
// the error it throws reading the URL (it opens sslrootcert, sslcert and
// sslkey files right away). It decodes the database name with decodeURI,
// which leaves an escaped reserved character (%2F, %40, %24) as it is, unlike
// WHATWG URL and Prisma, and doesn't trim spaces.
function driverTarget(url) {
  try {
    const client = new pg.Client({ connectionString: url });
    return { host: String(client.host).replace(/^\[|\]$/g, ''), port: String(client.port), database: client.database };
  } catch (err) {
    return { error: err };
  }
}

// host:port/database, without credentials or parameters
export function describeTarget(url, mode = 'external') {
  const target = parseTarget(url, mode);
  return target ? `${target.hostname}:${target.port}/${target.database}` : '(unparseable DATABASE_URL)';
}

const ENCODING_HINT =
  'If the user name or password has any of : / ? # @ [ ] % in it, percent-encode them ' +
  '(for example / as %2F), or use a password of letters and digits.';

// Why DATABASE_URL can't be used as it is, or '' when it can. Never echoes it.
export function urlProblem(url, mode = 'external') {
  if (url !== url.trim()) {
    return (
      'DATABASE_URL has spaces or line breaks around it, which node-postgres, the app\'s driver, ' +
      "doesn't strip, so it would read a different host or database: remove them."
    );
  }
  // pg-connection-string re-encodes the whole URL when it holds a space or a
  // % that isn't an escape, so a percent-encoded password would reach the
  // server still encoded
  if (/ |%[^a-f0-9]|%[a-f0-9][^a-f0-9]/i.test(url)) {
    return (
      "DATABASE_URL has a space, or a % that isn't part of an escape such as %2F, in it. node-postgres, " +
      "the app's driver, then re-encodes the whole URL, so a percent-encoded password wouldn't match: " +
      'percent-encode those too (a space as %20, a % as %25).'
    );
  }
  const target = parseTarget(url, mode);
  if (!target) {
    return (
      "DATABASE_URL isn't a postgresql://user:password@host:port/database URL that can be read " +
      `(an @ in a query value, and a Unix socket, aren't supported: use a host and port). ${ENCODING_HINT}`
    );
  }
  if (!target.database) {
    return (
      'DATABASE_URL has no database name (postgresql://user:password@host:port/database). Without ' +
      "one, the app and Prisma's schema step would each pick a different database. " +
      ENCODING_HINT
    );
  }
  // Every occurrence: node-postgres and Prisma may each take a different one
  if (target.params.getAll('schema').some((schema) => schema !== 'public')) {
    return (
      "DATABASE_URL names a schema (?schema=), but ShareTab uses the public schema: the app's driver " +
      "ignores the parameter while Prisma's schema step honors it, so they'd use different tables. " +
      'Remove it, and give ShareTab a database of its own instead.'
    );
  }
  const param = CONNECTION_PARAMS.find((name) => target.params.has(name));
  if (param) {
    return (
      `DATABASE_URL has a ${param}= parameter, which a driver may read instead of what the URL itself says. ` +
      'Put the host, port, user, password and database in the URL instead.'
    );
  }
  const driver = driverTarget(url);
  if (driver.error) {
    return `node-postgres, the app's driver, can't use DATABASE_URL: ${describeError(driver.error)}`;
  }
  if (driver.host !== target.host || driver.port !== target.port || driver.database !== target.database) {
    return (
      "node-postgres, the app's driver, reads DATABASE_URL as a different host, port or database " +
      'than it says (an escaped reserved character such as %2F or %40 in the database name?), so the ' +
      "app and Prisma's schema step would disagree. Use a database name of letters, digits and _."
    );
  }
  return '';
}

// What to do about a failed connection, or '' when there is nothing to add.
// In bundled mode the entrypoint built DATABASE_URL from DB_USER, DB_PASSWORD
// and DB_NAME, so a sign-in problem is about those.
export function hint(err, url, mode = 'external') {
  const host = parseTarget(url, mode)?.host ?? '';
  if (mode === 'bundled' && ['28P01', '28000', '3D000'].includes(err.code)) {
    return (
      'DB_USER, DB_PASSWORD and DB_NAME only take effect when the bundled data folder is first created: ' +
      'set them back to the values it was created with. If that first start was interrupted, the ' +
      'folder holds no ShareTab data yet: move it aside and start again.'
    );
  }
  const noVerify = 'sslmode=no-verify encrypts without checking who answers, so use it only on a network you trust.';
  if (err.code === 'ERR_TLS_CERT_ALTNAME_INVALID' && isIP(host) !== 0) {
    // node-postgres sends no server name for an IP address, so Node checks the
    // certificate against "localhost" (pg/lib/connection.js)
    return (
      "Certificate checks don't work with an IP address in DATABASE_URL: use the host name the " +
      `certificate was issued for. ${noVerify}`
    );
  }
  if (err.code === 'CERT_HAS_EXPIRED') {
    return "The server's TLS certificate has expired: renew it on the server.";
  }
  if (TLS_CERT_CODES.has(err.code)) {
    return (
      "The server's TLS certificate isn't trusted. Note that sslmode=require checks the certificate " +
      'here, unlike in psql. Mount the CA certificate and set NODE_EXTRA_CA_CERTS to its path, with ' +
      `sslmode=verify-full and the certificate's host name in DATABASE_URL. ${noVerify}`
    );
  }
  if (err.code === '28P01') {
    return 'Check the user name and password in DATABASE_URL.';
  }
  if (err.code === '28000' && /pg_hba\.conf/.test(err.message)) {
    return (
      "The server's pg_hba.conf has no entry that lets this container connect. Add one for the " +
      "container's address, user and database, or, if the entry is hostssl, add sslmode to DATABASE_URL."
    );
  }
  if (err.code === '28000') {
    return 'Check the user name in DATABASE_URL.';
  }
  if (err.code === '3D000') {
    return 'Create the database first: ShareTab creates its tables, not the database.';
  }
  if (/does not support SSL/i.test(err.message)) {
    return (
      "The server doesn't offer TLS. If it should, something in between may be answering in its place: " +
      'check the network path. Otherwise turn TLS on in the server, or, on a network you trust, remove ' +
      'sslmode from DATABASE_URL.'
    );
  }
  if (mode !== 'bundled' && err.code === 'ECONNREFUSED' && LOOPBACK_HOSTS.has(host)) {
    return (
      'Inside the container, localhost is the container itself. Use the database host name ' +
      'here, or unset DATABASE_URL to use the bundled database.'
    );
  }
  return '';
}

export function waitSeconds(env) {
  const value = env.DB_WAIT_SECONDS ?? '';
  return /^[1-9][0-9]*$/.test(value) ? Number(value) : DEFAULT_WAIT_SECONDS;
}

// A warning when DB_WAIT_SECONDS is set but not usable, or ''.
export function waitSecondsWarning(env) {
  const value = env.DB_WAIT_SECONDS ?? '';
  if (value === '' || /^[1-9][0-9]*$/.test(value)) return '';
  return `WARNING: DB_WAIT_SECONDS=${value} isn't a whole number of seconds; waiting ${DEFAULT_WAIT_SECONDS}.`;
}

// The bundled database's URL. The user name and password are
// percent-encoded, so / # @ or % in them still make a valid one. The database
// name is escaped with encodeURI, which leaves reserved characters ($ + @ :)
// as they are: node-postgres decodes it with decodeURI, which would leave
// their escapes undecoded. A / ? or # can't be escaped that way, and raw it
// would end the name for one driver and not the other, so that throws.
export function bundledUrl(env) {
  const user = env.DB_USER || 'sharetab';
  const password = env.DB_PASSWORD || 'sharetab';
  const name = env.DB_NAME || 'sharetab';
  if (/[/?#]/.test(name)) {
    throw new Error(
      "DB_NAME has a / ? or # in it, which the app's driver and Prisma's schema step would read " +
        'differently from a database URL. ' +
        'Use a database name of letters, digits and _.',
    );
  }
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@localhost:5432/${encodeURI(name)}`;
}

// The first error each client reported as an 'error' event. One the server
// sent between calls (a shutdown right after sign-in) only reaches the next
// query as "not queryable", so that query's failure is reported as this one.
const connectionErrors = new WeakMap();

// A client whose connection errors reject the call in progress instead of
// crashing the process: node-postgres also emits them as an 'error' event,
// which kills Node when nothing listens.
function newClient(url, options) {
  const client = new pg.Client({ connectionString: url, ...options });
  client.on('error', (err) => {
    if (!connectionErrors.has(client)) connectionErrors.set(client, err);
  });
  return client;
}

// Closes the client without waiting on a server that has stopped answering.
async function close(client) {
  await Promise.race([client.end().catch(() => {}), new Promise((done) => setTimeout(done, 1000).unref())]);
}

// Connects, runs SELECT 1, and disconnects; throws node-postgres's error.
// Sign-in is bounded by connectionTimeoutMillis (which only the client
// config sets) and the query by its own query_timeout, set on the query
// because a ?query_timeout= in the URL would override one on the client.
// A shutdown between sign-in and the query is thrown as itself (see
// connectionErrors), so a restart is retried.
export async function checkConnection(url, { timeoutMs = ATTEMPT_TIMEOUT_MS } = {}) {
  const client = newClient(url, { connectionTimeoutMillis: timeoutMs });
  try {
    await client.connect();
    await client.query({ text: 'SELECT 1', query_timeout: timeoutMs });
  } catch (err) {
    throw connectionErrors.get(client) ?? err;
  } finally {
    await close(client);
  }
}

// Calls check() until it resolves, a non-retryable error, or `seconds` pass
// (plus up to two attempt timeouts). Returns whether the database is ready.
export async function waitForDatabase({ url, check, sleep, now, log, seconds, mode = 'external' }) {
  const problem = urlProblem(url, mode);
  if (problem) {
    log.error(`ERROR: ${problem}`);
    return false;
  }
  const target = describeTarget(url, mode);
  const deadline = now() + seconds * 1000;
  const logged = new Set();
  for (;;) {
    try {
      await check();
      log.info(`Database is ready (${target}).`);
      return true;
    } catch (err) {
      const reason = describeError(err);
      const advice = hint(err, url, mode);
      if (!isRetryable(err)) {
        log.error(`ERROR: cannot use the database at ${target}: ${reason}`);
        if (advice) log.error(advice);
        return false;
      }
      if (now() >= deadline) {
        log.error(`ERROR: the database at ${target} did not answer in ${seconds}s: ${reason}`);
        log.error(advice || 'Raise DB_WAIT_SECONDS if it is slow to start.');
        return false;
      }
      if (!logged.has(reason)) {
        logged.add(reason);
        log.info(`Waiting for the database at ${target}: ${reason}`);
        // Said now rather than only at give-up: a localhost URL left from
        // when it meant the bundled server would otherwise wait in silence
        if (advice) log.info(advice);
      }
      await sleep(1000);
    }
  }
}

// prisma/migrations/x.sql → migrations/x.sql
function fileLabel(file) {
  return `${basename(dirname(file))}/${basename(file)}`;
}

// The 1-based line holding a 1-based character position (characters, as
// PostgreSQL counts them, not UTF-16 code units).
function lineAt(text, position) {
  return Array.from(text)
    .slice(0, Math.max(0, position - 1))
    .join('')
    .split('\n').length;
}

// Runs one SQL file on `client` (a connected pg.Client). Returns whether it
// succeeded.
export async function runSqlFile({ client, file, readFile, log }) {
  const label = fileLabel(file);
  client.on('notice', (notice) => log.info(`${notice.severity}:  ${notice.message}`));
  log.info(`Running ${label}...`);
  let sql;
  try {
    sql = readFile(file);
    await client.query(sql);
    return true;
  } catch (err) {
    const line = sql !== undefined && err.position ? `, line ${lineAt(sql, Number(err.position))}` : '';
    log.error(`ERROR: ${label}${line}: ${describeError(err)}`);
    // The rest of what psql printed for an error
    if (err.detail) log.error(`DETAIL:  ${err.detail}`);
    if (err.hint) log.error(`HINT:  ${err.hint}`);
    if (err.where) log.error(`CONTEXT:  ${err.where}`);
    return false;
  }
}

// The model names in a Prisma schema, which are its table names (ShareTab's
// schema maps none to other names, with @@map, and db.test.mjs keeps it so).
// Commented-out lines don't count.
export function parseModels(schemaText) {
  return [...schemaText.matchAll(/^\s*model\s+(\w+)\s*\{/gm)].map(([, name]) => name);
}

// Tables a ShareTab database may hold that aren't models: Prisma's own
// migrations table (prisma db push leaves it alone), and the names of models
// ShareTab has since removed or renamed, whose tables existing databases
// still have. Removing or renaming a model? Add its old name here, or every
// upgraded external install refuses to start (db.test.mjs checks this).
export const RETIRED_TABLES = ['_prisma_migrations'];

// The tables Auth.js's Prisma adapter gives any app: having only these
// doesn't make a database ShareTab's.
const AUTHJS_TABLES = ['Account', 'Session', 'User', 'VerificationToken'];

// Prisma's table for an implicit many-to-many relation between two models:
// _<A>To<B>.
function isRelationTable(table, models) {
  if (!table.startsWith('_')) return false;
  const name = table.slice(1);
  for (let at = name.indexOf('To'); at > 0; at = name.indexOf('To', at + 1)) {
    if (models.includes(name.slice(0, at)) && models.includes(name.slice(at + 2))) return true;
  }
  return false;
}

// Why the database's tables make it unsafe for ShareTab, or '' when every
// table in it is one of ShareTab's (a model, a retired model, a relation
// table) and at least one is more than Auth.js's: an empty database, a
// ShareTab one, or a first start that stopped part way. prisma db push drops empty
// tables its schema doesn't have, and won't start while one holds rows; it
// tries to drop an extension's tables too (PostGIS's spatial_ref_sys, say),
// which fails, so those count as well.
export function schemaProblem(tables, models) {
  const relevant = tables.filter((table) => !RETIRED_TABLES.includes(table));
  if (relevant.length === 0) return '';
  const foreign = relevant.filter((table) => !models.includes(table) && !isRelationTable(table, models));
  if (foreign.length === 0) {
    if (relevant.some((table) => !AUTHJS_TABLES.includes(table))) return '';
    return (
      `The database holds only Auth.js's tables (${relevant.join(', ')}), so it isn't ShareTab's: ` +
      'probably another app that signs people in with Auth.js. ShareTab needs a database of its own: ' +
      "create one and point DATABASE_URL at it. (If it is ShareTab's own and its first start stopped " +
      'before creating the rest, drop those tables and start again.)'
    );
  }
  const shown = foreign.slice(0, 5).join(', ');
  const more = foreign.length > 5 ? ` and ${foreign.length - 5} more` : '';
  return (
    `The database holds tables ShareTab doesn't have (${shown}${more}). ShareTab's schema step ` +
    "drops empty tables it doesn't know and won't start while one holds rows (or while an " +
    "extension, such as PostGIS, has tables there), so it needs a database of its own: create one " +
    'and point DATABASE_URL at it. (If they come from a newer ShareTab, after going back to an older ' +
    "build, restore the backup taken before the upgrade instead: don't leave the data behind.)"
  );
}

// Reads the public schema's tables on `client` (connected) and refuses a
// database that holds any ShareTab doesn't have. With refuseEmpty (the
// entrypoint's first external start when the container has a bundled
// database), an empty database is refused too: it is more likely a wrong
// DATABASE_URL, or data not moved yet, than a deliberate fresh start.
export async function checkSchema({ client, models, log, refuseEmpty = false }) {
  let rows;
  try {
    ({ rows } = await client.query(
      'SELECT c.relname AS table_name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace ' +
        "WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY 1",
    ));
  } catch (err) {
    log.error(`ERROR: cannot list the database's tables: ${describeError(err)}`);
    return false;
  }
  const tables = rows.map((row) => row.table_name);
  const problem = schemaProblem(tables, models);
  if (problem) {
    log.error(`ERROR: ${problem}`);
    return false;
  }
  if (refuseEmpty && tables.every((table) => RETIRED_TABLES.includes(table))) {
    log.error(
      "ERROR: The database is empty, and this container's data folder still holds the bundled database " +
        "it used before. ShareTab didn't copy that data. To move it, load it into this database first " +
        "(the README's \"Moving to an external database\"); if DATABASE_URL points at the wrong " +
        'database, fix it. To start with no data, set ALLOW_EMPTY_EXTERNAL_DB=true for this start.',
    );
    return false;
  }
  return true;
}

// Connects, hands the client to work(client), and closes it, returning
// work's answer; or logs why it couldn't connect and returns false. No
// query_timeout: a migration may take a while. search_path is set to public,
// where Prisma (whose queries name the schema) keeps ShareTab's tables, so
// the SQL files' unqualified names find them whatever the URL's options= or
// the role's own search_path say.
export async function withClient(url, log, work, mode = 'external') {
  const problem = urlProblem(url, mode);
  if (problem) {
    log.error(`ERROR: ${problem}`);
    return false;
  }
  const client = newClient(url, { connectionTimeoutMillis: 10000 });
  try {
    try {
      await client.connect();
      await client.query('SET search_path TO public');
    } catch (failure) {
      const err = connectionErrors.get(client) ?? failure;
      log.error(`ERROR: cannot connect to the database at ${describeTarget(url, mode)}: ${describeError(err)}`);
      const advice = hint(err, url, mode);
      if (advice) log.error(advice);
      return false;
    }
    return await work(client);
  } finally {
    await close(client);
  }
}

