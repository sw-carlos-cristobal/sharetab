import { NextRequest } from "next/server";
import { auth } from "@/server/auth";
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
  if (!session?.user?.id) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { path } = await params;
  const filePath = path.join("/");

  const uploadDir = getUploadDir();
  const fullPath = resolve(uploadDir, filePath);

  // Prevent directory traversal by verifying resolved path stays within uploadDir
  if (!fullPath.startsWith(uploadDir + sep) && fullPath !== uploadDir) {
    return new Response("Forbidden", { status: 403 });
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
