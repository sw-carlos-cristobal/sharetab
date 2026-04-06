import type { PrismaClient } from "@/generated/prisma/client";
import type { Prisma } from "@/generated/prisma/client";
import { getAIProviderWithFallback, clearProviderCache } from "../ai/registry";
import { logger } from "./logger";
import { normalizeDate } from "./normalize-date";

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

  let provider = await getAIProviderWithFallback();
  logger.info(`${logPrefix}.processing`, {
    receiptId,
    provider: provider.name,
    imageSize: imageBuffer.length,
    correctionHint: correctionHint ?? null,
  });
  const start = Date.now();
  let result;
  try {
    result = await provider.extractReceipt(
      imageBuffer,
      receipt.mimeType,
      correctionHint
    );
  } catch (err) {
    // Cached provider may be stale — clear cache and retry once with fresh provider
    logger.warn(`${logPrefix}.extractFailed`, {
      receiptId,
      provider: provider.name,
      error: err instanceof Error ? err.message : String(err),
    });
    clearProviderCache();
    provider = await getAIProviderWithFallback();
    result = await provider.extractReceipt(
      imageBuffer,
      receipt.mimeType,
      correctionHint
    );
  }
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
