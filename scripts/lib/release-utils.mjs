import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(scriptsDir, "..", "..");
const packageJsonPath = path.join(repoRoot, "package.json");
const changelogPath = path.join(repoRoot, "CHANGELOG.md");

export function parseArgs(argv) {
  const flags = {};
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const trimmed = arg.slice(2);
    const [key, inlineValue] = trimmed.split("=", 2);
    if (inlineValue !== undefined) {
      flags[key] = inlineValue;
      continue;
    }

    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i += 1;
      continue;
    }

    flags[key] = true;
  }

  return { flags, positional };
}

export function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "inherit",
    ...options,
  });
}

export function capture(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

export function ensureTool(command, versionArgs = ["--version"]) {
  try {
    capture(command, versionArgs);
  } catch {
    throw new Error(`Required tool not found: ${command}`);
  }
}

export function ensureCleanWorktree() {
  const status = capture("git", ["status", "--porcelain"]);
  if (status) {
    throw new Error("Working tree is not clean. Commit or stash changes before running this command.");
  }
}

export function getCurrentBranch() {
  return capture("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
}

export function ensureOnMainBranch() {
  const branch = getCurrentBranch();
  if (branch !== "main") {
    throw new Error(`Expected to run on main, but current branch is ${branch}.`);
  }
}

export function readPackageJson() {
  return JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
}

export function readCurrentVersion() {
  return readPackageJson().version;
}

export function normalizeRepoUrl(rawUrl) {
  return rawUrl.replace(/^git\+/, "").replace(/\.git$/, "");
}

export function readRepositoryUrl() {
  const pkg = readPackageJson();
  if (typeof pkg.repository === "string") {
    return normalizeRepoUrl(pkg.repository);
  }
  if (pkg.repository?.url) {
    return normalizeRepoUrl(pkg.repository.url);
  }
  if (pkg.homepage) {
    return normalizeRepoUrl(pkg.homepage);
  }
  throw new Error("Unable to determine repository URL from package.json.");
}

export function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

export function getLastTagOrRootCommit() {
  try {
    return capture("git", ["describe", "--tags", "--abbrev=0"]);
  } catch {
    return capture("git", ["rev-list", "--max-parents=0", "HEAD"]);
  }
}

export function getPreviousTagOrRootCommit(tag) {
  try {
    return capture("git", ["describe", "--tags", "--abbrev=0", `${tag}^`]);
  } catch {
    return capture("git", ["rev-list", "--max-parents=0", tag]);
  }
}

function gitLogEntries(range, grepPatterns) {
  const args = ["log", range, "--pretty=format:%s|%h"];
  for (const pattern of grepPatterns) {
    args.push(`--grep=${pattern}`);
  }

  const output = capture("git", args, { stdio: ["ignore", "pipe", "ignore"] });
  if (!output) {
    return [];
  }

  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const separatorIndex = line.lastIndexOf("|");
      return {
        message: line.slice(0, separatorIndex),
        hash: line.slice(separatorIndex + 1),
      };
    });
}

function stripConventionalPrefix(type, message) {
  const scopedPrefix = new RegExp(`^${type}\\(([^)]+)\\):\\s+`);
  if (scopedPrefix.test(message)) {
    return message.replace(scopedPrefix, "$1: ");
  }

  const plainPrefix = new RegExp(`^${type}:\\s+`);
  return message.replace(plainPrefix, "");
}

function buildSection(title, entries, formatter) {
  if (entries.length === 0) {
    return "";
  }

  const lines = [title];
  for (const entry of entries) {
    lines.push(`- ${formatter(entry)} (${entry.hash})`);
  }
  lines.push("");
  return lines.join("\n");
}

export function buildReleaseNotes({ fromRef, toRef, compareTo }) {
  const range = `${fromRef}..${toRef}`;
  const features = gitLogEntries(range, ["^feat"]);
  const fixes = gitLogEntries(range, ["^fix"]);
  const others = gitLogEntries(range, ["^(refactor|perf|ci|test|docs)"]);

  const sections = ["## What's Changed", ""];
  const featureSection = buildSection("### Features", features, ({ message }) =>
    stripConventionalPrefix("feat", message),
  );
  const fixSection = buildSection("### Bug Fixes", fixes, ({ message }) =>
    stripConventionalPrefix("fix", message),
  );
  const otherSection = buildSection("### Other Changes", others, ({ message }) => message);

  for (const section of [featureSection, fixSection, otherSection]) {
    if (section) {
      sections.push(section);
    }
  }

  if (sections.length === 2) {
    sections.push("- No user-facing changes captured by the release note filters.");
    sections.push("");
  }

  sections.push(`**Full Changelog**: ${readRepositoryUrl()}/compare/${fromRef}...${compareTo}`);
  return sections.join("\n");
}

export function updateChangelog({ version, date, body }) {
  const existing = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, "utf8") : "";
  const bodyLines = body.split("\n");
  const releaseBody = bodyLines[0] === "## What's Changed" ? bodyLines.slice(2).join("\n") : body;

  const next = [
    "# Changelog",
    "",
    `## [v${version}] - ${date}`,
    "",
    releaseBody.trimEnd(),
    "",
  ];

  if (existing) {
    next.push(existing.replace(/^# Changelog\s*\n?/, "").trimStart());
  }

  fs.writeFileSync(changelogPath, `${next.join("\n").trimEnd()}\n`);
}

export function prepareVersionFiles(bump) {
  const allowed = new Set(["patch", "minor", "major"]);
  if (!allowed.has(bump)) {
    throw new Error(`Invalid bump "${bump}". Expected patch, minor, or major.`);
  }

  run("npm", ["version", bump, "--no-git-tag-version"]);

  const version = readCurrentVersion();
  const previousRef = getLastTagOrRootCommit();
  const body = buildReleaseNotes({
    fromRef: previousRef,
    toRef: "HEAD",
    compareTo: `v${version}`,
  });
  updateChangelog({
    version,
    date: todayIsoDate(),
    body,
  });

  return { version, previousRef, body };
}

export function buildTaggedReleaseNotes(tag) {
  const version = tag.startsWith("v") ? tag.slice(1) : tag;
  const normalizedTag = `v${version}`;
  const previousTag = getPreviousTagOrRootCommit(normalizedTag);
  const body = buildReleaseNotes({
    fromRef: previousTag,
    toRef: normalizedTag,
    compareTo: normalizedTag,
  });

  return { version, tag: normalizedTag, previousTag, body };
}

export function branchExists(branch) {
  try {
    capture("git", ["show-ref", "--verify", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

export function remoteBranchExists(branch) {
  try {
    capture("git", ["ls-remote", "--exit-code", "--heads", "origin", branch]);
    return true;
  } catch {
    return false;
  }
}

export function findExistingPrUrl({ head, base = "main" }) {
  try {
    return capture("gh", ["pr", "list", "--head", head, "--base", base, "--json", "url", "--jq", ".[0].url"]);
  } catch {
    return "";
  }
}

export function createTempFile(prefix, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const filePath = path.join(dir, "body.md");
  fs.writeFileSync(filePath, content);
  return filePath;
}

export function writeGithubOutput(outputPath, values) {
  if (!outputPath) {
    return;
  }

  const lines = [];
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "string" && value.includes("\n")) {
      lines.push(`${key}<<EOF`);
      lines.push(value);
      lines.push("EOF");
    } else {
      lines.push(`${key}=${value}`);
    }
  }

  fs.appendFileSync(outputPath, `${lines.join("\n")}\n`);
}
