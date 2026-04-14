import { ensureCleanWorktree, parseArgs, run } from "./lib/release-utils.mjs";

function printUsage() {
  console.log("Usage: npm run push:main");
}

try {
  const { flags } = parseArgs(process.argv.slice(2));
  if (flags.help) {
    printUsage();
    process.exit(0);
  }

  ensureCleanWorktree();
  run("git", ["push", "origin", "HEAD:main"]);
  console.log("Pushed current HEAD to origin/main.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
