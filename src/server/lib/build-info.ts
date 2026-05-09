import fs from "fs";
import path from "path";
import { logger } from "./logger";

interface BuildInfo {
  version: string;
  commitSha: string;
}

let cached: BuildInfo | null = null;

export function getBuildInfo(): BuildInfo {
  if (cached) return cached;

  let version = "unknown";
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf-8"));
    version = pkg.version;
  } catch (error) {
    logger.warn("build-info.version.failed", {
      error: error instanceof Error ? error.message : "Unknown",
    });
  }

  let commitSha = "unknown";
  try {
    commitSha = fs.readFileSync(path.resolve(process.cwd(), ".commit-sha"), "utf-8").trim();
  } catch {
    if (process.env.NODE_ENV !== "test") {
      try {
        const { execFileSync } = require("child_process");
        commitSha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf-8" }).trim();
      } catch (error) {
        logger.warn("build-info.commitSha.failed", {
          error: error instanceof Error ? error.message : "Unknown",
        });
      }
    }
  }

  cached = { version, commitSha };
  return cached;
}
