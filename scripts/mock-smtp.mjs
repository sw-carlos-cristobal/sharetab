/**
 * Minimal SMTP server that accepts all mail and discards it.
 * Used in CI for magic link auth tests.
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

const server = createServer((socket) => {
  socket.write('220 mock-smtp ready\r\n');

  let inData = false;
  let buffer = '';
  let recipients = [];
  let message = [];

  socket.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\r\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (inData) {
        if (line === '.') {
          inData = false;
          if (outbox) {
            const name = `${Date.now()}-${saved++}.eml`;
            writeFileSync(join(outbox, name), [...recipients.map((r) => `X-Rcpt-To: ${r}`), ...message].join('\r\n'));
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
});

server.listen(port, () => {
  console.log(`Mock SMTP server listening on port ${port}`);
});
