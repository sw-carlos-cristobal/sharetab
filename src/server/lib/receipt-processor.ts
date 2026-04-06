import type { PrismaClient } from "@/generated/prisma/client";
import type { Prisma } from "@/generated/prisma/client";
import { getAIProviderWithFallback } from "../ai/registry";
import { logger } from "./logger";

/**
 * Normalize a date string from any common format to ISO YYYY-MM-DD.
 * Handles: MM/DD/YYYY, DD.MM.YYYY, DD-MM-YYYY, YYYY-MM-DD, and 2-digit years.
 */
function normalizeDate(date: string | undefined): string | undefined {
  if (!date) return undefined;
  const trimmed = date.trim();

  // Already ISO format
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  // Match common patterns: DD/MM/YYYY, MM/DD/YYYY, DD.MM.YYYY, DD-MM-YYYY
  const match = trimmed.match(/^(\d{1,2})([\/.\-])(\d{1,2})\2(\d{2,4})$/);
  if (match) {
    const [, a, , b, yearStr] = match;
    let year = parseInt(yearStr, 10);
    if (year < 100) year += year < 50 ? 2000 : 1900;
    const n1 = parseInt(a, 10);
    const n2 = parseInt(b, 10);

    // Disambiguate: if first number > 12, it must be a day (DD/MM format)
    // Otherwise assume MM/DD (US format, more common in receipt data)
    let month: number, day: number;
    if (n1 > 12) {
      day = n1; month = n2;
    } else if (n2 > 12) {
      month = n1; day = n2;
    } else {
      // Ambiguous — assume MM/DD (US convention)
      month = n1; day = n2;
    }

    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }

  // Couldn't parse — return as-is
  return trimmed;
}

interface ProcessReceiptImageOptions {
  db: PrismaClient;
  receiptId: string;
  receipt: { imagePath: string; mimeType: string };
  correctionHint?: string;
  logPrefix?: string;
}

/**
 * Shared receipt processing logic used by both authenticated and guest flows.
 * Reads the image file, calls the AI provider, creates receipt items in DB,
 * and updates the receipt record with the extraction result.
 */
export async function processReceiptImage({
  db,
  receiptId,
  receipt,
  correctionHint,
  logPrefix = "receipt",
}: ProcessReceiptImageOptions) {
  const { readFile } = await import("fs/promises");
  const { join } = await import("path");
  const { getUploadDir } = await import("./upload-dir");
  const filepath = join(getUploadDir(), receipt.imagePath);
  const imageBuffer = await readFile(filepath);

  const provider = await getAIProviderWithFallback();
  logger.info(`${logPrefix}.processing`, {
    receiptId,
    provider: provider.name,
    imageSize: imageBuffer.length,
    correctionHint: correctionHint ?? null,
  });
  const start = Date.now();
  const result = await provider.extractReceipt(
    imageBuffer,
    receipt.mimeType,
    correctionHint
  );
  logger.info(`${logPrefix}.extracted`, {
    receiptId,
    provider: provider.name,
    items: result.items.length,
    total: result.total,
    durationMs: Date.now() - start,
  });

  // Delete any existing items before (re-)creating — prevents duplicates on reprocess
  await db.receiptItem.deleteMany({ where: { receiptId } });

  // Create receipt items in DB
  await db.receiptItem.createMany({
    data: result.items.map((item, i) => ({
      receiptId,
      name: item.name,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      totalPrice: item.totalPrice,
      sortOrder: i,
    })),
  });

  const normalizedDate = normalizeDate(result.date);

  await db.receipt.update({
    where: { id: receiptId },
    data: {
      status: "COMPLETED",
      aiProvider: provider.name,
      rawResponse: result as unknown as Prisma.InputJsonValue,
      extractedData: {
        merchantName: result.merchantName,
        date: normalizedDate,
        subtotal: result.subtotal,
        tax: result.tax,
        tip: result.tip,
        total: result.total,
        currency: result.currency,
      } as unknown as Prisma.InputJsonValue,
    },
  });

  return {
    status: "COMPLETED" as const,
    merchantName: result.merchantName,
    date: normalizedDate,
    subtotal: result.subtotal,
    tax: result.tax,
    tip: result.tip,
    total: result.total,
    currency: result.currency,
    itemCount: result.items.length,
  };
}
