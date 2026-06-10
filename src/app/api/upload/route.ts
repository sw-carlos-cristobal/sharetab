import { NextRequest } from "next/server";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { logger } from "@/server/lib/logger";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { getUploadDir } from "@/server/lib/upload-dir";
import { getClientIp } from "@/server/lib/client-ip";
import { randomUUID } from "crypto";

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic"];
// Fall back to 10MB when the env var is unset or non-numeric — a NaN limit
// would make every size comparison false and disable the check entirely.
const parsedMaxMb = parseInt(process.env.MAX_UPLOAD_SIZE_MB ?? "10", 10);
const MAX_SIZE_MB = parsedMaxMb > 0 ? parsedMaxMb : 10;
const MAX_SIZE = MAX_SIZE_MB * 1024 * 1024;

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

// Global cap across all guest uploads per window: per-IP limits can be
// bypassed by rotating spoofed forwarded-IP headers, so bound total
// unauthenticated disk usage regardless of source.
const parsedGlobalLimit = Math.floor(Number(process.env.GUEST_UPLOAD_GLOBAL_LIMIT));
const GUEST_GLOBAL_LIMIT = parsedGlobalLimit > 0 ? parsedGlobalLimit : 100;
const GLOBAL_KEY = "__global__";

// Hard ceiling on tracked IP buckets. Pruning expired entries alone is not
// enough: spoofed, rotating forwarded-IP headers can mint unlimited fresh
// buckets inside a single window. Above the cap, oldest entries are evicted
// (insertion order) — the global bucket remains the real abuse bound.
const MAX_TRACKED_IPS = 5000;

function pruneExpiredEntries(now: number): void {
  if (guestUploads.size <= 1000) return;
  for (const [key, value] of guestUploads) {
    if (now > value.resetAt) guestUploads.delete(key);
  }
  if (guestUploads.size <= MAX_TRACKED_IPS) return;
  for (const key of guestUploads.keys()) {
    if (key === GLOBAL_KEY) continue;
    guestUploads.delete(key);
    if (guestUploads.size <= MAX_TRACKED_IPS) break;
  }
}

function hasCapacity(key: string, limit: number, now: number): boolean {
  const entry = guestUploads.get(key);
  return !entry || now > entry.resetAt || entry.count < limit;
}

function increment(key: string, now: number): void {
  const entry = guestUploads.get(key);
  if (!entry || now > entry.resetAt) {
    guestUploads.set(key, { count: 1, resetAt: now + GUEST_RATE_WINDOW });
  } else {
    entry.count++;
  }
}

/**
 * Check remaining budget without consuming it — used as a cheap early
 * rejection before the request body is parsed.
 */
function hasGuestUploadBudget(ip: string): boolean {
  const now = Date.now();
  pruneExpiredEntries(now);
  return (
    hasCapacity(GLOBAL_KEY, GUEST_GLOBAL_LIMIT, now) &&
    hasCapacity(ip, GUEST_RATE_LIMIT, now)
  );
}

/**
 * Consume one upload slot. Called only after the upload passes validation, so
 * rejected/invalid requests never burn budget. Both buckets are checked
 * before either is incremented: an over-limit IP must not drain the shared
 * global pool, and a full global pool must not burn the caller's IP budget.
 */
function consumeGuestUploadBudget(ip: string): boolean {
  const now = Date.now();
  if (
    !hasCapacity(ip, GUEST_RATE_LIMIT, now) ||
    !hasCapacity(GLOBAL_KEY, GUEST_GLOBAL_LIMIT, now)
  ) {
    return false;
  }
  increment(ip, now);
  increment(GLOBAL_KEY, now);
  return true;
}

export async function POST(req: NextRequest) {
  const isGuest = req.nextUrl.searchParams.get("guest") === "true";
  let userId: string | undefined;
  let guestIp: string | null = null;

  if (isGuest) {
    // Guest upload: rate limit by IP. Peek only — budget is consumed after
    // the upload passes validation so invalid requests can't burn it.
    guestIp = getClientIp(req.headers);
    if (!hasGuestUploadBudget(guestIp)) {
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
      { error: `File too large. Max: ${MAX_SIZE_MB}MB` },
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

  // All validation passed — now consume guest budget (per-IP, then global)
  if (guestIp !== null && !consumeGuestUploadBudget(guestIp)) {
    return Response.json({ error: "Too many uploads. Please try again later." }, { status: 429 });
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
