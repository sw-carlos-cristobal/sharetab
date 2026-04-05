import { NextRequest } from "next/server";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { readFile, stat } from "fs/promises";
import { resolve, sep } from "path";
import { getUploadDir } from "@/server/lib/upload-dir";

const MIME_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
};

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const session = await auth();

  const { path } = await params;
  const filePath = path.join("/");

  const uploadDir = getUploadDir();
  const fullPath = resolve(uploadDir, filePath);

  // Prevent directory traversal by verifying resolved path stays within uploadDir
  if (!fullPath.startsWith(uploadDir + sep) && fullPath !== uploadDir) {
    return new Response("Forbidden", { status: 403 });
  }

  // Verify receipt ownership
  const receipt = await db.receipt.findFirst({
    where: { imagePath: filePath },
    include: { group: { include: { members: true } } },
  });

  if (!receipt) {
    return new Response("Not found", { status: 404 });
  }

  if (session?.user?.id) {
    // Authenticated user: must be the uploader or a member of the receipt's group
    const isUploader = receipt.uploadedById === session.user.id;
    const isGroupMember = receipt.group?.members.some(
      (m: { userId: string }) => m.userId === session.user.id
    ) ?? false;
    if (!isUploader && !isGroupMember) {
      return new Response("Forbidden", { status: 403 });
    }
  } else {
    // Unauthenticated: only allow guest receipts
    if (!receipt.isGuest) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  try {
    await stat(fullPath);
    const buffer = await readFile(fullPath);
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

    return new Response(buffer, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "private, max-age=86400",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
