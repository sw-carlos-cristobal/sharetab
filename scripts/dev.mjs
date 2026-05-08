import EmbeddedPostgres from "embedded-postgres";
import { spawn, execSync } from "child_process";
import { rmSync, readFileSync } from "fs";
import { join } from "path";
import { createConnection } from "net";

// Kill any process using a port
function killPort(port) {
  try {
    const out = execSync(
      `powershell -Command "(Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue).OwningProcess"`,
      { encoding: "utf8" }
    ).trim();
    for (const pid of new Set(out.split(/\r?\n/).map(s => s.trim()).filter(Boolean))) {
      if (pid !== "0") {
        console.log(`Killing process ${pid} on port ${port}...`);
        execSync(`powershell -Command "Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue"`);
      }
    }
  } catch {}
}

// Kill stale servers from previous runs
killPort(3000);
killPort(51214);

const pg = new EmbeddedPostgres({
  port: 51214,
  user: "postgres",
  password: "postgres",
  persistent: true,
  dataPath: "./test-pg-data",
  initdbFlags: ["--encoding=UTF8", "--locale=en_US.UTF-8"],
});

// Start PostgreSQL
console.log("Starting PostgreSQL...");
try {
  await pg.initialise();
  console.log("Initialised new database cluster.");
} catch {
  // Already initialised
}

try {
  await pg.start();
} catch {
  // Stale lock file from a previous crash — remove it and retry
  console.log("Removing stale lock file and retrying...");
  try { rmSync(join("data", "db", "postmaster.pid")); } catch {}
  await pg.start();
}
console.log("PostgreSQL running on port 51214.");

// Push schema + seed if first run (check if tables exist)
try {
  execSync("npx prisma db push", { stdio: "inherit" });
  // Try seeding — will no-op if data already exists (upserts)
  execSync("npm run db:seed", { stdio: "inherit" });
} catch (e) {
  console.log("Schema/seed warning:", e.message);
}

// Print startup banner
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
let commitSha = "unknown";
try {
  commitSha = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
} catch {}
console.log("");
console.log("============================================");
console.log("  ShareTab Dev Server");
console.log("============================================");
console.log(`  Version:  ${pkg.version}`);
console.log(`  Commit:   ${commitSha}`);
console.log("============================================");

// Start Next.js dev server
console.log("\nStarting Next.js dev server...");
const next = spawn("npx", ["next", "dev"], {
  stdio: "inherit",
  shell: true,
});

// Cleanup on exit
async function shutdown() {
  console.log("\nShutting down...");
  next.kill();
  await pg.stop();
  console.log("Stopped.");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
next.on("exit", shutdown);
