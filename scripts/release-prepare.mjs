import {
  branchExists,
  createTempFile,
  ensureCleanWorktree,
  ensureOnMainBranch,
  ensureTool,
  findExistingPrUrl,
  parseArgs,
  prepareVersionFiles,
  remoteBranchExists,
  run,
  writeGithubOutput,
} from "./lib/release-utils.mjs";

function printUsage() {
  console.log("Usage: npm run release:prepare -- <patch|minor|major>");
}

try {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const bump = positional[0];

  if (flags.help || !bump || bump === "help") {
    printUsage();
    process.exit(flags.help || bump === "help" ? 0 : 1);
  }

  ensureTool("gh");
  ensureCleanWorktree();
  ensureOnMainBranch();

  const { version, body } = prepareVersionFiles(bump);
  const branch = `release/v${version}`;
  if (branchExists(branch) || remoteBranchExists(branch)) {
    throw new Error(`Release branch already exists: ${branch}`);
  }

  run("git", ["switch", "-c", branch]);
  run("git", ["add", "package.json", "package-lock.json", "CHANGELOG.md"]);
  run("git", ["commit", "-m", `chore(release): v${version}`]);
  run("git", ["push", "-u", "origin", branch]);

  let prUrl = findExistingPrUrl({ head: branch, base: "main" });
  if (!prUrl) {
    const bodyFile = createTempFile("sharetab-release-pr", body);
    prUrl = run(
      "gh",
      [
        "pr",
        "create",
        "--base",
        "main",
        "--head",
        branch,
        "--title",
        `chore(release): v${version}`,
        "--body-file",
        bodyFile,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    ).trim();
  }

  writeGithubOutput(flags["github-output"] === true ? process.env.GITHUB_OUTPUT : flags["github-output"], {
    version,
    branch,
    pr_url: prUrl,
    body,
  });

  console.log(`Prepared release branch ${branch}`);
  console.log(`Opened PR ${prUrl}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
