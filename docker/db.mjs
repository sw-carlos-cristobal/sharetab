// Database steps for docker/entrypoint.sh, run through node-postgres, the
// driver the app itself uses (@prisma/adapter-pg), so DATABASE_URL is read the
// same way here as by the app. psql reads it differently: it rejects
// parameters node-postgres accepts (sslmode=no-verify, uselibpqcompat=true,
// schema=...), and accepts sslmode=require against a certificate node-postgres
// refuses, so an entrypoint using psql could pass a URL the app can't use or
// refuse one it can.
//
//   node db.mjs wait                    wait until DATABASE_URL accepts a connection
//   node db.mjs run <label> <file>...   run SQL files, printing NOTICE/WARNING messages
//
// `wait` retries only while the server may still be coming up (unreachable,
// unresolvable, not answering, or starting), for DB_WAIT_SECONDS (default
// 60). A refused login, a missing database, or an untrusted certificate fails
// at once with the reason, since waiting won't fix it.
//
// `run` sends each file as one simple query, so a file's statements run in a
// single implicit transaction and an error rolls back the whole file (psql -f
// ran them one at a time). So a file can't hold CREATE INDEX CONCURRENTLY or
// VACUUM, can't add an enum value and use it (split that into two files), and
// can't use psql meta-commands or :variables.
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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
]);

// node-postgres raises these without a code (pg/lib/client.js): its
// connectionTimeoutMillis, and a server closing the connection mid-startup.
const RETRYABLE_MESSAGES = /^(timeout expired|Connection terminated unexpectedly)$/;

const TLS_CERT_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

const DEFAULT_WAIT_SECONDS = 60;

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

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return '';
  }
}

// What to do about a failed connection, or '' when there is nothing to add.
export function hint(err, url) {
  const host = hostOf(url);
  if (err.code === 'ERR_TLS_CERT_ALTNAME_INVALID' && isIP(host) !== 0) {
    // node-postgres sends no server name for an IP address, so Node checks the
    // certificate against "localhost" (pg/lib/connection.js)
    return (
      "Certificate checks don't work with an IP address in DATABASE_URL: use the host name " +
      'the certificate was issued for, or sslmode=no-verify to encrypt without verifying.'
    );
  }
  if (TLS_CERT_CODES.has(err.code)) {
    return (
      "The server's TLS certificate isn't trusted. Note that sslmode=require verifies the " +
      'certificate here, unlike in psql. Mount the CA certificate and set NODE_EXTRA_CA_CERTS ' +
      'to its path, or use sslmode=no-verify to encrypt without verifying.'
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
    return 'The server has TLS off; remove sslmode from DATABASE_URL or set sslmode=disable.';
  }
  if (err.code === 'ECONNREFUSED' && LOOPBACK_HOSTS.has(host)) {
    return (
      'Inside the container, localhost is the container itself. Use the database host name ' +
      'here, or unset DATABASE_URL to use the bundled database.'
    );
  }
  return '';
}

// host:port/database, without credentials or parameters
export function describeTarget(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || '5432'}${u.pathname}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

export function waitSeconds(env) {
  const value = env.DB_WAIT_SECONDS ?? '';
  return /^[1-9][0-9]*$/.test(value) ? Number(value) : DEFAULT_WAIT_SECONDS;
}

// Connects, runs SELECT 1, and disconnects; throws node-postgres's error.
export async function checkConnection(url, { timeoutMs = 5000 } = {}) {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: timeoutMs });
  try {
    await client.connect();
    await client.query('SELECT 1');
  } finally {
    await client.end().catch(() => {});
  }
}

// Calls check() until it resolves, a non-retryable error, or `seconds` pass.
// Returns whether the database is ready.
export async function waitForDatabase({ url, check, sleep, now, log, seconds }) {
  const target = describeTarget(url);
  const deadline = now() + seconds * 1000;
  let lastLogged = '';
  for (;;) {
    try {
      await check();
      log.info(`Database is ready (${target}).`);
      return true;
    } catch (err) {
      const reason = describeError(err);
      if (!isRetryable(err)) {
        log.error(`ERROR: cannot use the database at ${target}: ${reason}`);
        const advice = hint(err, url);
        if (advice) log.error(advice);
        return false;
      }
      if (now() >= deadline) {
        log.error(`ERROR: the database at ${target} did not answer in ${seconds}s: ${reason}`);
        log.error(hint(err, url) || 'Raise DB_WAIT_SECONDS if it is slow to start.');
        return false;
      }
      if (reason !== lastLogged) {
        lastLogged = reason;
        log.info(`Waiting for the database at ${target}: ${reason}`);
      }
      await sleep(1000);
    }
  }
}

// The 1-based line holding a 1-based character position.
function lineAt(text, position) {
  return text.slice(0, Math.max(0, position - 1)).split('\n').length;
}

// Runs each file on `client` (a pg.Client, connected), stopping at the first
// error. Returns whether all of them succeeded; closes the client either way.
export async function runSqlFiles({ client, label, files, readFile, log }) {
  client.on('notice', (notice) => log.info(`${notice.severity}:  ${notice.message}`));
  try {
    for (const file of files) {
      log.info(`Running ${label}: ${basename(file)}...`);
      const sql = readFile(file);
      try {
        await client.query(sql);
      } catch (err) {
        const line = err.position ? `, line ${lineAt(sql, Number(err.position))}` : '';
        log.error(`ERROR: ${basename(file)}${line}: ${describeError(err)}`);
        // The rest of what psql printed for an error
        if (err.detail) log.error(`DETAIL:  ${err.detail}`);
        if (err.hint) log.error(`HINT:  ${err.hint}`);
        if (err.where) log.error(`CONTEXT:  ${err.where}`);
        return false;
      }
    }
    return true;
  } finally {
    await client.end().catch(() => {});
  }
}

async function main(argv, env) {
  const log = { info: (line) => console.log(line), error: (line) => console.error(line) };
  const url = env.DATABASE_URL;
  if (!url) {
    log.error('ERROR: DATABASE_URL is not set.');
    return 1;
  }
  const [command, ...rest] = argv;
  if (command === 'wait' && rest.length === 0) {
    const ok = await waitForDatabase({
      url,
      check: () => checkConnection(url),
      sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
      now: () => Date.now(),
      log,
      seconds: waitSeconds(env),
    });
    return ok ? 0 : 1;
  }
  if (command === 'run' && rest.length >= 2) {
    const [label, ...files] = rest;
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10000 });
    try {
      await client.connect();
    } catch (err) {
      log.error(`ERROR: cannot connect to the database at ${describeTarget(url)}: ${describeError(err)}`);
      return 1;
    }
    const readFile = (file) => readFileSync(file, 'utf8');
    return (await runSqlFiles({ client, label, files, readFile, log })) ? 0 : 1;
  }
  log.error('usage: node db.mjs wait | run <label> <file>...');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
