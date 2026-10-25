import { afterEach, describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import pg from 'pg';
import {
  bundledUrl,
  checkConnection,
  checkSchema,
  describeError,
  describeTarget,
  hint,
  isRetryable,
  parseModels,
  RETIRED_TABLES,
  runSqlFile,
  schemaProblem,
  urlProblem,
  waitForDatabase,
  waitSeconds,
  withClient,
} from './db-lib.mjs';

// ── Fake servers, so classification is tested on errors node-postgres really
// raises rather than hand-built ones ─────────────────────────────────────────

const servers = [];
const sockets = new Set();

afterEach(async () => {
  // A server socket that's never read never sees the client hang up, and
  // close() waits for every connection
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

// Starts a TCP server on 127.0.0.1 that hands each connection to onSocket;
// resolves to its port.
async function serve(onSocket) {
  const server = createServer(onSocket);
  server.on('connection', (socket) => sockets.add(socket));
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

// A port nothing listens on.
async function closedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// A Postgres ErrorResponse message ('E'): severity, SQLSTATE, message.
function errorResponse(code, message) {
  const fields = [`SFATAL`, `VFATAL`, `C${code}`, `M${message}`].map((f) => Buffer.from(`${f}\0`));
  const body = Buffer.concat([...fields, Buffer.from([0])]);
  const length = Buffer.alloc(4);
  length.writeInt32BE(body.length + 4);
  return Buffer.concat([Buffer.from('E'), length, body]);
}

// A server that answers the startup message with an ErrorResponse.
function refusingServer(code, message) {
  return serve((socket) => {
    socket.once('data', () => socket.end(errorResponse(code, message)));
  });
}

// AuthenticationOk ('R', 0) then ReadyForQuery ('Z', idle): the login works.
const loginOk = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0, 0x5a, 0, 0, 0, 5, 0x49]);

// CommandComplete ('C', "SELECT 1") then ReadyForQuery: the query worked.
const queryOk = Buffer.concat([
  Buffer.from([0x43, 0, 0, 0, 13]),
  Buffer.from('SELECT 1\0'),
  Buffer.from([0x5a, 0, 0, 0, 5, 0x49]),
]);

// CommandComplete ('C', "SET") then ReadyForQuery.
const setOk = Buffer.concat([Buffer.from([0x43, 0, 0, 0, 8]), Buffer.from('SET\0'), Buffer.from([0x5a, 0, 0, 0, 5, 0x49])]);

// A server that lets the client sign in, answers withClient's SET search_path,
// and hands the first other query to onQuery. `seen` records what happened:
// whether a query arrived, each query's text, whether the client hung up.
function signedInServer(onQuery) {
  const seen = { query: false, queries: [], clientEnded: false };
  const port = serve((socket) => {
    socket.on('end', () => {
      seen.clientEnded = true;
    });
    socket.once('data', () => {
      socket.write(loginOk);
      socket.on('data', (data) => {
        // 'Q': a simple query (the client's hang-up is 'X')
        if (data[0] !== 0x51) return;
        const text = data.subarray(5, data.length - 1).toString();
        seen.queries.push(text);
        if (text === 'SET search_path TO public') {
          socket.write(setOk);
        } else if (!seen.query) {
          seen.query = true;
          onQuery(socket);
        }
      });
    });
  });
  return port.then((p) => ({ port: p, seen }));
}

// Long enough for sign-in on a busy runner; the tests that time out on
// purpose pass a shorter one
async function errorFrom(url, options = { timeoutMs: 2000 }) {
  try {
    await checkConnection(url, options);
  } catch (err) {
    return err;
  }
  throw new Error('expected the connection to fail');
}

const url = (port, params = 'sslmode=disable') => `postgresql://sharetab:secret@127.0.0.1:${port}/sharetab?${params}`;

describe('isRetryable, on errors node-postgres raises', () => {
  test('a refused connection is retried', async () => {
    const err = await errorFrom(url(await closedPort()));
    expect(err.code).toBe('ECONNREFUSED');
    expect(isRetryable(err)).toBe(true);
  });

  test('a server that never answers times out and is retried', async () => {
    const port = await serve(() => {});
    const err = await errorFrom(url(port));
    expect(err.message).toBe('timeout expired');
    expect(isRetryable(err)).toBe(true);
  });

  test('a server that drops the connection is retried', async () => {
    const port = await serve((socket) => socket.destroy());
    const err = await errorFrom(url(port), { timeoutMs: 1000 });
    expect(isRetryable(err)).toBe(true);
  });

  test('a server that signs the client in, then never answers the query, times out and is retried', async () => {
    const { port, seen } = await signedInServer(() => {});
    const started = Date.now();
    const err = await errorFrom(url(port));
    expect(seen.query).toBe(true);
    expect(err.message).toBe('Query read timeout');
    expect(Date.now() - started).toBeLessThan(3000);
    expect(isRetryable(err)).toBe(true);
    // and hangs up, so the retries don't pile up connections
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen.clientEnded).toBe(true);
  });

  test('a server that shuts down right after sign-in, before the query, is retried', async () => {
    // The FATAL arrives before SELECT 1 is sent: node-postgres reports it as
    // an 'error' event, and the query only fails with "not queryable"
    const port = await serve((socket) =>
      socket.once('data', () =>
        socket.end(Buffer.concat([loginOk, errorResponse('57P01', 'terminating connection due to administrator command')])),
      ),
    );
    const err = await errorFrom(url(port), { timeoutMs: 1000 });
    expect(err.code).toBe('57P01');
    expect(isRetryable(err)).toBe(true);
  });

  test('a query_timeout in the URL can’t stretch the attempt', async () => {
    const { port, seen } = await signedInServer(() => {});
    const started = Date.now();
    const err = await errorFrom(url(port, 'query_timeout=60000&sslmode=disable'), { timeoutMs: 1000 });
    expect(seen.query).toBe(true);
    expect(err.message).toBe('Query read timeout');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test('a server that drops the connection after sign-in is retried, not a crash', async () => {
    // Without an error listener on the client, node-postgres emits this as
    // an unhandled 'error' event and the process exits
    const { port, seen } = await signedInServer((socket) => socket.destroy());
    const err = await errorFrom(url(port));
    expect(seen.query).toBe(true);
    expect(err.message).toBe('Connection terminated unexpectedly');
    expect(isRetryable(err)).toBe(true);
  });

  test('an unresolvable host is retried (its DNS name may not exist yet)', async () => {
    const err = await errorFrom('postgresql://u:p@sharetab-db.invalid:5432/db', { timeoutMs: 8000 });
    // A slow resolver gives node-postgres's own timeout instead
    expect(['ENOTFOUND', 'EAI_AGAIN'].includes(err.code) || err.message === 'timeout expired').toBe(true);
    expect(isRetryable(err)).toBe(true);
  }, 15000);

  test.each([
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ECONNRESET',
    // The server shut down or restarted between sign-in and the query
    '57P01',
    '57P02',
    '08000',
    '08003',
    '08006',
    // too_many_connections: other sessions may end
    '53300',
  ])(
    '%s is retried',
    (code) => {
      expect(isRetryable(Object.assign(new Error(code), { code }))).toBe(true);
    },
  );

  test('localhost refused, whether Node reports one error or an AggregateError', async () => {
    const err = await errorFrom(`postgresql://u:p@localhost:${await closedPort()}/db`);
    expect(isRetryable(err)).toBe(true);
    expect(describeError(err)).toMatch(/ECONNREFUSED/);
  });

  test('a server still starting up (57P03) is retried', async () => {
    const port = await refusingServer('57P03', 'the database system is starting up');
    const err = await errorFrom(url(port));
    expect(err.code).toBe('57P03');
    expect(isRetryable(err)).toBe(true);
  });

  test.each([
    ['28P01', 'password authentication failed for user "sharetab"'],
    ['28000', 'no pg_hba.conf entry for host "172.19.0.3", user "sharetab", database "sharetab", no encryption'],
    ['3D000', 'database "sharetab" does not exist'],
  ])('%s fails at once', async (code, message) => {
    const err = await errorFrom(url(await refusingServer(code, message)));
    expect(err.code).toBe(code);
    expect(isRetryable(err)).toBe(false);
  });

  test('a server without TLS, asked for TLS, fails at once', async () => {
    // Answers the SSLRequest with 'N' (no TLS here)
    const port = await serve((socket) => socket.once('data', () => socket.write('N')));
    const err = await errorFrom(url(port, 'sslmode=no-verify'));
    expect(err.message).toMatch(/does not support SSL/);
    expect(isRetryable(err)).toBe(false);
  });

  test('a TLS certificate error fails at once', () => {
    const err = Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    expect(isRetryable(err)).toBe(false);
  });
});

describe('checkConnection', () => {
  test('a working server: resolves, and hangs up', async () => {
    const { port, seen } = await signedInServer((socket) => socket.write(queryOk));
    await checkConnection(url(port), { timeoutMs: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen.clientEnded).toBe(true);
  });

  test('doesn’t wait long on a server that ignores the hang-up', async () => {
    // Answers the query, then never closes its side
    const { port } = await signedInServer((socket) => {
      socket.write(queryOk);
      socket.removeAllListeners('end');
      socket.allowHalfOpen = true;
    });
    const started = Date.now();
    await checkConnection(url(port), { timeoutMs: 1000 });
    expect(Date.now() - started).toBeLessThan(2500);
  });
});

describe('describeError', () => {
  test('adds the code', () => {
    const err = Object.assign(new Error('password authentication failed'), { code: '28P01' });
    expect(describeError(err)).toBe('password authentication failed (28P01)');
  });

  test("uses an AggregateError's inner messages, since its own is empty", () => {
    const inner = [
      Object.assign(new Error('connect ECONNREFUSED ::1:5432'), { code: 'ECONNREFUSED' }),
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }),
    ];
    const err = Object.assign(new AggregateError(inner, ''), { code: 'ECONNREFUSED' });
    expect(describeError(err)).toBe(
      'connect ECONNREFUSED ::1:5432; connect ECONNREFUSED 127.0.0.1:5432 (ECONNREFUSED)',
    );
  });

  test('without a code', () => {
    expect(describeError(new Error('timeout expired'))).toBe('timeout expired');
  });
});

describe('hint', () => {
  const at = (host) => `postgresql://u:p@${host}:5432/db`;
  const error = (code, message = 'x') => Object.assign(new Error(message), { code });

  test('wrong password', () => {
    expect(hint(error('28P01'), at('db'))).toMatch(/user name and password/);
  });

  test('pg_hba.conf rejection names the server side, not the password', () => {
    const text = hint(error('28000', 'no pg_hba.conf entry for host "172.19.0.3"'), at('db'));
    expect(text).toMatch(/pg_hba\.conf/);
    expect(text).not.toMatch(/password/);
  });

  test('other 28000 (e.g. an unknown role)', () => {
    expect(hint(error('28000', 'role "nobody" does not exist'), at('db'))).toMatch(/user name/);
  });

  test('missing database', () => {
    expect(hint(error('3D000'), at('db'))).toMatch(/Create the database/);
  });

  test('untrusted certificate explains sslmode=require and both fixes', () => {
    const text = hint(error('DEPTH_ZERO_SELF_SIGNED_CERT'), at('db'));
    expect(text).toMatch(/sslmode=require/);
    expect(text).toMatch(/NODE_EXTRA_CA_CERTS/);
    expect(text).toMatch(/sslmode=no-verify/);
  });

  test('name mismatch with an IP address: certificate checks need a host name', () => {
    expect(hint(error('ERR_TLS_CERT_ALTNAME_INVALID'), at('192.0.2.8'))).toMatch(/IP address/);
    expect(hint(error('ERR_TLS_CERT_ALTNAME_INVALID'), at('[::1]'))).toMatch(/IP address/);
  });

  test('name mismatch with a host name gets the certificate hint', () => {
    expect(hint(error('ERR_TLS_CERT_ALTNAME_INVALID'), at('db.example.com'))).toMatch(/NODE_EXTRA_CA_CERTS/);
  });

  test('server without TLS: turn it on, or drop sslmode only on a trusted network', () => {
    const text = hint(new Error('The server does not support SSL connections'), at('db'));
    expect(text).toMatch(/sslmode/);
    expect(text).toMatch(/trust/);
    // Something in between can answer "no TLS" too: that comes before dropping it
    expect(text).toMatch(/in between/);
    expect(text.indexOf('in between')).toBeLessThan(text.indexOf('remove sslmode'));
  });

  test('an expired certificate is renewed, not skipped', () => {
    const text = hint(error('CERT_HAS_EXPIRED'), at('db'));
    expect(text).toMatch(/expired/);
    expect(text).not.toMatch(/no-verify/);
  });

  test('sslmode=no-verify is described as not checking the server', () => {
    expect(hint(error('DEPTH_ZERO_SELF_SIGNED_CERT'), at('db'))).toMatch(/trust/);
  });

  test('refused on localhost: that is the container itself', () => {
    const text = hint(error('ECONNREFUSED'), at('localhost'));
    expect(text).toMatch(/container itself/);
    expect(text).toMatch(/DATABASE_URL/);
    expect(hint(error('ECONNREFUSED'), at('127.0.0.1'))).toMatch(/container itself/);
    expect(hint(error('ECONNREFUSED'), at('[::1]'))).toMatch(/container itself/);
  });

  test('in bundled mode, an interrupted first start is moved aside, not emptied', () => {
    expect(hint({ code: '28P01', message: 'x' }, 'postgresql://u:p@localhost:5432/db', 'bundled')).toMatch(/move it aside/);
  });

  test('in bundled mode, credentials point at DB_USER/DB_PASSWORD/DB_NAME, not DATABASE_URL', () => {
    for (const code of ['28P01', '28000', '3D000']) {
      const text = hint(error(code, 'x'), at('localhost'), 'bundled');
      expect(text).toMatch(/DB_PASSWORD/);
      expect(text).toMatch(/first created/);
      expect(text).toMatch(/interrupted/);
      expect(text).not.toMatch(/DATABASE_URL/);
    }
  });

  test('refused elsewhere, and unknown errors, get no hint', () => {
    expect(hint(error('ECONNREFUSED'), at('db'))).toBe('');
    expect(hint(error('XX000'), at('db'))).toBe('');
  });
});

describe('describeTarget', () => {
  test('keeps host, port and database, drops credentials and parameters', () => {
    expect(describeTarget('postgresql://user:p%40ss@db.lan:6543/sharetab?sslmode=no-verify')).toBe(
      'db.lan:6543/sharetab',
    );
  });

  test('defaults the port', () => {
    expect(describeTarget('postgres://u:p@db/sharetab')).toBe('db:5432/sharetab');
  });

  test('never echoes an unparseable URL', () => {
    expect(describeTarget('not a url with secret')).toBe('(unparseable DATABASE_URL)');
  });

  test.each([
    ['no scheme: new URL takes "user:" for one and puts the password in the path', 'user:hunter2@127.0.0.1/db'],
    ['a "/" in the password, read as a port and a path', 'postgresql://sharetab:123/hunter2@db:5432/sharetab'],
    ['another scheme', 'mysql://u:hunter2@db/sharetab'],
    ['no host', 'postgresql:///sharetab'],
    ['a "/" and a "?" in the password', 'postgresql://sharetab:123/hunter2?rest@db:5432/sharetab'],
    ['digits then "?" in the password', 'postgresql://u:12?hunter2@h:5432/db'],
    ['a "#" in the password', 'postgresql://u:hunter2#x@h:5432/db'],
    ['a stray % in the password', 'postgresql://u:hunter%2@h:5432/db'],
    ['a stray % in the database', 'postgresql://u:hunter2@h:5432/db%zz'],
  ])('never echoes credentials or throws: %s', (_, value) => {
    expect(describeTarget(value)).toBe('(unparseable DATABASE_URL)');
    expect(urlProblem(value)).toMatch(/percent-encode/);
  });

  test('any @ after the host part is refused: an unencoded / ? or # in a password can hide behind one', () => {
    // "p@ss/x?y" would otherwise be read as host "ss", database "x"
    const leaky = 'postgresql://sharetab:p@ss/x?y@db:5432/sharetab';
    expect(urlProblem(leaky)).toMatch(/percent-encode/);
    expect(describeTarget(leaky)).toBe('(unparseable DATABASE_URL)');
    expect(urlProblem('postgresql://u:p@h:5432/db?application_name=a@b')).toMatch(/@ in a query value/);
  });

  test('surrounding spaces are refused: node-postgres would read another host', () => {
    expect(urlProblem(' postgresql://u:p@h:5432/db')).toMatch(/node-postgres/);
    expect(urlProblem('postgresql://u:p@h:5432/db ')).toMatch(/node-postgres/);
  });

  test.each([
    ['a raw space in a query value', 'postgresql://u:p%2Fx@h:5432/db?application_name=my app'],
    ['a stray % in a query value', 'postgresql://u:p%2Fx@h:5432/db?application_name=a%zz'],
  ])('%s is refused: node-postgres would re-encode the whole URL, password included', (_, value) => {
    // Without the check, pg's password is "p%2Fx" while Prisma's is "p/x"
    expect(new pg.Client({ connectionString: value }).password).toBe('p%2Fx');
    expect(urlProblem(value)).toMatch(/re-encode/);
  });

  test('a % in the database name is refused: node-postgres keeps it, Prisma decodes it', () => {
    expect(urlProblem('postgresql://u:p@h:5432/team%40home')).toMatch(/node-postgres/);
  });

  test('IPv6 hosts read the same in both', () => {
    expect(urlProblem('postgresql://u:p@[::1]:5432/db')).toBe('');
  });

  test.each(['host', 'hostaddr', 'port', 'user', 'password', 'dbname'])(
    'a %s= parameter is refused: the log would name a different server or database',
    (name) => {
      expect(urlProblem(`postgresql://u:p@h:5432/db?${name}=other`)).toMatch(new RegExp(`${name}=`));
    },
  );

  test('a Unix socket (empty host, ?host=) is refused as unsupported', () => {
    expect(describeTarget('postgresql://u:p@/sharetab?host=/run/postgresql')).toBe('(unparseable DATABASE_URL)');
    expect(urlProblem('postgresql://u:p@/sharetab?host=/run/postgresql')).toMatch(/Unix socket/);
  });
});

describe('urlProblem', () => {
  test('a postgresql:// or postgres:// URL with a host and a database is fine', () => {
    expect(urlProblem('postgresql://u:p%2Fq@db:5432/sharetab?sslmode=no-verify')).toBe('');
    expect(urlProblem('postgres://u:p@db/sharetab')).toBe('');
  });

  test('a password needing percent-encoding is named, without echoing it', () => {
    const text = urlProblem('postgresql://sharetab:ab/cd+ef=@postgres:5432/sharetab');
    expect(text).toMatch(/percent-encode/);
    expect(text).not.toMatch(/ab\/cd/);
  });

  test('a URL without a database name is refused (Prisma and the app would pick different ones)', () => {
    expect(urlProblem('postgresql://u:p@db:5432')).toMatch(/database name/);
    expect(urlProblem('postgresql://u:p@db:5432/')).toMatch(/database name/);
  });

  test("a file node-postgres can't read (sslrootcert) is named, not called a different host", () => {
    const text = urlProblem('postgresql://u:p@db/sharetab?sslmode=verify-full&sslrootcert=/nonexistent/ca.pem');
    expect(text).toMatch(/can't use DATABASE_URL/);
    expect(text).toMatch(/ENOENT/);
    expect(text).not.toMatch(/different host/);
  });

  test('a schema other than public is refused: the app always reads public', () => {
    expect(urlProblem('postgresql://u:p@db/sharetab?schema=other')).toMatch(/public schema/);
    expect(urlProblem('postgresql://u:p@db/sharetab?schema=public')).toBe('');
    // Prisma takes the last one, node-postgres the first
    expect(urlProblem('postgresql://u:p@db/sharetab?schema=public&schema=other')).toMatch(/public schema/);
  });
});

describe('bundledUrl', () => {
  // Prisma decodes the database name like WHATWG URL; node-postgres with
  // decodeURI, which leaves an escaped reserved character (%24, %2B, %40) as it is
  const prismaName = (value) => decodeURIComponent(new URL(value).pathname.slice(1));

  test.each(['sharetab', 'share$tab', 'a+b', 'a@b', 'a:b', 'x;y=z&w,v', '100%', 'a b', 'ñame', 'it\'s'])(
    'DB_NAME %s reads the same in node-postgres, Prisma and the startup checks',
    (name) => {
      const value = bundledUrl({ DB_USER: 'u', DB_PASSWORD: 'p/w#1@%x', DB_NAME: name });
      const client = new pg.Client({ connectionString: value });
      expect(client.database).toBe(name);
      expect(client.password).toBe('p/w#1@%x');
      expect(prismaName(value)).toBe(name);
      expect(urlProblem(value, 'bundled')).toBe('');
      expect(describeTarget(value, 'bundled')).toBe(`localhost:5432/${name}`);
    },
  );

  test.each(['a/b', 'a?b', 'a#b'])('DB_NAME %s is refused: the two drivers would read it differently', (name) => {
    expect(() => bundledUrl({ DB_NAME: name })).toThrow(/DB_NAME has a \/ \? or #.*Prisma/);
  });

  test('defaults each part to sharetab', () => {
    expect(bundledUrl({})).toBe('postgresql://sharetab:sharetab@localhost:5432/sharetab');
  });
});

describe('waitSeconds', () => {
  test.each([
    [undefined, 60],
    ['', 60],
    ['0', 60],
    ['-5', 60],
    ['abc', 60],
    ['1.5', 60],
    ['90', 90],
  ])('DB_WAIT_SECONDS=%s gives %i', (value, expected) => {
    expect(waitSeconds(value === undefined ? {} : { DB_WAIT_SECONDS: value })).toBe(expected);
  });
});

// ── waitForDatabase ─────────────────────────────────────────────────────────

function recorder() {
  const lines = { info: [], error: [] };
  return { lines, log: { info: (l) => lines.info.push(l), error: (l) => lines.error.push(l) } };
}

// A fake clock: sleep advances it instead of waiting.
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => void (t += ms) };
}

const refused = () => Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { code: 'ECONNREFUSED' });

describe('waitForDatabase', () => {
  const base = 'postgresql://u:p@db:5432/sharetab';

  test('ready on the first try', async () => {
    const { lines, log } = recorder();
    const ok = await waitForDatabase({ url: base, check: async () => {}, ...fakeClock(), log, seconds: 60 });
    expect(ok).toBe(true);
    expect(lines.info).toEqual(['Database is ready (db:5432/sharetab).']);
  });

  test('retries while the server comes up, logging each reason once', async () => {
    const { lines, log } = recorder();
    let calls = 0;
    const check = async () => {
      calls += 1;
      if (calls <= 3) throw refused();
      if (calls === 4) throw new Error('timeout expired');
    };
    const ok = await waitForDatabase({ url: base, check, ...fakeClock(), log, seconds: 60 });
    expect(ok).toBe(true);
    expect(calls).toBe(5);
    expect(lines.info).toEqual([
      'Waiting for the database at db:5432/sharetab: connect ECONNREFUSED 10.0.0.5:5432 (ECONNREFUSED)',
      'Waiting for the database at db:5432/sharetab: timeout expired',
      'Database is ready (db:5432/sharetab).',
    ]);
  });

  test('a reason that comes back after another is not logged again', async () => {
    const { lines, log } = recorder();
    const reasons = [refused(), new Error('timeout expired'), refused()];
    const check = async () => {
      const next = reasons.shift();
      if (next) throw next;
    };
    await waitForDatabase({ url: base, check, ...fakeClock(), log, seconds: 60 });
    expect(lines.info.filter((l) => l.startsWith('Waiting'))).toHaveLength(2);
  });

  test('an unusable URL fails at once, without trying to connect', async () => {
    const { lines, log } = recorder();
    let calls = 0;
    const check = async () => {
      calls += 1;
    };
    const ok = await waitForDatabase({
      url: 'postgresql://sharetab:ab/cd@db:5432/sharetab',
      check,
      ...fakeClock(),
      log,
      seconds: 60,
    });
    expect(ok).toBe(false);
    expect(calls).toBe(0);
    expect(lines.error.join('\n')).toMatch(/percent-encode/);
  });

  test('gives up after the deadline with the last reason', async () => {
    const { lines, log } = recorder();
    let calls = 0;
    const check = async () => {
      calls += 1;
      // A different reason first, so "last" is told apart from "first"
      throw calls === 1 ? new Error('timeout expired') : refused();
    };
    const ok = await waitForDatabase({ url: base, check, ...fakeClock(), log, seconds: 5 });
    expect(ok).toBe(false);
    expect(calls).toBeGreaterThanOrEqual(5);
    expect(calls).toBeLessThanOrEqual(7);
    expect(lines.error[0]).toBe(
      'ERROR: the database at db:5432/sharetab did not answer in 5s: connect ECONNREFUSED 10.0.0.5:5432 (ECONNREFUSED)',
    );
    expect(lines.error.join('\n')).toMatch(/DB_WAIT_SECONDS/);
  });

  test('a refused localhost says why on the first wait line, not only at give-up', async () => {
    const { lines, log } = recorder();
    let calls = 0;
    const check = async () => {
      calls += 1;
      if (calls < 3) throw refused();
    };
    await waitForDatabase({ url: 'postgresql://u:p@localhost/db', check, ...fakeClock(), log, seconds: 60 });
    expect(lines.info[1]).toMatch(/container itself/);
  });

  test('a refused localhost adds the container hint at give-up', async () => {
    const { lines, log } = recorder();
    const check = async () => {
      throw refused();
    };
    await waitForDatabase({ url: 'postgresql://u:p@localhost/db', check, ...fakeClock(), log, seconds: 2 });
    expect(lines.error.join('\n')).toMatch(/container itself/);
  });

  test('fails at once, with the hint, on an error waiting won’t fix', async () => {
    const { lines, log } = recorder();
    let calls = 0;
    const check = async () => {
      calls += 1;
      throw Object.assign(new Error('password authentication failed for user "u"'), { code: '28P01' });
    };
    const ok = await waitForDatabase({ url: base, check, ...fakeClock(), log, seconds: 60 });
    expect(ok).toBe(false);
    expect(calls).toBe(1);
    expect(lines.error).toEqual([
      'ERROR: cannot use the database at db:5432/sharetab: password authentication failed for user "u" (28P01)',
      expect.stringMatching(/user name and password/),
    ]);
  });

  test('never logs the password', async () => {
    const { lines, log } = recorder();
    const check = async () => {
      throw refused();
    };
    await waitForDatabase({ url: 'postgresql://u:hunter2@db/x', check, ...fakeClock(), log, seconds: 2 });
    expect(JSON.stringify(lines)).not.toMatch(/hunter2/);
  });
});

// ── runSqlFile ──────────────────────────────────────────────────────────────

// A stand-in for pg.Client that records each query. query() runs
// behavior(sql), emitting the notices it returns or throwing what it throws.
function fakeClient(behavior = () => []) {
  const listeners = [];
  const client = {
    queries: [],
    ended: false,
    on: (event, fn) => event === 'notice' && listeners.push(fn),
    query: async (sql) => {
      client.queries.push(sql);
      const result = behavior(sql);
      for (const notice of result?.notices ?? []) listeners.forEach((fn) => fn(notice));
      return { rows: result?.rows ?? [] };
    },
    end: async () => {
      client.ended = true;
    },
  };
  return client;
}

const files = {
  '/app/prisma/migrations/a.sql': 'DO $$ BEGIN NULL; END $$;\nSELECT 2;',
  '/app/prisma/after-push/b.sql': 'SELECT 1;\nSELEC oops;\n',
};
const readFile = (path) => {
  if (!(path in files)) throw Object.assign(new Error(`ENOENT: no such file, open '${path}'`), { code: 'ENOENT' });
  return files[path];
};

describe('runSqlFile', () => {
  test('sends the whole file as one query and forwards notices the way psql printed them', async () => {
    const { lines, log } = recorder();
    const client = fakeClient(() => ({ notices: [{ severity: 'WARNING', message: 'duplicates: a@example.com' }] }));
    const ok = await runSqlFile({ client, file: '/app/prisma/migrations/a.sql', readFile, log });
    expect(ok).toBe(true);
    expect(client.queries).toEqual(['DO $$ BEGIN NULL; END $$;\nSELECT 2;']);
    expect(lines.info).toEqual(['Running migrations/a.sql...', 'WARNING:  duplicates: a@example.com']);
  });

  test('reports a failure with its line, SQLSTATE and the server’s details', async () => {
    const { lines, log } = recorder();
    const client = fakeClient(() => {
      throw Object.assign(new Error('syntax error at or near "SELEC"'), {
        code: '42601',
        position: '11',
        detail: 'some detail',
        hint: 'some hint',
        where: 'PL/pgSQL function inline_code_block line 3 at SQL statement',
      });
    });
    const ok = await runSqlFile({ client, file: '/app/prisma/after-push/b.sql', readFile, log });
    expect(ok).toBe(false);
    expect(lines.error).toEqual([
      'ERROR: after-push/b.sql, line 2: syntax error at or near "SELEC" (42601)',
      'DETAIL:  some detail',
      'HINT:  some hint',
      'CONTEXT:  PL/pgSQL function inline_code_block line 3 at SQL statement',
    ]);
  });

  test('an error at the first character of a later line names that line', async () => {
    const { lines, log } = recorder();
    // "SELEC oops;" starts at character 11 of 'SELECT 1;\nSELEC oops;\n'
    const client = fakeClient(() => {
      throw Object.assign(new Error('syntax error'), { code: '42601', position: '11' });
    });
    await runSqlFile({ client, file: '/app/prisma/after-push/b.sql', readFile, log });
    expect(lines.error[0]).toMatch(/, line 2: /);
  });

  test('positions count characters, as PostgreSQL does, not UTF-16 code units', async () => {
    const { lines, log } = recorder();
    files['/app/prisma/after-push/emoji.sql'] = "SELECT '😀';\nSELEC oops;\n";
    // "SELEC" is character 13: S,E,L,E,C,T,space,',😀,',;,newline then S
    const client = fakeClient(() => {
      throw Object.assign(new Error('syntax error'), { code: '42601', position: '13' });
    });
    await runSqlFile({ client, file: '/app/prisma/after-push/emoji.sql', readFile, log });
    expect(lines.error[0]).toMatch(/, line 2: /);
  });

  test('an error without a position (inside a DO block) leaves the line out', async () => {
    const { lines, log } = recorder();
    const client = fakeClient(() => {
      throw Object.assign(new Error('boom'), { code: 'P0001' });
    });
    await runSqlFile({ client, file: '/app/prisma/migrations/a.sql', readFile, log });
    expect(lines.error).toEqual(['ERROR: migrations/a.sql: boom (P0001)']);
  });

  test('a file it can’t read is reported, and nothing is sent', async () => {
    const { lines, log } = recorder();
    const client = fakeClient();
    const ok = await runSqlFile({ client, file: '/app/prisma/migrations/missing.sql', readFile, log });
    expect(ok).toBe(false);
    expect(client.queries).toEqual([]);
    expect(lines.error[0]).toMatch(/^ERROR: migrations\/missing\.sql: ENOENT/);
  });
});

// ── Shared databases ────────────────────────────────────────────────────────

const realSchema = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
const models = ['Account', 'Session', 'VerificationToken', 'User', 'Group', 'Expense', 'ExpenseShare', 'Settlement', 'GuestSplit'];

describe('parseModels', () => {
  test("lists each model's name, skipping enums and comments", () => {
    const schema = `
      // model NotAModel {
      model User {
        id String @id // a } in a comment
      }
      enum Role {
        OWNER
      }
      model GuestSplit {
        id String @id
      }
    `;
    expect(parseModels(schema)).toEqual(['User', 'GuestSplit']);
  });

  test('every model ShareTab has shipped is still a model, or listed in RETIRED_TABLES', () => {
    // Removing or renaming a model leaves its table in every existing
    // database, and check-schema would then refuse them all: list the old
    // name in RETIRED_TABLES (docker/db-lib.mjs) when you do.
    const shipped = [
      'Account', 'Session', 'VerificationToken', 'PasswordResetToken', 'User', 'Group', 'GroupMember',
      'GroupInvite', 'Expense', 'ExpenseShare', 'Receipt', 'ReceiptItem', 'ReceiptItemAssignment',
      'Settlement', 'ActivityLog', 'AdminAuditLog', 'SystemSetting', 'SystemInvite', 'GuestSplit',
    ];
    const current = parseModels(realSchema);
    for (const table of shipped) {
      expect(current.includes(table) || RETIRED_TABLES.includes(table), table).toBe(true);
    }
    // A new model goes in the list above too, so it keeps every name shipped
    for (const table of current) {
      expect(shipped, `add ${table} to the shipped list`).toContain(table);
    }
  });

  test('no model is mapped to another table name (parseModels takes model names as table names)', () => {
    expect(realSchema).not.toMatch(/@@map\(/);
  });

  test("reads every model of ShareTab's own schema", () => {
    const found = parseModels(realSchema);
    expect(found.length).toBe((realSchema.match(/^model /gm) ?? []).length);
    for (const table of ['User', 'Group', 'Expense', 'ExpenseShare', 'Settlement', 'GuestSplit']) {
      expect(found).toContain(table);
    }
  });
});

describe('schemaProblem', () => {
  test('an empty database is fine (a new install)', () => {
    expect(schemaProblem([], models)).toBe('');
  });

  test("ShareTab's tables are fine", () => {
    expect(schemaProblem(['Account', 'Expense', 'ExpenseShare', 'Group', 'Settlement', 'User'], models)).toBe('');
  });

  test('some of ShareTab’s own tables (a first start that stopped part way) are fine', () => {
    expect(schemaProblem(['Account', 'Group', 'User'], models)).toBe('');
  });

  test('only Auth.js’s standard tables is another Auth.js app’s database: refused', () => {
    const text = schemaProblem(['Account', 'Session', 'User', 'VerificationToken'], models);
    expect(text).toMatch(/isn't ShareTab's/);
    // ...unless a first start stopped after creating just those
    expect(text).toMatch(/first start stopped/);
  });

  test('tables ShareTab has dropped, and Prisma’s migrations table, are accepted', () => {
    expect(schemaProblem(['Group', 'User', '_prisma_migrations', ...RETIRED_TABLES], models)).toBe('');
  });

  test('implicit many-to-many tables between two models are accepted, others not', () => {
    expect(schemaProblem(['Group', 'User', '_GroupToUser'], models)).toBe('');
    expect(schemaProblem(['Group', 'User', '_PostToTag'], models)).toMatch(/_PostToTag/);
  });

  test('ShareTab’s tables plus another app’s are refused: prisma db push would drop its empty ones', () => {
    const text = schemaProblem(['Expense', 'Group', 'Settlement', 'User', 'notes'], models);
    expect(text).toMatch(/\(notes\)/);
    expect(text).toMatch(/database of its own/);
  });

  test('another Auth.js app’s database, which also has "User", is refused', () => {
    expect(schemaProblem(['Account', 'Session', 'User', 'VerificationToken', 'posts'], models)).toMatch(/posts/);
  });

  test("tables, none of them ShareTab's, are refused", () => {
    const text = schemaProblem(['notes', 'wp_posts'], models);
    expect(text).toMatch(/notes, wp_posts/);
    expect(text).toMatch(/drop/);
    // An older build on a newer ShareTab's database: don't strand the data
    expect(text).toMatch(/newer ShareTab/);
  });

  test('a long list is cut short', () => {
    const tables = Array.from({ length: 12 }, (_, i) => `t${i}`);
    expect(schemaProblem(tables, models)).toMatch(/t0, t1, t2, t3, t4 and 7 more/);
  });
});

describe('checkSchema', () => {
  test('reads all of public’s tables (an extension’s too) and refuses foreign ones', async () => {
    const { lines, log } = recorder();
    const client = fakeClient(() => ({ rows: [{ table_name: 'notes' }] }));
    expect(await checkSchema({ client, models, log })).toBe(false);
    expect(client.queries[0]).toMatch(/nspname = 'public'/);
    expect(client.queries[0]).not.toMatch(/pg_depend/);
    expect(lines.error[0]).toMatch(/^ERROR: /);
  });

  test('a failed table query is reported, not thrown', async () => {
    const { lines, log } = recorder();
    const client = fakeClient(() => {
      throw Object.assign(new Error('permission denied for table pg_class'), { code: '42501' });
    });
    expect(await checkSchema({ client, models, log })).toBe(false);
    expect(lines.error[0]).toMatch(/^ERROR: cannot list the database's tables: permission denied/);
  });

  test('passes a database that holds ShareTab', async () => {
    const { log } = recorder();
    const client = fakeClient(() => ({ rows: models.map((table_name) => ({ table_name })) }));
    expect(await checkSchema({ client, models, log })).toBe(true);
  });

  test('refuseEmpty: an empty database is refused, naming ALLOW_EMPTY_EXTERNAL_DB', async () => {
    for (const tables of [[], ['_prisma_migrations']]) {
      const { lines, log } = recorder();
      const client = fakeClient(() => ({ rows: tables.map((table_name) => ({ table_name })) }));
      expect(await checkSchema({ client, models, log, refuseEmpty: true })).toBe(false);
      expect(lines.error[0]).toMatch(/^ERROR: The database is empty/);
      expect(lines.error.join(' ')).toMatch(/ALLOW_EMPTY_EXTERNAL_DB=true/);
    }
  });

  test('refuseEmpty: a database with ShareTab in it passes', async () => {
    const { log } = recorder();
    const client = fakeClient(() => ({ rows: [{ table_name: 'User' }, { table_name: 'Group' }] }));
    expect(await checkSchema({ client, models, log, refuseEmpty: true })).toBe(true);
  });
});

describe('withClient', () => {
  test('a connection that fails is logged with its hint, and the work never runs', async () => {
    const { lines, log } = recorder();
    let ran = false;
    const ok = await withClient(`postgresql://u:p@127.0.0.1:${await closedPort()}/db`, log, async () => {
      ran = true;
      return true;
    });
    expect(ok).toBe(false);
    expect(ran).toBe(false);
    expect(lines.error[0]).toMatch(/^ERROR: cannot connect to the database at 127\.0\.0\.1:\d+\/db: .*ECONNREFUSED/);
    expect(lines.error[1]).toMatch(/container itself/);
  });

  test('refuses an unusable URL before connecting', async () => {
    const { lines, log } = recorder();
    let ran = false;
    const ok = await withClient('postgresql://u:a/b@127.0.0.1:1/db', log, async () => {
      ran = true;
    });
    expect(ok).toBe(false);
    expect(ran).toBe(false);
    expect(lines.error[0]).toMatch(/^ERROR: DATABASE_URL isn't/);
  });

  test('passes a false answer from the work on, and hangs up', async () => {
    const { port, seen } = await signedInServer((socket) => socket.write(queryOk));
    const { log } = recorder();
    expect(await withClient(url(port), log, async () => false)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen.clientEnded).toBe(true);
  });

  test('a shutdown right after sign-in is reported as itself, not "not queryable"', async () => {
    const port = await serve((socket) =>
      socket.once('data', () =>
        socket.end(Buffer.concat([loginOk, errorResponse('57P01', 'terminating connection due to administrator command')])),
      ),
    );
    const { lines, log } = recorder();
    expect(await withClient(url(port), log, async () => true)).toBe(false);
    expect(lines.error[0]).toMatch(/terminating connection due to administrator command \(57P01\)/);
  });

  test('pins search_path to public before the work, whatever the URL or role sets', async () => {
    // Prisma's queries name "public"; the SQL files' unqualified names must too
    const { port, seen } = await signedInServer((socket) => socket.write(queryOk));
    const { log } = recorder();
    await withClient(url(port, 'sslmode=disable&options=-csearch_path%3Dprivate'), log, async (client) => {
      await client.query('SELECT 1');
      return true;
    });
    expect(seen.queries).toEqual(['SET search_path TO public', 'SELECT 1']);
  });

  test('hangs up when the work throws, and passes the error on', async () => {
    const { port, seen } = await signedInServer((socket) => socket.write(queryOk));
    const { log } = recorder();
    await expect(
      withClient(url(port), log, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen.clientEnded).toBe(true);
  });

  test('runs the work on a connected client, returns its answer, and hangs up', async () => {
    const { port, seen } = await signedInServer((socket) => socket.write(queryOk));
    const { log } = recorder();
    const ok = await withClient(url(port), log, async (client) => {
      await client.query('SELECT 1');
      return true;
    });
    expect(ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen.clientEnded).toBe(true);
  });
});
