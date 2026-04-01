import { cookies } from "next/headers";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { logAdminAction } from "@/server/trpc/routers/admin";

const COOKIE_NAME = "sharetab-impersonate";

/**
 * POST /api/admin/impersonate
 * Body: { userId: string }
 * Sets impersonation cookie so tRPC context switches effective user.
 */
export async function POST(req: Request) {
  const session = await auth();
  const adminEmail = process.env.ADMIN_EMAIL;

  if (!session?.user?.id || !adminEmail || session.user.email !== adminEmail) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const targetUserId = body.userId;

  if (!targetUserId || typeof targetUserId !== "string") {
    return Response.json({ error: "userId is required" }, { status: 400 });
  }

  if (targetUserId === session.user.id) {
    return Response.json(
      { error: "Cannot impersonate yourself" },
      { status: 400 }
    );
  }

  const targetUser = await db.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, name: true, email: true },
  });

  if (!targetUser) {
    return Response.json({ error: "User not found" }, { status: 404 });
  }

  // Store impersonation data as JSON in a secure cookie
  const impersonationData = JSON.stringify({
    adminId: session.user.id,
    adminEmail: session.user.email,
    targetId: targetUser.id,
    targetName: targetUser.name,
    targetEmail: targetUser.email,
    startedAt: new Date().toISOString(),
  });

  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, impersonationData, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60, // 1 hour max
  });

  await logAdminAction(db, session.user.id, "IMPERSONATION_STARTED", targetUserId, {
    targetEmail: targetUser.email,
    targetName: targetUser.name,
  });

  return Response.json({
    success: true,
    impersonating: {
      id: targetUser.id,
      name: targetUser.name,
      email: targetUser.email,
    },
  });
}

/**
 * DELETE /api/admin/impersonate
 * Clears the impersonation cookie.
 */
export async function DELETE() {
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
  return Response.json({ success: true });
}
