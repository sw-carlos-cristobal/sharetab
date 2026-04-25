import type { AIProvider } from "../provider";
import type { ReceiptExtractionResult } from "../schema";
import { receiptExtractionSchema } from "../schema";
import { logger } from "@/server/lib/logger";

/**
 * OCR-based receipt parser using Tesseract.js.
 * Works without any API keys or external services.
 * Less accurate than AI providers but a useful free fallback.
 *
 * Tesseract runs in a child process to avoid WASM/Worker conflicts
 * with Next.js bundlers (Turbopack/webpack).
 */
export class OcrProvider implements AIProvider {
  readonly name = "ocr";

  async extractReceipt(
    imageBuffer: Buffer,
    _mimeType: string,
  ): Promise<ReceiptExtractionResult> {
    const workerResult = await runOcrWorker(imageBuffer);

    if (!workerResult.text.trim()) {
      throw new Error("OCR could not extract any text from the image");
    }

    return parseReceiptText(workerResult.text, workerResult.confidence);
  }

  async isAvailable(): Promise<boolean> {
    return true; // No external dependencies
  }
}

// ── Tesseract child process runner ──────────────────────────────────

interface OcrWorkerResult {
  text: string;
  confidence: number;
}

async function runOcrWorker(imageBuffer: Buffer): Promise<OcrWorkerResult> {
  // Use eval("require") to completely bypass Turbopack/webpack module tracing.
  // These are Node.js built-ins used at runtime only — they should not be bundled.
  // eslint-disable-next-line no-eval
  const _require = eval("require") as NodeRequire;
  const { execFile } = _require("child_process") as typeof import("child_process");
  const { join } = _require("path") as typeof import("path");

  // Build worker path dynamically to prevent bundler from tracing it
  const workerFile = ["src", "server", "ai", "providers", "ocr-worker.mjs"].join("/");
  const workerPath = join(process.cwd(), workerFile);
  const base64 = imageBuffer.toString("base64");

  return new Promise<OcrWorkerResult>((res, rej) => {
    const child = execFile("node", [workerPath], { timeout: 60000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        if (stderr) logger.error("ocr.worker.stderr", { stderr: stderr.substring(0, 500) });
        return rej(new Error("OCR processing failed"));
      }
      if (!stdout.trim()) return rej(new Error("OCR could not extract any text from the image"));

      // Parse the JSON output from the worker
      try {
        const result = JSON.parse(stdout) as OcrWorkerResult;
        res(result);
      } catch {
        // Fallback: treat as plain text (backwards compatibility)
        res({ text: stdout, confidence: 0.4 });
      }
    });
    child.stdin!.write(base64);
    child.stdin!.end();
  });
}

// ── Receipt text parser ─────────────────────────────────────────────

// Allow trailing stray digits after the 2-decimal price (OCR artifact: "5.253" → captures "5.25")
const LINE_PRICE_RE = /^(.+?)\s+\$?\s*(\d{1,6}[.,]\d{2})\d?\s*-?\s*$/;
const QTY_PREFIX_RE = /^(\d+)\s*[xX@]\s+/;
// OCR often reads "1x" as "Ix" or "lx" — normalize before parsing
const OCR_QTY_RE = /^[Il1]\s*[xX]\s+/;

// Stricter date regex: same separator between parts, day/month 1-2 digits, year 2-4 digits
// Avoids matching SKU numbers like 041-06-0812 (3-digit first group)
const DATE_RE = /\b(\d{1,2})([\/.\-])(\d{1,2})\2(\d{2,4})\b/;

