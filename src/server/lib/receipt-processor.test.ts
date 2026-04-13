import { beforeEach, describe, expect, test, vi } from "vitest";

const mockGetAIProvidersWithFallback = vi.fn();
const mockClearProviderCache = vi.fn();

vi.mock("../ai/registry", () => ({
  getAIProvidersWithFallback: mockGetAIProvidersWithFallback,
  clearProviderCache: mockClearProviderCache,
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("./normalize-date", () => ({
  normalizeDate: (value: string | undefined) => value,
}));

vi.mock("./upload-dir", () => ({
  getUploadDir: () => "/tmp/uploads",
}));

vi.mock("fs/promises", () => ({
  readFile: vi.fn().mockResolvedValue(Buffer.from("fake-image")),
}));

describe("processReceiptImage fallback behavior", () => {
  beforeEach(() => {
    vi.resetModules();
    mockGetAIProvidersWithFallback.mockReset();
    mockClearProviderCache.mockReset();
  });

  function makeDbMock() {
    return {
      receiptItem: {
        deleteMany: vi.fn().mockResolvedValue(undefined),
        createMany: vi.fn().mockResolvedValue(undefined),
      },
      receipt: {
        update: vi.fn().mockResolvedValue(undefined),
      },
    };
  }

  const successResult = {
    merchantName: "Store",
    date: "2026-04-13",
    subtotal: 1000,
    tax: 80,
    tip: 0,
    total: 1080,
    currency: "USD",
    items: [
      { name: "Item", quantity: 1, unitPrice: 1080, totalPrice: 1080 },
    ],
  };

  test("falls back to next provider when first extraction fails", async () => {
    const provider1 = {
      name: "openai-codex",
      extractReceipt: vi.fn().mockRejectedValue(new Error("expired")),
    };
    const provider2 = {
      name: "ocr",
      extractReceipt: vi.fn().mockResolvedValue(successResult),
    };
    mockGetAIProvidersWithFallback.mockResolvedValue([provider1, provider2]);

    const { processReceiptImage } = await import("./receipt-processor");
    const db = makeDbMock();

    await processReceiptImage({
      db: db as never,
      receiptId: "r1",
      receipt: { imagePath: "r1.jpg", mimeType: "image/jpeg" },
    });

    expect(provider1.extractReceipt).toHaveBeenCalledTimes(1);
    expect(provider2.extractReceipt).toHaveBeenCalledTimes(1);
    expect(db.receipt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ aiProvider: "ocr" }),
      })
    );
    expect(mockClearProviderCache).not.toHaveBeenCalled();
  });

  test("clears provider cache and retries provider list on first full-pass failure", async () => {
    const badProvider = {
      name: "openai-codex",
      extractReceipt: vi.fn().mockRejectedValue(new Error("auth expired")),
    };
    const recoveredProvider = {
      name: "openai-codex",
      extractReceipt: vi.fn().mockResolvedValue(successResult),
    };

    mockGetAIProvidersWithFallback
      .mockResolvedValueOnce([badProvider])
      .mockResolvedValueOnce([recoveredProvider]);

    const { processReceiptImage } = await import("./receipt-processor");
    const db = makeDbMock();

    await processReceiptImage({
      db: db as never,
      receiptId: "r2",
      receipt: { imagePath: "r2.jpg", mimeType: "image/jpeg" },
    });

    expect(mockGetAIProvidersWithFallback).toHaveBeenCalledTimes(2);
    expect(mockClearProviderCache).toHaveBeenCalledTimes(1);
    expect(recoveredProvider.extractReceipt).toHaveBeenCalledTimes(1);
  });

  test("throws after both fallback passes fail", async () => {
    const badProvider = {
      name: "openai-codex",
      extractReceipt: vi.fn().mockRejectedValue(new Error("still expired")),
    };
    mockGetAIProvidersWithFallback.mockResolvedValue([badProvider]);

    const { processReceiptImage } = await import("./receipt-processor");
    const db = makeDbMock();

    await expect(
      processReceiptImage({
        db: db as never,
        receiptId: "r3",
        receipt: { imagePath: "r3.jpg", mimeType: "image/jpeg" },
      })
    ).rejects.toThrow("Receipt extraction failed across configured providers");

    expect(mockClearProviderCache).toHaveBeenCalledTimes(1);
  });
});
