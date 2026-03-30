import EmbeddedPostgres from "embedded-postgres";
import { execSync } from "child_process";

const pg = new EmbeddedPostgres({
  port: 51214,
  user: "postgres",
  password: "postgres",
  persistent: true,
  dataPath: "./test-pg-data",
  initdbFlags: ["--encoding=UTF8", "--locale=en_US.UTF-8"],
});

const mode = process.argv[2]; // "start", "setup", or undefined (both)

if (mode !== "setup") {
  console.log("Starting embedded PostgreSQL on port 51214...");
  try {
    await pg.initialise();
  } catch {
    console.log("Already initialised, starting...");
  }
  await pg.start();
  console.log("PostgreSQL is running.");
}

if (mode !== "start") {
  console.log("Pushing Prisma schema...");
  execSync("npx prisma db push", { stdio: "inherit", cwd: process.cwd() });

  console.log("Seeding database...");
  execSync("npm run db:seed", { stdio: "inherit", cwd: process.cwd() });
}

console.log("\nDatabase ready. Press Ctrl+C to stop.");

process.on("SIGINT", async () => {
  console.log("\nStopping PostgreSQL...");
  await pg.stop();
  process.exit(0);
});

// Keep alive
setInterval(() => {}, 60000);
