// Database steps for docker/entrypoint.sh, run through node-postgres, the
// driver the app itself uses (@prisma/adapter-pg), so DATABASE_URL is read the
// same way here as by the app. psql reads it differently: it rejects
// parameters node-postgres accepts (sslmode=no-verify, uselibpqcompat=true,
// schema=...), and accepts sslmode=require against a certificate node-postgres
// refuses, so an entrypoint using psql could pass a URL the app can't use or
// refuse one it can. (prisma db push, between the SQL phases, has its own
// parser again; see the README's "Using an external PostgreSQL".) It refuses
// some URLs the app would take, where the two might read them differently.
//
//   node db.mjs wait                    wait until DATABASE_URL accepts a connection
//   node db.mjs check-schema [--refuse-empty] <schema>
//                                       refuse a database that holds another app's tables
//                                       (and, with --refuse-empty, an empty one)
//   node db.mjs run <file>              run one SQL file, printing NOTICE/WARNING messages
//   node db.mjs target                  print host:port/database, for the startup summary
//   node db.mjs bundled-url             print the bundled database's URL, from DB_USER,
//                                       DB_PASSWORD and DB_NAME (exit 1 for a DB_NAME
//                                       no URL can carry)
//
// `wait` retries only while the server may still be coming up (unreachable,
// unresolvable, not answering, starting or restarting), for about
// DB_WAIT_SECONDS (default 60). An unusable URL, a refused login, a missing
// database or an untrusted certificate fails at once with the reason, since
// waiting won't fix it. DB_MODE=bundled (set by the entrypoint) points its
// hints at DB_USER/DB_PASSWORD/DB_NAME instead of DATABASE_URL.
//
// `run` sends the file as one simple query, so its statements run in a single
// implicit transaction and an error rolls back the whole file (psql -f ran
// them one at a time). So a file can't hold CREATE INDEX CONCURRENTLY or
// VACUUM alongside other statements, can't add an enum value and use it
// (split that into two files), and can't use psql meta-commands or
// :variables.
import { readFileSync } from 'node:fs';
import {
  bundledUrl,
  checkConnection,
  checkSchema,
  describeError,
  describeTarget,
  parseModels,
  runSqlFile,
  waitForDatabase,
  waitSeconds,
  waitSecondsWarning,
  withClient,
} from './db-lib.mjs';

async function main(argv, env) {
  const log = { info: (line) => console.log(line), error: (line) => console.error(line) };
  const [command, ...rest] = argv;
  if (command === 'bundled-url' && rest.length === 0) {
    try {
      console.log(bundledUrl(env));
    } catch (err) {
      log.error(`ERROR: ${err.message}`);
      return 1;
    }
    return 0;
  }
  const url = env.DATABASE_URL;
  if (!url) {
    log.error('ERROR: DATABASE_URL is not set.');
    return 1;
  }
  const mode = env.DB_MODE === 'bundled' ? 'bundled' : 'external';
  if (command === 'target' && rest.length === 0) {
    console.log(describeTarget(url, mode));
    return 0;
  }
  if (command === 'wait' && rest.length === 0) {
    const warning = waitSecondsWarning(env);
    if (warning) log.error(warning);
    const ok = await waitForDatabase({
      url,
      check: () => checkConnection(url),
      sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
      now: () => Date.now(),
      log,
      seconds: waitSeconds(env),
      mode,
    });
    return ok ? 0 : 1;
  }
  const refuseEmpty = command === 'check-schema' && rest[0] === '--refuse-empty';
  const schemaArgs = refuseEmpty ? rest.slice(1) : rest;
  if (command === 'check-schema' && schemaArgs.length === 1) {
    const [schema] = schemaArgs;
    let models;
    try {
      models = parseModels(readFileSync(schema, 'utf8'));
    } catch (err) {
      log.error(`ERROR: cannot read ${schema}: ${describeError(err)}`);
      return 1;
    }
    const ok = await withClient(url, log, (client) => checkSchema({ client, models, log, refuseEmpty }), mode);
    return ok ? 0 : 1;
  }
  if (command === 'run' && rest.length === 1) {
    const readFile = (path) => readFileSync(path, 'utf8');
    const ok = await withClient(url, log, (client) => runSqlFile({ client, file: rest[0], readFile, log }), mode);
    return ok ? 0 : 1;
  }
  log.error('usage: node db.mjs wait | check-schema [--refuse-empty] <schema.prisma> | run <file> | target | bundled-url');
  return 2;
}

const code = await main(process.argv.slice(2), process.env);
// Let the log reach Docker before exiting: on a pipe, writes are asynchronous
// and process.exit drops what's still queued
await Promise.all([process.stdout, process.stderr].map((stream) => new Promise((done) => stream.write('', done))));
// Exit explicitly: a socket left open by a server that stopped answering would
// otherwise keep Node running
process.exit(code);
