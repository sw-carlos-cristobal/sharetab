import { db } from "@/server/db";
import { logger } from "@/server/lib/logger";

export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`;
    return Response.json({ status: "ok", db: "connected" });
  } catch (err) {
    logger.error("health.db_disconnected", {
      error: err instanceof Error ? err.message : "Unknown",
    });
    return Response.json({ status: "error", db: "disconnected" }, { status: 503 });
  }
}