const TAX_KEYWORDS = ["tax", "hst", "gst", "pst", "vat", "txbl", "tva", "mwst", "iva"];
const TIP_KEYWORDS = ["tip", "gratuity"];
const TOTAL_KEYWORDS = [
  "total", "amount due", "balance due", "grand total",
  "total ttc", "gesamtbetrag", "montant",
];
const SUBTOTAL_KEYWORDS = [
  "subtotal", "sub-total", "sub total",
  "sous-total", "sous total", "zwischensumme",
];
const SKIP_KEYWORDS = [
  ...TAX_KEYWORDS, ...TIP_KEYWORDS, ...TOTAL_KEYWORDS, ...SUBTOTAL_KEYWORDS,
  "change", "cash", "credit", "debit", "visa", "mastercard", "amex",
  "card", "payment", "thank", "receipt", "order", "check", "table",
  "server", "guest", "store", "phone", "tel", "fax", "www", "http",
  // Fee keywords
  "delivery fee", "service fee", "processing fee", "convenience fee",
  // Loyalty / reward keywords
  "extrabucks", "earned", "reward", "points earned",
  "savings", "you saved", "save", "discount", "coupon", "promo",
  "loyalty", "rollback", "bogo", "reg price", "cartwheel", "redcard",
  // Misc non-item keywords
  "split", "survey", "receipt id", "barcode", "sku",
];

// Discount-related keywords — lines containing these with a price are skipped
// NOTE: "off" was removed — it false-positives on "coffee", "office", etc.
const DISCOUNT_KEYWORDS = ["save", "discount", "% off", "$ off", "coupon", "promo", "savings", "you saved"];

// Fee, reward, and payment keywords — lines with these are always skipped, even with a price
const FEE_REWARD_KEYWORDS = [
  "delivery fee", "service fee", "processing fee", "convenience fee",
  "extrabucks", "earned", "reward", "points earned",
  "you saved", "savings", "loyalty", "rollback", "bogo",
  "reg price", "cartwheel", "redcard",
  // Payment method lines (often have the total amount repeated)
  "visa", "mastercard", "amex", "discover", "debit", "credit",
  "apple pay", "google pay", "contactless", "cash tend", "change due",
  "amount charged", "amount due",
];

// Address indicator words (used to skip address lines for merchant detection)
const STREET_WORDS = ["st", "ave", "blvd", "rd", "dr", "ln", "ct", "way", "pkwy", "hwy", "street", "avenue", "boulevard", "road", "drive", "lane", "court"];
const PHONE_RE = /(\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4}|tel|phone)/i;

/**
 * Convert a price string to cents. Handles trailing `-` (negative/discount indicator)
 * and comma decimals (European format).
 */
function toCents(str: string): number {
  // Strip trailing dash (discount indicator like "4.40-")
  const cleaned = str.replace(/-$/, "").trim();
  return Math.round(parseFloat(cleaned.replace(",", ".")) * 100);
}

