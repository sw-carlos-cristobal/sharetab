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
    this.client = new Anthropic({ apiKey });
  }

  async extractReceipt(
    imageBuffer: Buffer,
    mimeType: string
  ): Promise<ReceiptExtractionResult> {
    const base64 = imageBuffer.toString("base64");

    const response = await this.client.messages.create({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
      max_tokens: 4000,
      stream: false,
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
              text: RECEIPT_EXTRACTION_PROMPT,
            },
          ],
        },
      ],
    });

    const textBlock = response.content?.find((c: { type: string }) => c.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("Claude returned no text response");
    }

    const raw = JSON.parse(textBlock.text);
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
