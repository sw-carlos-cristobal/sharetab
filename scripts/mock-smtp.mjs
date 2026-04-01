/**
 * Minimal SMTP server that accepts all mail and discards it.
 * Used in CI for magic link auth tests.
 *
 * Usage: node scripts/mock-smtp.mjs [port]
 */
import { createServer } from "net";

const port = parseInt(process.argv[2] || "2525");

const server = createServer((socket) => {
  socket.write("220 mock-smtp ready\r\n");

  let inData = false;
  let buffer = "";

  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\r\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (inData) {
        if (line === ".") {
          inData = false;
          socket.write("250 OK message accepted\r\n");
        }
        // Discard message body
        continue;
      }

      const cmd = line.split(" ")[0].toUpperCase();
      switch (cmd) {
        case "EHLO":
        case "HELO":
          socket.write(`250-mock-smtp\r\n250 OK\r\n`);
          break;
        case "MAIL":
        case "RCPT":
        case "RSET":
        case "NOOP":
          socket.write("250 OK\r\n");
          break;
        case "DATA":
          inData = true;
          socket.write("354 Send data\r\n");
          break;
        case "QUIT":
          socket.write("221 Bye\r\n");
          socket.end();
          break;
        default:
          socket.write("250 OK\r\n");
      }
    }
  });

  socket.on("error", () => {});
});

server.listen(port, () => {
  console.log(`Mock SMTP server listening on port ${port}`);
});