function matchesKeyword(line: string, keywords: string[]): boolean {
  const lower = line.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

function extractPrice(line: string): number | null {
  // Find all price-like patterns and use the last one (rightmost)
  const matches = [...line.matchAll(/\$?\s*(\d{1,6}[.,]\d{2})/g)];
  if (matches.length === 0) return null;
  const cents = toCents(matches[matches.length - 1][1]);
  if (isNaN(cents)) return null;
  return cents;
}

/**
 * Normalize common OCR misreads in the price portion of a line.
 * - `S` at start of price area -> `$` (then stripped normally)
 * - `O` adjacent to digits -> `0`
 * - Spaces inside prices like `12. 99` -> `12.99`
 */
function normalizeOcrArtifacts(text: string): string {
  let result = text;

  // Replace S followed by digits (misread $) -> $
  result = result.replace(/\bS(\d{1,6}[.,]\d{2})/g, "$$$1");

  // Replace O adjacent to digits ONLY in price context (near decimal point)
  // e.g. "1O.99" -> "10.99", "O.99" -> "0.99", but NOT "ORE-IDA 5oz"
  result = result.replace(/(\d)O([.,]\d{2})/g, "$10$2");  // 1O.99 → 10.99
  result = result.replace(/O([.,]\d{2})\b/g, "0$1");       // O.99 → 0.99

  // Remove spaces inside price patterns: "12. 99" -> "12.99"
  result = result.replace(/(\d+)\.\s+(\d{2})/g, "$1.$2");
  result = result.replace(/(\d+),\s+(\d{2})/g, "$1,$2");

  // Colon misread as decimal separator: "3:79" -> "3.79" (only in price context at end of line)
  result = result.replace(/(\d+):(\d{2})\s*$/gm, "$1.$2");

  // Dash as decimal separator: "7-99" -> "7.99" (only for single-digit before dash, 2-digit after)
  result = result.replace(/\b(\d{1,2})-(\d{2})\b/g, (match, a, b) => {
    // Only convert if it looks like a price (not a date or SKU)
    if (parseInt(a) <= 99 && parseInt(b) <= 99) return `${a}.${b}`;
    return match;
  });

  return result;
}

/**
 * Check if a line looks like an address.
 */
function isAddressLine(line: string): boolean {
  const lower = line.toLowerCase();
  // Must contain a number and a street-type word
  if (!/\d/.test(line)) return false;
  return STREET_WORDS.some((w) => {
    const re = new RegExp(`\\b${w}\\b`, "i");
    return re.test(lower);
  });
}

/**
 * Check if a line looks like a phone number line.
 */
function isPhoneLine(line: string): boolean {
  return PHONE_RE.test(line);
}

/**
 * Check if a line is a discount/negative line that should be skipped.
 */
function isDiscountLine(line: string): boolean {
  // Lines ending with `-` (e.g. "SAVE 2.00-")
  if (/\d[.,]\d{2}\s*-\s*$/.test(line)) return true;
  // Lines containing discount keywords with a price
  const hasPrice = /\d{1,6}[.,]\d{2}/.test(line);
  if (hasPrice && matchesKeyword(line, DISCOUNT_KEYWORDS)) return true;
  return false;
}

/**
 * Check if a line is a modifier/continuation line (indented, no price).
 * e.g. "  NO CROUTONS" or "  2% MILK"
 */
function isModifierLine(originalLine: string): boolean {
  // Must start with 2+ spaces (indented) and have no price
  if (!/^\s{2,}/.test(originalLine)) return false;
  if (/\d{1,6}[.,]\d{2}/.test(originalLine)) return false;
  return true;
}

/**
 * Check if an indented line is an add-on with a price starting with +.
 * e.g. "  + Extra cheese  1.50"
 */
function isAddOnLine(originalLine: string): boolean {
  if (!/^\s{2,}/.test(originalLine)) return false;
  const trimmed = originalLine.trim();
  return /^\+/.test(trimmed) && /\d{1,6}[.,]\d{2}/.test(trimmed);
}

// ── Main parser (exported for unit testing) ─────────────────────────

export function parseReceiptText(text: string, ocrConfidence?: number): ReceiptExtractionResult {
  // Normalize OCR artifacts before parsing
  const normalizedText = normalizeOcrArtifacts(text);

  // Keep original lines (with leading whitespace) for modifier detection
  const originalLines = normalizedText.split("\n");
  const lines = originalLines.map((l) => l.trim()).filter((l) => l.length > 0);

  const items: { name: string; quantity: number; unitPrice: number; totalPrice: number }[] = [];
  let subtotal = 0;
  let tax = 0;
  let tip = 0;
  let total = 0;
  let merchantName: string | undefined;
  let date: string | undefined;

  // ── Merchant name: first qualifying non-price line ──
  // Skip lines that are addresses, phone numbers, very short, or contain prices
  for (const line of lines) {
    if (/\d{1,6}[.,]\d{2}/.test(line)) continue; // has a price
    if (line.length < 3) continue; // too short
    if (isAddressLine(line)) continue;
    if (isPhoneLine(line)) continue;
    if (/^[-=*_#]+$/.test(line)) continue; // separator line
    // Looks like a good merchant name candidate
    const cleaned = line.replace(/[^a-zA-Z0-9\s&'.\-]/g, "").trim();
    if (cleaned.length >= 2) {
      merchantName = cleaned;
      break;
    }
  }

  // ── Scan for date ──
  for (const line of lines) {
    const dateMatch = line.match(DATE_RE);
    if (dateMatch) {
      date = dateMatch[0];
      break;
    }
  }

  // ── Parse each line ──
  for (let i = 0; i < originalLines.length; i++) {
    const originalLine = originalLines[i];
    const line = originalLine.trim();
    if (line.length === 0) continue;

    // Skip modifier/continuation lines (indented, no price)
    if (isModifierLine(originalLine)) continue;

    // Skip discount/negative lines
    if (isDiscountLine(line)) continue;

    // Skip non-item lines that match skip keywords (no price → always skip)
    if (matchesKeyword(line, SKIP_KEYWORDS) && !LINE_PRICE_RE.test(line)) {
      continue;
    }
    // Skip fee/reward/loyalty lines even if they have a price
    if (matchesKeyword(line, FEE_REWARD_KEYWORDS)) {
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

    // Handle add-on lines (indented + prefix with a price)
    if (isAddOnLine(originalLine)) {
      const addOnLine = line.replace(/^\+\s*/, "");
      const itemMatch = addOnLine.match(LINE_PRICE_RE);
      if (itemMatch) {
        let itemName = itemMatch[1].trim();
        const totalPrice = toCents(itemMatch[2]);
        if (!isNaN(totalPrice) && totalPrice > 0) {
          itemName = itemName.replace(/[^\w\s&'.\-\/()]/g, "").trim();
          if (itemName.length >= 1) {
            items.push({ name: itemName, quantity: 1, unitPrice: totalPrice, totalPrice });
          }
        }
      }
      continue;
    }

    // Try to parse as a line item: "Item name   $12.99"
    const itemMatch = line.match(LINE_PRICE_RE);
    if (itemMatch) {
      let itemName = itemMatch[1].trim();
      const totalPrice = toCents(itemMatch[2]);

      // Skip if NaN
      if (isNaN(totalPrice)) continue;

      // Skip if it looks like a non-item line
      const lower = line.toLowerCase();
      if (lower.includes("change") || lower.includes("payment")) continue;
      if (totalPrice <= 0) continue;

      // Normalize OCR artifacts: "Ix" or "lx" -> "1x"
      itemName = itemName.replace(OCR_QTY_RE, "1x ");

      // Check for quantity prefix: "2x Coffee" or "3 House Red Wine"
      let quantity = 1;
      const qtyMatch = itemName.match(QTY_PREFIX_RE);
      if (qtyMatch) {
        quantity = parseInt(qtyMatch[1], 10);
        itemName = itemName.replace(QTY_PREFIX_RE, "").trim();
      } else {
        // Try plain number prefix: "2 Spring Rolls"
        const plainQty = itemName.match(/^(\d+)\s+([A-Z])/);
        if (plainQty) {
          quantity = parseInt(plainQty[1], 10);
          itemName = itemName.slice(plainQty[1].length).trim();
        }
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
      if (isDiscountLine(line)) continue;
      const price = extractPrice(line);
      if (price && price > 0 && !isNaN(price) && !matchesKeyword(line, SKIP_KEYWORDS)) {
        const name = line.replace(/\$?\s*\d{1,6}[.,]\d{2}\s*-?\s*$/, "").replace(/[^\w\s&'.\-\/()]/g, "").trim();
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

  // Use actual OCR confidence if available, otherwise default
  const confidence = ocrConfidence != null && ocrConfidence > 0 ? ocrConfidence : 0.4;

  return receiptExtractionSchema.parse({
    merchantName,
    date,
    items,
    subtotal,
    tax,
    tip,
    total,
    currency: "USD",
    confidence,
  });
}
