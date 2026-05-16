import { NextRequest } from "next/server";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { logger } from "@/server/lib/logger";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { getUploadDir } from "@/server/lib/upload-dir";
import { randomUUID } from "crypto";

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic"];
const MAX_SIZE = parseInt(process.env.MAX_UPLOAD_SIZE_MB ?? "10") * 1024 * 1024;

/**
 * Detect MIME type from magic bytes to prevent client MIME spoofing.
 */
function detectMimeType(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return "image/png";
  }

  // WebP: RIFF....WEBP
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return "image/webp";
  }

  // HEIC: check for ftyp box with heic/heix/mif1 brands
  if (buffer.length >= 12 && buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) {
    const brand = buffer.toString("ascii", 8, 12);
    if (["heic", "heix", "mif1"].includes(brand)) {
      return "image/heic";
    }
  }

  return null;
}

// Simple in-memory rate limiter for guest uploads
const guestUploads = new Map<string, { count: number; resetAt: number }>();
const parsedGuestLimit = Math.floor(Number(process.env.GUEST_RATE_LIMIT_MAX));
const GUEST_RATE_LIMIT = parsedGuestLimit > 0 ? parsedGuestLimit : 10;
const GUEST_RATE_WINDOW = 60 * 60 * 1000; // 1 hour

function checkGuestRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = guestUploads.get(ip);
  if (!entry || now > entry.resetAt) {
    guestUploads.set(ip, { count: 1, resetAt: now + GUEST_RATE_WINDOW });
    return true;
  }
  if (entry.count >= GUEST_RATE_LIMIT) return false;
  entry.count++;
  return true;
}

export async function POST(req: NextRequest) {
  const isGuest = req.nextUrl.searchParams.get("guest") === "true";
  let userId: string | undefined;

  if (isGuest) {
    // Guest upload: rate limit by IP
    const ip = req.headers.get("cf-connecting-ip")
      || req.headers.get("x-real-ip")
      || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      || "unknown";
    if (!checkGuestRateLimit(ip)) {
      return Response.json({ error: "Too many uploads. Please try again later." }, { status: 429 });
    }
  } else {
    // Authenticated upload
    const session = await auth();
    if (!session?.user?.id) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    userId = session.user.id;
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

  const uploadDir = getUploadDir();
  const receiptsDir = join(uploadDir, "receipts");
  await mkdir(receiptsDir, { recursive: true });

  const MIME_TO_EXT: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/heic": "heic",
  };
  const ext = MIME_TO_EXT[file.type] ?? "jpg";
  const filename = `${randomUUID()}.${ext}`;
  const filepath = join(receiptsDir, filename);

  const buffer = Buffer.from(await file.arrayBuffer());

  // Validate magic bytes to prevent client MIME type spoofing
  const detectedMime = detectMimeType(buffer);
  if (!detectedMime || !ALLOWED_TYPES.includes(detectedMime)) {
    return Response.json(
      { error: "File content does not match an allowed image type" },
      { status: 400 }
    );
  }

  await writeFile(filepath, buffer);

  let receipt;
  try {
    receipt = await db.receipt.create({
      data: {
        imagePath: `receipts/${filename}`,
        originalName: file.name,
        mimeType: file.type,
        fileSize: file.size,
        status: "PENDING",
        uploadedById: userId ?? null,
        isGuest,
      },
    });
  } catch (error) {
    // Clean up the written file if DB record creation fails
    try {
      const { unlink } = await import("fs/promises");
      await unlink(filepath);
    } catch {
      // Best-effort cleanup
    }
    logger.error("upload.dbFailed", {
      error: error instanceof Error ? error.message : "Unknown",
      filepath,
    });
    return Response.json({ error: "Failed to create receipt record" }, { status: 500 });
  }

  logger.info("upload.receipt", {
    receiptId: receipt.id,
    userId: userId ?? "guest",
    mimeType: file.type,
    fileSize: file.size,
    isGuest,
  });

  return Response.json({ receiptId: receipt.id, imagePath: receipt.imagePath });
}
