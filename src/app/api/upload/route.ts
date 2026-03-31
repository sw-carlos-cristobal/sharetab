import { NextRequest } from "next/server";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { logger } from "@/server/lib/logger";
import { writeFile, mkdir } from "fs/promises";
import { join, resolve } from "path";
import { randomUUID } from "crypto";

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic"];
const MAX_SIZE = parseInt(process.env.MAX_UPLOAD_SIZE_MB ?? "10") * 1024 * 1024;

// Simple in-memory rate limiter for guest uploads
const guestUploads = new Map<string, { count: number; resetAt: number }>();
const GUEST_RATE_LIMIT = 10; // max uploads per hour per IP
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
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
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

  const uploadDir = /* turbopackIgnore: true */ resolve(process.env.UPLOAD_DIR ?? "uploads");
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
    userId: userId ?? "guest",
    mimeType: file.type,
    fileSize: file.size,
    isGuest,
  });

  return Response.json({ receiptId: receipt.id, imagePath: receipt.imagePath });
}
