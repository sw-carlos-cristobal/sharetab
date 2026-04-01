import type { ReceiptExtractionResult } from "./schema";

export interface AIProvider {
  readonly name: string;

  /**
   * Extract structured data from a receipt image.
   * @param imageBuffer - Raw image bytes
   * @param mimeType - e.g., "image/jpeg", "image/png"
   * @returns Structured receipt data
   */
  extractReceipt(
    imageBuffer: Buffer,
    mimeType: string,
    correctionHint?: string
  ): Promise<ReceiptExtractionResult>;

  /**
   * Check if this provider is configured and available.
   */
  isAvailable(): Promise<boolean>;
}
