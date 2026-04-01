import Anthropic from "@anthropic-ai/sdk";
import type { AIProvider } from "../provider";
import type { ReceiptExtractionResult } from "../schema";
import { receiptExtractionSchema } from "../schema";
import { RECEIPT_EXTRACTION_PROMPT } from "../prompts/receipt-extraction";

type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export class ClaudeProvider implements AIProvider {
  readonly name = "claude";
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 0 });
  }

  async extractReceipt(
    imageBuffer: Buffer,
    mimeType: string,
    correctionHint?: string
  ): Promise<ReceiptExtractionResult> {
    const base64 = imageBuffer.toString("base64");
    const prompt = correctionHint
      ? `${RECEIPT_EXTRACTION_PROMPT}\n\nThe user has provided a correction. Apply it to improve accuracy:\n<user_correction>${correctionHint}</user_correction>`
      : RECEIPT_EXTRACTION_PROMPT;

    const stream = this.client.messages.stream({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
      max_tokens: 4000,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mimeType as ImageMediaType,
                data: base64,
              },
            },
            {
              type: "text",
              text: prompt,
            },
          ],
        },
      ],
    });

    const response = await stream.finalMessage();

    const textBlock = response.content?.find((c: { type: string }) => c.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("Claude returned no text response");
    }

    const cleaned = textBlock.text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
    const raw = JSON.parse(cleaned);
    return receiptExtractionSchema.parse(raw);
  }

  async isAvailable(): Promise<boolean> {
    try {
      return !!this.client;
    } catch {
      return false;
    }
  }
}
