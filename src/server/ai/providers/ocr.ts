import type { AIProvider } from "../provider";
import type { ReceiptExtractionResult } from "../schema";
import { receiptExtractionSchema } from "../schema";

/**
 * OCR-based receipt parser using Tesseract.js.
 * Works without any API keys or external services.
 * Less accurate than AI providers but a useful free fallback.
 */
export class OcrProvider implements AIProvider {
  readonly name = "ocr";

  async extractReceipt(
    imageBuffer: Buffer,
    _mimeType: string,
  ): Promise<ReceiptExtractionResult> {
    const Tesseract = await import("tesseract.js");
    const { data } = await Tesseract.recognize(imageBuffer, "eng");
    const text = data.text;

    if (!text.trim()) {
      throw new Error("OCR could not extract any text from the image");
    }

    return parseReceiptText(text);
  }

  async isAvailable(): Promise<boolean> {
    return true; // No external dependencies
  }
}

// ── Receipt text parser ─────────────────────────────────────────────

const PRICE_RE = /\$?\s*(\d{1,6}[.,]\d{2})\b/;
const LINE_PRICE_RE = /^(.+?)\s+\$?\s*(\d{1,6}[.,]\d{2})\s*$/;
const QTY_PREFIX_RE = /^(\d+)\s*[xX@]\s*/;
const DATE_RE = /\b(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})\b/;

const TAX_KEYWORDS = ["tax", "hst", "gst", "pst", "vat", "txbl"];
const TIP_KEYWORDS = ["tip", "gratuity"];
const TOTAL_KEYWORDS = ["total", "amount due", "balance due", "grand total"];
const SUBTOTAL_KEYWORDS = ["subtotal", "sub-total", "sub total"];
const SKIP_KEYWORDS = [
  ...TAX_KEYWORDS, ...TIP_KEYWORDS, ...TOTAL_KEYWORDS, ...SUBTOTAL_KEYWORDS,
  "change", "cash", "credit", "debit", "visa", "mastercard", "amex",
  "card", "payment", "thank", "receipt", "order", "check", "table",
  "server", "guest", "store", "phone", "tel", "fax", "www", "http",
];

function toCents(str: string): number {
  return Math.round(parseFloat(str.replace(",", ".")) * 100);
}

function matchesKeyword(line: string, keywords: string[]): boolean {
  const lower = line.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

function extractPrice(line: string): number | null {
  const match = line.match(PRICE_RE);
  return match ? toCents(match[1]) : null;
}

function parseReceiptText(text: string): ReceiptExtractionResult {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const items: { name: string; quantity: number; unitPrice: number; totalPrice: number }[] = [];
  let subtotal = 0;
  let tax = 0;
  let tip = 0;
  let total = 0;
  let merchantName: string | undefined;
  let date: string | undefined;

  // First non-empty line is often the merchant name
  if (lines.length > 0 && !PRICE_RE.test(lines[0])) {
    merchantName = lines[0].replace(/[^a-zA-Z0-9\s&'.\-]/g, "").trim();
    if (merchantName.length < 2) merchantName = undefined;
  }

  // Scan for date
  for (const line of lines) {
    const dateMatch = line.match(DATE_RE);
    if (dateMatch) {
      date = dateMatch[1];
      break;
    }
  }

  // Parse each line
  for (const line of lines) {
    const lower = line.toLowerCase();

    // Skip non-item lines
    if (matchesKeyword(line, SKIP_KEYWORDS) && !LINE_PRICE_RE.test(line)) {
      continue;
    }

    // Extract labeled totals
    if (matchesKeyword(line, SUBTOTAL_KEYWORDS)) {
      const price = extractPrice(line);
      if (price !== null) subtotal = price;
      continue;
    }
    if (matchesKeyword(line, TAX_KEYWORDS)) {
      const price = extractPrice(line);
      if (price !== null) tax = price;
      continue;
    }
    if (matchesKeyword(line, TIP_KEYWORDS)) {
      const price = extractPrice(line);
      if (price !== null) tip = price;
      continue;
    }
    if (matchesKeyword(line, TOTAL_KEYWORDS)) {
      const price = extractPrice(line);
      if (price !== null) total = price;
      continue;
    }

    // Try to parse as a line item: "Item name   $12.99"
    const itemMatch = line.match(LINE_PRICE_RE);
    if (itemMatch) {
      let itemName = itemMatch[1].trim();
      const totalPrice = toCents(itemMatch[2]);

      // Skip if it looks like a non-item line
      if (lower.includes("change") || lower.includes("payment")) continue;
      if (totalPrice <= 0) continue;

      // Check for quantity prefix: "2x Coffee"
      let quantity = 1;
      const qtyMatch = itemName.match(QTY_PREFIX_RE);
      if (qtyMatch) {
        quantity = parseInt(qtyMatch[1], 10);
        itemName = itemName.replace(QTY_PREFIX_RE, "").trim();
      }

      // Clean up the item name
      itemName = itemName.replace(/[^\w\s&'.\-\/()]/g, "").trim();
      if (itemName.length < 1) continue;

      const unitPrice = Math.round(totalPrice / quantity);
      items.push({ name: itemName, quantity, unitPrice, totalPrice });
    }
  }

  // If we couldn't find items, try a more aggressive parse
  if (items.length === 0) {
    for (const line of lines) {
      const price = extractPrice(line);
      if (price && price > 0 && !matchesKeyword(line, SKIP_KEYWORDS)) {
        const name = line.replace(PRICE_RE, "").replace(/[^\w\s&'.\-\/()]/g, "").trim();
        if (name.length >= 2) {
          items.push({ name, quantity: 1, unitPrice: price, totalPrice: price });
        }
      }
    }
  }

  // If still no items, create a single "Receipt total" item
  if (items.length === 0) {
    const fallbackTotal = total || subtotal;
    if (fallbackTotal > 0) {
      items.push({
        name: "Receipt total",
        quantity: 1,
        unitPrice: fallbackTotal,
        totalPrice: fallbackTotal,
      });
    } else {
      throw new Error(
        "OCR could not identify any line items or totals from the receipt. " +
        "Try a clearer photo or use an AI provider for better accuracy."
      );
    }
  }

  // Calculate totals if not found
  const itemsTotal = items.reduce((sum, i) => sum + i.totalPrice, 0);
  if (!subtotal) subtotal = itemsTotal;
  if (!total) total = subtotal + tax + tip;

  return receiptExtractionSchema.parse({
    merchantName,
    date,
    items,
    subtotal,
    tax,
    tip,
    total,
    currency: "USD",
    confidence: 0.4, // OCR is significantly less reliable than AI
  });
}
