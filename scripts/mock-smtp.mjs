/**
 * Minimal SMTP server that accepts all mail and delivers none of it.
 * Used in CI for the magic link and password reset tests.
 *
 * With MOCK_SMTP_OUTBOX set to a directory, each message is also written there as
 * <time>-<n>.eml (its recipients first, then the raw message), so e2e tests can follow the
 * links in it (e2e/password-reset.spec.ts reads password reset emails).
 *
 * Usage: [MOCK_SMTP_OUTBOX=dir] node scripts/mock-smtp.mjs [port]
 */
import { createServer } from 'net';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const port = parseInt(process.argv[2] || '2525');
const outbox = process.env.MOCK_SMTP_OUTBOX;
if (outbox) mkdirSync(outbox, { recursive: true });
let saved = 0;

function handleConnection(socket) {
  socket.write('220 mock-smtp ready\r\n');

  let inData = false;
  let buffer = '';
  let recipients = [];
  let message = [];

  // Decodes across chunks, so a character split between two isn't mangled
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\r\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (inData) {
        if (line === '.') {
          inData = false;
          if (outbox) {
            // Padded, so the names sort in the order the messages arrived
            const name = `${Date.now()}-${String(saved++).padStart(6, '0')}.eml`;
            try {
              writeFileSync(join(outbox, name), [...recipients.map((r) => `X-Rcpt-To: ${r}`), ...message].join('\r\n'));
            } catch (error) {
              // Keep serving: the magic link tests only need the mail accepted
              console.error(`mock-smtp: could not save ${name}: ${error.message}`);
            }
          }
          recipients = [];
          message = [];
          socket.write('250 OK message accepted\r\n');
        } else {
          // SMTP dot-stuffing: a leading dot was doubled by the sender
          message.push(line.startsWith('..') ? line.slice(1) : line);
        }
        continue;
      }

      const cmd = line.split(' ')[0].toUpperCase();
      switch (cmd) {
        case 'EHLO':
        case 'HELO':
          socket.write(`250-mock-smtp\r\n250 OK\r\n`);
          break;
        case 'RCPT':
          recipients.push(line.replace(/^RCPT TO:\s*/i, '').replace(/[<>]/g, ''));
          socket.write('250 OK\r\n');
          break;
        case 'MAIL':
        case 'RSET':
          // Starts a new message
          recipients = [];
          message = [];
          socket.write('250 OK\r\n');
          break;
        case 'NOOP':
          socket.write('250 OK\r\n');
          break;
        case 'DATA':
          inData = true;
          socket.write('354 Send data\r\n');
          break;
        case 'QUIT':
          socket.write('221 Bye\r\n');
          socket.end();
          break;
        default:
          socket.write('250 OK\r\n');
      }
    }
  });

  socket.on('error', () => {});
}

// Loopback only, since anyone who can connect can write to the outbox. Both address families,
// since "localhost" may resolve to either; a host without IPv6 has only the first
for (const host of ['127.0.0.1', '::1']) {
  const server = createServer(handleConnection);
  server.on('error', (error) => {
    if (host === '127.0.0.1') throw error;
    console.warn(`mock-smtp: not listening on ${host}: ${error.message}`);
  });
  server.listen(port, host, () => {
    console.log(`Mock SMTP server listening on ${host} port ${port}`);
  });
}
