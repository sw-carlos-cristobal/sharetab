import type { PrismaClient } from "@/generated/prisma/client";
import type { Prisma } from "@/generated/prisma/client";
import type { AIProvider } from "../ai/provider";
import { getAIProvidersWithFallback, clearProviderCache } from "../ai/registry";
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
  const { resolveUploadPath } = await import("./upload-dir");
  const filepath = resolveUploadPath(receipt.imagePath);
  const imageBuffer = await readFile(filepath);

  logger.info(`${logPrefix}.processing`, {
    receiptId,
    imageSize: imageBuffer.length,
    correctionHint: correctionHint ?? null,
  });

  const start = Date.now();
  let provider: AIProvider | null = null;
  let result: Awaited<ReturnType<AIProvider["extractReceipt"]>> | null = null;
  let lastError: unknown;

  for (let pass = 0; pass < 2 && !result; pass++) {
    const providers = await getAIProvidersWithFallback();

    for (const candidate of providers) {
      try {
        result = await candidate.extractReceipt(
          imageBuffer,
          receipt.mimeType,
          correctionHint
        );
        provider = candidate;
        break;
      } catch (err) {
        lastError = err;
        logger.warn(`${logPrefix}.extractFailed`, {
          receiptId,
          provider: candidate.name,
          error: err instanceof Error ? err.message : String(err),
          pass,
        });
      }
    }

    if (!result && pass === 0) {
      // Cache can become stale after auth expiration; refresh once and retry all providers.
      clearProviderCache();
    }
  }

  if (!result || !provider) {
    throw new Error(
      `Receipt extraction failed across configured providers: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`
    );
  }
  const extraction = result;
  const usedProvider = provider;

  logger.info(`${logPrefix}.extracted`, {
    receiptId,
    provider: usedProvider.name,
    items: extraction.items.length,
    total: extraction.total,
    durationMs: Date.now() - start,
  });

  const normalizedDate = normalizeDate(extraction.date);

  // Replace items and finalize the receipt atomically — a crash or a
  // concurrent reprocess must never leave a COMPLETED receipt with missing
  // or duplicated items.
  await db.$transaction(async (tx) => {
    await tx.receiptItem.deleteMany({ where: { receiptId } });

    await tx.receiptItem.createMany({
      data: extraction.items.map((item, i) => ({
        receiptId,
        name: item.name,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        totalPrice: item.totalPrice,
        sortOrder: i,
      })),
    });

    await tx.receipt.update({
      where: { id: receiptId },
      data: {
        status: "COMPLETED",
        aiProvider: usedProvider.name,
        rawResponse: extraction as unknown as Prisma.InputJsonValue,
        extractedData: {
          merchantName: extraction.merchantName,
          date: normalizedDate,
          subtotal: extraction.subtotal,
          tax: extraction.tax,
          tip: extraction.tip,
          total: extraction.total,
          currency: extraction.currency,
        } as unknown as Prisma.InputJsonValue,
      },
    });
  });

  return {
    status: "COMPLETED" as const,
    merchantName: extraction.merchantName,
    date: normalizedDate,
    subtotal: extraction.subtotal,
    tax: extraction.tax,
    tip: extraction.tip,
    total: extraction.total,
    currency: extraction.currency,
    itemCount: extraction.items.length,
  };
}
