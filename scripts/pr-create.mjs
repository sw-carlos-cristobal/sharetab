import {
  createTempFile,
  ensureTool,
  findExistingPrUrl,
  getCurrentBranch,
  parseArgs,
  run,
} from "./lib/release-utils.mjs";

function printUsage() {
  console.log("Usage: npm run pr:create -- [--base main] [--title \"Title\"] [--body \"Body\"] [--body-file path]");
}

try {
  const { flags } = parseArgs(process.argv.slice(2));
  if (flags.help) {
    printUsage();
    process.exit(0);
  }

  ensureTool("gh");

  const branch = getCurrentBranch();
  if (branch === "main") {
    throw new Error("Refusing to open a PR from main. Switch to a feature branch first.");
  }

  const base = typeof flags.base === "string" ? flags.base : "main";
  const existing = findExistingPrUrl({ head: branch, base });
  if (existing) {
    console.log(existing);
    process.exit(0);
  }

  const args = ["pr", "create", "--base", base, "--head", branch];
  if (typeof flags.title === "string") {
    args.push("--title", flags.title);
  }

  if (typeof flags["body-file"] === "string") {
    args.push("--body-file", flags["body-file"]);
  } else if (typeof flags.body === "string") {
    const bodyFile = createTempFile("sharetab-pr-body", flags.body);
    args.push("--body-file", bodyFile);
  } else {
    args.push("--fill");
  }

  const prUrl = run("gh", args, { stdio: ["ignore", "pipe", "inherit"] }).trim();
  console.log(prUrl);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
