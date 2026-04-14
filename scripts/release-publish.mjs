import { ensureCleanWorktree, ensureOnMainBranch, parseArgs, readCurrentVersion, run } from "./lib/release-utils.mjs";

function printUsage() {
  console.log("Usage: npm run release:publish -- [v1.2.3]");
}

try {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const defaultTag = `v${readCurrentVersion()}`;
  const tag = positional[0] || defaultTag;

  if (flags.help || tag === "help") {
    printUsage();
    process.exit(0);
  }

  ensureCleanWorktree();
  ensureOnMainBranch();

  run("git", ["fetch", "--tags", "origin"]);
  run("git", ["tag", tag]);
  run("git", ["push", "origin", tag]);

  console.log(`Pushed tag ${tag}. GitHub Actions will publish the release and semver Docker tags.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
