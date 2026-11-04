// docker/db.mjs as the entrypoint runs it: a separate process, judged by its
// exit code. A step that silently exits 0 would skip the wait or the SQL.
import { afterEach, describe, expect, test } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const db = fileURLToPath(new URL('./db.mjs', import.meta.url));

function run(args, env, script = db) {
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { env: { PATH: process.env.PATH, ...env } }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, stdout, stderr }),
    );
  });
}

// AuthenticationOk + ReadyForQuery, then CommandComplete + ReadyForQuery
const loginOk = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0, 0x5a, 0, 0, 0, 5, 0x49]);
const queryOk = Buffer.concat([
  Buffer.from([0x43, 0, 0, 0, 13]),
  Buffer.from('SELECT 1\0'),
  Buffer.from([0x5a, 0, 0, 0, 5, 0x49]),
]);

const cleanups = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

async function workingServer() {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('data', () => {
      socket.write(loginOk);
      socket.once('data', () => socket.write(queryOk));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return server.address().port;
}

// Postgres backend messages, for a server that answers real queries
function message(type, body) {
  const length = Buffer.alloc(4);
  length.writeInt32BE(body.length + 4);
  return Buffer.concat([Buffer.from(type), length, body]);
}
const cstring = (text) => Buffer.from(`${text}\0`);
const ready = message('Z', Buffer.from('I'));
const complete = (tag) => message('C', cstring(tag));
const fields = (pairs) => Buffer.concat([...pairs.map(([key, value]) => cstring(key + value)), Buffer.from([0])]);
const notice = (text) => message('N', fields([['S', 'NOTICE'], ['V', 'NOTICE'], ['C', '00000'], ['M', text]]));
const sqlError = (code, text) => message('E', fields([['S', 'ERROR'], ['V', 'ERROR'], ['C', code], ['M', text]]));

// A one-column text result: RowDescription, a DataRow per value, CommandComplete
function rows(column, values) {
  const count = Buffer.alloc(2);
  count.writeInt16BE(1);
  const meta = Buffer.alloc(18);
  meta.writeInt32BE(25, 6); // type: text
  meta.writeInt16BE(-1, 10);
  meta.writeInt32BE(-1, 12);
  const dataRows = values.map((value) => {
    const head = Buffer.alloc(6);
    head.writeInt16BE(1, 0);
    head.writeInt32BE(Buffer.byteLength(value), 2);
    return message('D', Buffer.concat([head, Buffer.from(value)]));
  });
  return Buffer.concat([message('T', Buffer.concat([count, cstring(column), meta])), ...dataRows, complete(`SELECT ${values.length}`)]);
}

// A server that signs the client in and answers each simple query with
// respond(text) (withClient's SET search_path is answered for it); the
// queries' texts land in `queries`.
async function queryServer(respond) {
  const queries = [];
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('data', () => {
      socket.write(loginOk);
      socket.on('data', (data) => {
        if (data[0] !== 0x51) return;
        const text = data.subarray(5, data.length - 1).toString();
        queries.push(text);
        socket.write(Buffer.concat([text.startsWith('SET search_path') ? complete('SET') : respond(text), ready]));
      });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return { port: server.address().port, queries };
}

const schemaFile = () => {
  const file = join(tempDir(), 'schema.prisma');
  writeFileSync(file, 'model User {\n  id String @id\n}\nmodel Group {\n  id String @id\n}\n');
  return file;
};

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'db-cli-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('db.mjs as a command', () => {
  test('wait: exit 0 and the ready line on a working server', async () => {
    const port = await workingServer();
    const result = await run(['wait'], { DATABASE_URL: `postgresql://u:p@127.0.0.1:${port}/sharetab` });
    expect(result).toMatchObject({ code: 0, stdout: `Database is ready (127.0.0.1:${port}/sharetab).\n` });
  });

  test('wait: exit 1 after DB_WAIT_SECONDS on a closed port', async () => {
    const result = await run(['wait'], { DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/sharetab', DB_WAIT_SECONDS: '1' });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/did not answer in 1s/);
  }, 15000);

  test('run through a symlinked directory still runs (and fails on a missing file)', async () => {
    // As through a bind mount: a run-as-command check db.mjs once had compared
    // the symlinked path with the real one, and every command exited 0
    // without doing anything
    const link = join(tempDir(), 'linked');
    symlinkSync(dirname(db), link);
    const result = await run(['run', '/nonexistent/x.sql'], { DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/db' }, join(link, 'db.mjs'));
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^ERROR: /m);
  });

  test('an invalid DB_WAIT_SECONDS is reported, then the default is used', async () => {
    const port = await workingServer();
    const result = await run(['wait'], { DATABASE_URL: `postgresql://u:p@127.0.0.1:${port}/db`, DB_WAIT_SECONDS: '30s' });
    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/DB_WAIT_SECONDS=30s isn't a whole number of seconds; waiting 60/);
  });

  test('check-schema with an unreadable schema file fails cleanly', async () => {
    const result = await run(['check-schema', '/nonexistent/schema.prisma'], { DATABASE_URL: 'postgresql://u:p@h/db' });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^ERROR: cannot read \/nonexistent\/schema\.prisma/);
    expect(result.stderr).not.toMatch(/\n\s+at /);
  });

  test('bundled-url percent-encodes DB_USER and DB_PASSWORD, and keeps $ + @ in DB_NAME', async () => {
    const result = await run(['bundled-url'], { DB_USER: 'share tab', DB_PASSWORD: 'p/w#1@%x', DB_NAME: 'share$tab' });
    expect(result).toMatchObject({ code: 0, stdout: 'postgresql://share%20tab:p%2Fw%231%40%25x@localhost:5432/share$tab\n' });
  });

  test('bundled-url refuses a DB_NAME no URL can carry: exit 1, naming DB_NAME', async () => {
    const result = await run(['bundled-url'], { DB_NAME: 'a/b' });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^ERROR: DB_NAME has a \/ \? or #/);
  });

  test('target in bundled mode reads a DB_NAME with @ in it', async () => {
    const result = await run(['target'], { DATABASE_URL: 'postgresql://u:p@localhost:5432/a@b', DB_MODE: 'bundled' });
    expect(result).toMatchObject({ code: 0, stdout: 'localhost:5432/a@b\n' });
  });

  test('run: sends the file, prints its notices, exit 0', async () => {
    const { port, queries } = await queryServer(() => Buffer.concat([notice('column already exists, skipping'), complete('ALTER TABLE')]));
    const file = join(tempDir(), 'ok.sql');
    writeFileSync(file, 'ALTER TABLE "User" ADD COLUMN IF NOT EXISTS x int;\n');
    const result = await run(['run', file], { DATABASE_URL: `postgresql://u:p@127.0.0.1:${port}/db?sslmode=disable` });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Running .*\/ok\.sql\.\.\.\nNOTICE: {2}column already exists, skipping\n/);
    expect(queries).toEqual(['SET search_path TO public', 'ALTER TABLE "User" ADD COLUMN IF NOT EXISTS x int;\n']);
  });

  test('run: an SQL error is printed with its code, exit 1', async () => {
    const { port } = await queryServer(() => sqlError('42601', 'syntax error at or near "ALTR"'));
    const file = join(tempDir(), 'bad.sql');
    writeFileSync(file, 'ALTR TABLE x;\n');
    const result = await run(['run', file], { DATABASE_URL: `postgresql://u:p@127.0.0.1:${port}/db?sslmode=disable` });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^ERROR: .*bad\.sql: syntax error at or near "ALTR" \(42601\)/m);
  });

  test('check-schema: a database of ShareTab tables passes, exit 0', async () => {
    const { port, queries } = await queryServer(() => rows('table_name', ['Group', 'User']));
    const result = await run(['check-schema', schemaFile()], { DATABASE_URL: `postgresql://u:p@127.0.0.1:${port}/db?sslmode=disable` });
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(queries[1]).toMatch(/nspname = 'public'/);
  });

  test("check-schema: another app's table is refused, exit 1", async () => {
    const { port } = await queryServer(() => rows('table_name', ['User', 'notes']));
    const result = await run(['check-schema', schemaFile()], { DATABASE_URL: `postgresql://u:p@127.0.0.1:${port}/db?sslmode=disable` });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^ERROR: The database holds tables ShareTab doesn't have \(notes\)/);
  });

  test('check-schema --refuse-empty: an empty database is refused, exit 1; without it, it passes', async () => {
    const { port } = await queryServer(() => rows('table_name', []));
    const env = { DATABASE_URL: `postgresql://u:p@127.0.0.1:${port}/db?sslmode=disable` };
    const refused = await run(['check-schema', '--refuse-empty', schemaFile()], env);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/ALLOW_EMPTY_EXTERNAL_DB=true/);
    expect((await run(['check-schema', schemaFile()], env)).code).toBe(0);
  });

  test('target prints host:port/database only', async () => {
    const result = await run(['target'], { DATABASE_URL: 'postgresql://u:secret@db.lan:6543/sharetab?sslmode=no-verify' });
    expect(result).toMatchObject({ code: 0, stdout: 'db.lan:6543/sharetab\n' });
  });

  test('no DATABASE_URL: exit 1; unknown command: exit 2', async () => {
    expect((await run(['wait'], {})).code).toBe(1);
    expect((await run(['bogus'], { DATABASE_URL: 'postgresql://u:p@h/d' })).code).toBe(2);
  });

  test('a schema file is read for check-schema', async () => {
    // The command reaches the database step (and fails to connect) only after
    // reading the schema
    const schema = join(tempDir(), 'schema.prisma');
    writeFileSync(schema, 'model User {\n  id String @id\n}\n');
    const result = await run(['check-schema', schema], { DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/db' });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/cannot connect to the database/);
  });
});
