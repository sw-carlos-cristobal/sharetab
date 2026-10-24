import { afterEach, describe, expect, test } from 'vitest';
import { createServer } from 'node:net';
import {
  checkConnection,
  describeError,
  describeTarget,
  hint,
  isRetryable,
  runSqlFiles,
  waitForDatabase,
  waitSeconds,
} from './db.mjs';

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

async function errorFrom(url, options = { timeoutMs: 300 }) {
  try {
    await checkConnection(url, options);
  } catch (err) {
    return err;
  }
  throw new Error('expected the connection to fail');
}

const url = (port, query = '') => `postgresql://sharetab:secret@127.0.0.1:${port}/sharetab${query}`;

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
    const err = await errorFrom(url(port));
    expect(isRetryable(err)).toBe(true);
  });

  test('an unresolvable host is retried (its DNS name may not exist yet)', async () => {
    const err = await errorFrom('postgresql://u:p@sharetab-db.invalid:5432/db', { timeoutMs: 5000 });
    expect(['ENOTFOUND', 'EAI_AGAIN']).toContain(err.code);
    expect(isRetryable(err)).toBe(true);
  });

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
    const err = await errorFrom(url(port, '?sslmode=no-verify'));
    expect(err.message).toMatch(/does not support SSL/);
    expect(isRetryable(err)).toBe(false);
  });

  test('a TLS certificate error fails at once', () => {
    const err = Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    expect(isRetryable(err)).toBe(false);
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
    expect(hint(error('ERR_TLS_CERT_ALTNAME_INVALID'), at('192.168.1.8'))).toMatch(/IP address/);
    expect(hint(error('ERR_TLS_CERT_ALTNAME_INVALID'), at('[::1]'))).toMatch(/IP address/);
  });

  test('name mismatch with a host name gets the certificate hint', () => {
    expect(hint(error('ERR_TLS_CERT_ALTNAME_INVALID'), at('db.example.com'))).toMatch(/NODE_EXTRA_CA_CERTS/);
  });

  test('server without TLS', () => {
    expect(hint(new Error('The server does not support SSL connections'), at('db'))).toMatch(/sslmode/);
  });

  test('refused on localhost: that is the container itself', () => {
    const text = hint(error('ECONNREFUSED'), at('localhost'));
    expect(text).toMatch(/container itself/);
    expect(text).toMatch(/DATABASE_URL/);
    expect(hint(error('ECONNREFUSED'), at('127.0.0.1'))).toMatch(/container itself/);
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

  test('gives up after the deadline with the last reason', async () => {
    const { lines, log } = recorder();
    let calls = 0;
    const check = async () => {
      calls += 1;
      throw refused();
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

// ── runSqlFiles ─────────────────────────────────────────────────────────────

// A stand-in for pg.Client: query() runs `behavior(sql)`, emitting notices it
// returns or throwing what it throws.
function fakeClient(behavior) {
  const listeners = [];
  const client = {
    ended: false,
    on: (event, fn) => event === 'notice' && listeners.push(fn),
    query: async (sql) => {
      for (const notice of behavior(sql) ?? []) listeners.forEach((fn) => fn(notice));
    },
    end: async () => {
      client.ended = true;
    },
  };
  return client;
}

const files = { '/sql/a.sql': 'SELECT 1;', '/sql/b.sql': 'SELECT 1;\nSELEC oops;\n', '/sql/c.sql': 'SELECT 3;' };
const readFile = (path) => files[path];

describe('runSqlFiles', () => {
  test('runs each file and forwards notices the way psql printed them', async () => {
    const { lines, log } = recorder();
    const client = fakeClient((sql) =>
      sql === 'SELECT 3;' ? [{ severity: 'WARNING', message: 'duplicates: a@example.com' }] : [],
    );
    const ok = await runSqlFiles({ client, label: 'migration', files: ['/sql/a.sql', '/sql/c.sql'], readFile, log });
    expect(ok).toBe(true);
    expect(lines.info).toEqual([
      'Running migration: a.sql...',
      'Running migration: c.sql...',
      'WARNING:  duplicates: a@example.com',
    ]);
    expect(client.ended).toBe(true);
  });

  test('stops at the first failing file with its line, SQLSTATE and the server’s details', async () => {
    const { lines, log } = recorder();
    const client = fakeClient((sql) => {
      if (sql.includes('oops')) {
        throw Object.assign(new Error('syntax error at or near "SELEC"'), {
          code: '42601',
          position: '11',
          detail: 'some detail',
          hint: 'some hint',
          where: 'PL/pgSQL function inline_code_block line 3 at SQL statement',
        });
      }
    });
    const ok = await runSqlFiles({
      client,
      label: 'post-schema SQL',
      files: ['/sql/a.sql', '/sql/b.sql', '/sql/c.sql'],
      readFile,
      log,
    });
    expect(ok).toBe(false);
    expect(lines.info).toEqual(['Running post-schema SQL: a.sql...', 'Running post-schema SQL: b.sql...']);
    expect(lines.error).toEqual([
      'ERROR: b.sql, line 2: syntax error at or near "SELEC" (42601)',
      'DETAIL:  some detail',
      'HINT:  some hint',
      'CONTEXT:  PL/pgSQL function inline_code_block line 3 at SQL statement',
    ]);
    expect(client.ended).toBe(true);
  });

  test('an error without a position (inside a DO block) leaves the line out', async () => {
    const { lines, log } = recorder();
    const client = fakeClient(() => {
      throw Object.assign(new Error('boom'), { code: 'P0001' });
    });
    await runSqlFiles({ client, label: 'migration', files: ['/sql/a.sql'], readFile, log });
    expect(lines.error).toEqual(['ERROR: a.sql: boom (P0001)']);
  });
});
