import { db } from "@/server/db";

export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`;
    return Response.json({ status: "ok", db: "connected" });
  } catch {
    return Response.json({ status: "error", db: "disconnected" }, { status: 503 });
  }
}
