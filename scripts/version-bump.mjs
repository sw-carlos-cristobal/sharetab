import { ensureCleanWorktree, ensureOnMainBranch, parseArgs, prepareVersionFiles } from "./lib/release-utils.mjs";

function printUsage() {
  console.log("Usage: npm run version:bump -- <patch|minor|major>");
}

try {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const bump = positional[0];

  if (flags.help || !bump || bump === "help") {
    printUsage();
    process.exit(flags.help || bump === "help" ? 0 : 1);
  }

  ensureCleanWorktree();
  ensureOnMainBranch();

  const { version } = prepareVersionFiles(bump);
  console.log(`Version bumped to v${version} and CHANGELOG.md updated.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
