export async function register() {
  // Only run on the server (not during build or in edge runtime)
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getBuildInfo } = await import("@/server/lib/build-info");
    const { version, commitSha } = getBuildInfo();

    const { logger } = await import("@/server/lib/logger");
    logger.info("app.startup", { version, commitSha });

    const { startPoller } = await import("@/server/lib/auth-health-poller");
    startPoller();
  }
}
