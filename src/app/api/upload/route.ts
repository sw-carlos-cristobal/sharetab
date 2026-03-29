import { NextRequest } from "next/server";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { logger } from "@/server/lib/logger";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic"];
const MAX_SIZE = parseInt(process.env.MAX_UPLOAD_SIZE_MB ?? "10") * 1024 * 1024;

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const formData = await req.formData();
  const file = formData.get("file") as File | null;

  if (!file) {
    return Response.json({ error: "No file provided" }, { status: 400 });
  }

  if (!ALLOWED_TYPES.includes(file.type)) {
    return Response.json(
      { error: `Invalid file type. Allowed: ${ALLOWED_TYPES.join(", ")}` },
      { status: 400 }
    );
  }

  if (file.size > MAX_SIZE) {
    return Response.json(
      { error: `File too large. Max: ${process.env.MAX_UPLOAD_SIZE_MB ?? 10}MB` },
      { status: 400 }
    );
  }

  const uploadDir = process.env.UPLOAD_DIR ?? "./uploads";
  const receiptsDir = join(uploadDir, "receipts");
  await mkdir(receiptsDir, { recursive: true });

  const ext = file.name.split(".").pop() ?? "jpg";
  const filename = `${randomUUID()}.${ext}`;
  const filepath = join(receiptsDir, filename);

  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(filepath, buffer);

  const receipt = await db.receipt.create({
    data: {
      imagePath: `receipts/${filename}`,
      originalName: file.name,
      mimeType: file.type,
      fileSize: file.size,
      status: "PENDING",
    },
  });

  logger.info("upload.receipt", {
    receiptId: receipt.id,
    userId: session.user.id,
    mimeType: file.type,
    fileSize: file.size,
  });

  return Response.json({ receiptId: receipt.id, imagePath: receipt.imagePath });
}
