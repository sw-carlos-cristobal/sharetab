export async function register() {
  // Only run on the server (not during build or in edge runtime)
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const fs = await import("fs");
    const path = await import("path");

    let version = "unknown";
    try {
      const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf-8"));
      version = pkg.version;
    } catch {}

    let commitSha = "unknown";
    try {
      commitSha = fs.readFileSync(path.resolve(process.cwd(), ".commit-sha"), "utf-8").trim();
    } catch {
      try {
        const { execFileSync } = await import("child_process");
        commitSha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf-8" }).trim();
      } catch {}
    }

    console.log(`ShareTab v${version} (${commitSha})`);

    const { startPoller } = await import("@/server/lib/auth-health-poller");
    startPoller();
  }
}
