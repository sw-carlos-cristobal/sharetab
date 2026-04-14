import fs from "node:fs";
import { buildTaggedReleaseNotes, parseArgs, writeGithubOutput } from "./lib/release-utils.mjs";

function printUsage() {
  console.log("Usage: node scripts/release-notes.mjs --tag v1.2.3 [--output release-notes.md] [--github-output path]");
}

try {
  const { flags } = parseArgs(process.argv.slice(2));
  const tag = typeof flags.tag === "string" ? flags.tag : "";

  if (flags.help || !tag) {
    printUsage();
    process.exit(flags.help ? 0 : 1);
  }

  const { version, previousTag, body } = buildTaggedReleaseNotes(tag);
  if (typeof flags.output === "string") {
    fs.writeFileSync(flags.output, `${body}\n`);
  } else {
    console.log(body);
  }

  writeGithubOutput(flags["github-output"] === true ? process.env.GITHUB_OUTPUT : flags["github-output"], {
    version,
    previous_tag: previousTag,
    body,
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
